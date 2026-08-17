// Package apitest drives the real server over real HTTP against a real
// Postgres, with three dependencies injected: the clock, the mailer, and the
// push service on the far side of a notification.
//
// This is the app's primary test seam. What it asserts on is what somebody
// could observe — a status code, a payload, a row that appears in a feed — so
// a test written against it survives replacing sqlc with hand-written SQL, or
// swapping the in-process hub for LISTEN/NOTIFY, without being edited.
//
// The database is never a mock. The partial unique index, the immutability
// trigger, the citext folding and the time-window aggregates are the parts
// most likely to be wrong, and a mock would assert that they are right by
// assuming it.
package apitest

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/yazdanctx/pomodorus/server/internal/clock"
	"github.com/yazdanctx/pomodorus/server/internal/config"
	"github.com/yazdanctx/pomodorus/server/internal/httpapi"
	"github.com/yazdanctx/pomodorus/server/internal/mail"
	"github.com/yazdanctx/pomodorus/server/internal/push"
	"github.com/yazdanctx/pomodorus/server/internal/store"
)

// Anchored rather than "now": every assertion about a duration is then a
// statement about a fixed instant, and a test that passes today passes in a
// year. Well clear of a Tehran midnight, so a day-bucketing test has to opt
// into the boundary rather than stumble onto it.
var Origin = time.Date(2026, 3, 15, 9, 0, 0, 0, time.UTC)

// OriginDay is the Tehran day the origin falls in, as the wire spells one.
// Written out rather than computed from the code under test, so a test that
// asserts about a day is not agreeing with whatever the bucketing happens to do.
const OriginDay = "2026-03-15"

type Harness struct {
	t      *testing.T
	server *httptest.Server
	stood  deployment

	// The server behind the URL, swappable so that Reboot can replace it
	// without the clients that hold that URL — or their cookies — noticing.
	mu  sync.RWMutex
	api *httpapi.Server

	// The clock the server itself is given, which the harness clock above
	// wraps. Handing the wrapper to the server would work and would also mean
	// the server could ring bells by asking what time it is.
	fixed *clock.Fixed

	// Clock is the server's only source of time. Advance it to reach expiry,
	// the bell, the end of a break — instantly, and without a sleep anywhere.
	Clock *Clock
	// Mail holds every message the server sent, so a test can read the code
	// the user would have read.
	Mail *mail.Memory
	// Push holds every notification the server handed to a push service, so a
	// test can assert that a device was told without one existing.
	Push *push.Memory
	// Bells are the pending notifications, waiting on the harness clock. They
	// are rung by moving that clock rather than by time passing, and survive
	// nothing but the process — Reboot drops them, exactly as a restart does.
	Bells *push.Manual
	DB    *pgxpool.Pool

	// The default client, with its own cookie jar — one browser.
	*Client
}

// Clock is the harness clock: the server's fixed clock, plus the one thing a
// fixed clock cannot do for itself.
//
// Moving it also rings any bell it has passed. The two are one gesture because
// they are one fact — real time would have fired that notification — and
// because two ways of moving time would mean a test that advanced past a bell
// and quietly got no push. Everything else about the timer needs no such help:
// session state is derived, so moving the clock is the whole of it.
type Clock struct {
	*clock.Fixed
	ring func()
}

func (c *Clock) Advance(d time.Duration) {
	c.Fixed.Advance(d)
	c.ring()
}

func (c *Clock) Set(at time.Time) {
	c.Fixed.Set(at)
	c.ring()
}

// deployment is how the server under test is stood up — the facts about its
// surroundings rather than about what it does.
type deployment struct {
	cfg       config.Config
	overTLS   bool
	pingEvery time.Duration
	client    fs.FS
}

// An Option changes how the server under test is deployed, not what it does.
type Option func(*deployment)

// BehindProxy stands the server behind a proxy that sets the forwarded
// headers, and says those headers may be believed.
func BehindProxy() Option {
	return func(d *deployment) { d.cfg.TrustProxyHeaders = true }
}

// OverTLS serves HTTPS, which is how production is reached.
func OverTLS() Option {
	return func(d *deployment) { d.overTLS = true }
}

// Keepalive turns the socket's ping interval down, so a test can watch a
// socket sit idle across several of them in a few milliseconds.
//
// Real time rather than the harness clock, deliberately: the keepalive is
// about the proxy in front of the server dropping quiet connections, and that
// proxy cannot be made to believe the test's clock.
func Keepalive(every time.Duration) Option {
	return func(d *deployment) { d.pingEvery = every }
}

// WithVAPID gives the deployment a keypair, which is what a production one
// always has. The push tests do not need it — they inject a sender that
// records rather than encrypts — so it exists for the one question that is
// about the deployment rather than about a bell: what a browser is handed when
// it asks for the key to subscribe against.
func WithVAPID(publicKey string) Option {
	return func(d *deployment) {
		d.cfg.VAPID = config.VAPIDConfig{
			Subject:    "mailto:someone@example.com",
			PublicKey:  publicKey,
			PrivateKey: "private",
		}
	}
}

// WithClient builds a client into the server under test, which the binary
// normally has and a test binary never does — `go test` embeds no dist.
//
// The shell is the test's own so that the assertion is about what this server
// does to a page rather than about whatever the last `npm run build` left
// behind: what is asserted on is still HTML that came out of the real handler
// over real HTTP.
func WithClient(shell string) Option {
	return func(d *deployment) {
		d.client = fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte(shell)}}
	}
}

// New starts a server on a freshly emptied schema.
func New(t *testing.T, options ...Option) *Harness {
	t.Helper()

	pool := connect(t)
	truncate(t, pool)

	fixed := clock.NewFixed(Origin)
	inbox := mail.NewMemory()

	stood := deployment{cfg: config.Config{Env: "development", Addr: ":0"}}
	for _, option := range options {
		option(&stood)
	}

	h := &Harness{
		t: t, stood: stood, fixed: fixed,
		Mail: inbox, Push: push.NewMemory(), DB: pool,
	}
	// The bells are replaced on every boot, so what the clock rings is looked
	// up rather than captured.
	h.Clock = &Clock{Fixed: fixed, ring: func() { h.Bells.Due() }}

	newServer := httptest.NewServer
	if stood.overTLS {
		newServer = httptest.NewTLSServer
	}
	// One long-lived URL in front of a server that can be replaced. What is
	// under test is still the real handler over real HTTP; the indirection
	// exists so that "the process restarted" is expressible without every
	// client in the test having to be rebuilt around a new address.
	h.server = newServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h.mu.RLock()
		api := h.api
		h.mu.RUnlock()
		if api == nil {
			// Halted. A process that is not running answers nothing, and a test
			// that reaches it while it is down should say so rather than get a
			// quietly served page.
			http.Error(w, "the server is halted", http.StatusServiceUnavailable)
			return
		}
		api.ServeHTTP(w, r)
	}))
	t.Cleanup(h.server.Close)

	h.boot()
	h.Client = h.NewClient()
	return h
}

// boot stands up a server on the schema as it is, exactly as the binary does:
// construct, then rebuild the pending notifications from a single query.
//
// The in-memory bells are new every time. That is the whole point of them
// being in memory — a process that restarts has none until it has asked the
// database what is still coming.
func (h *Harness) boot() {
	h.t.Helper()

	h.Bells = push.NewManual(h.fixed)
	api := httpapi.New(httpapi.Deps{
		Config: h.stood.cfg,
		DB:     h.DB,
		// Left at its default unless a test asked otherwise, so the socket
		// under test is the one that ships.
		SocketPing: h.stood.pingEvery,
		Client:     h.stood.client,
		// Discarded rather than routed to the test log: the handlers log
		// server errors, and a test that deliberately provokes one should not
		// look like a failure.
		Log:        slog.New(slog.NewTextHandler(io.Discard, nil)),
		Clock:      h.fixed,
		Mailer:     h.Mail,
		PushSender: h.Push,
		PushDelay:  h.Bells,
	})
	if err := api.Start(context.Background()); err != nil {
		h.t.Fatal(err)
	}

	h.mu.Lock()
	old := h.api
	h.api = api
	h.mu.Unlock()
	if old != nil {
		old.Close()
	}
	h.t.Cleanup(api.Close)
}

// Halt stops the server without starting another: the process is gone, every
// in-memory timer with it, and the database untouched.
//
// It is the first half of a crash, and the only way to express time passing
// with nothing listening — moving the clock rings the bells the running server
// armed, which is exactly what a halted one would not do.
func (h *Harness) Halt() {
	h.t.Helper()
	h.mu.Lock()
	api := h.api
	h.api = nil
	h.mu.Unlock()
	if api != nil {
		api.Close()
	}
}

// Reboot replaces the running server with a fresh one on the same database,
// which is what a deploy or a crash does.
//
// Everything in memory goes: the pending notifications, the socket hub, the
// rate limiters. Nothing in the database moves. A test that reboots mid-session
// is asking the one question this app's architecture exists to answer — whether
// the timer is still the timer afterwards.
func (h *Harness) Reboot() {
	h.t.Helper()
	h.boot()
}

// URL is where the server under test is reachable, which is the origin a link
// to it carries.
func (h *Harness) URL() string { return h.server.URL }

// Certificate is the httptest server's own, which a client has to trust to
// reach it over TLS.
func (h *Harness) transport() http.RoundTripper {
	if h.server.TLS == nil {
		return nil
	}
	return h.server.Client().Transport
}

// NewClient opens a second browser: its own cookie jar, the same server. This
// is how "two devices" is expressed — there is nothing else to fake, because
// the server owns the timer.
func (h *Harness) NewClient() *Client {
	h.t.Helper()
	jar, err := cookiejar.New(nil)
	if err != nil {
		h.t.Fatal(err)
	}
	return &Client{
		t:       h.t,
		base:    h.server.URL,
		http:    &http.Client{Jar: jar, Transport: h.transport()},
		headers: http.Header{},
	}
}

// SignIn takes an address all the way through the login flow and returns the
// signed-in client. Most tests are about something else and want to be past
// this in one line.
func (h *Harness) SignIn(address string) *Client {
	h.t.Helper()
	client := h.NewClient()
	client.SignIn(h, address)
	return client
}

type Client struct {
	t       *testing.T
	base    string
	http    *http.Client
	headers http.Header
}

// From makes every later request appear to come from an address, the way a
// proxy would report it. Whether that is believed is the server's business.
func (c *Client) From(ip string) *Client {
	c.headers.Set("X-Forwarded-For", ip)
	return c
}

// SignIn requests a code, reads it out of the inbox, and verifies it.
func (c *Client) SignIn(h *Harness, address string) {
	c.t.Helper()
	c.POST("/api/auth/request-code", map[string]string{"email": address}).ExpectStatus(http.StatusOK)
	c.POST("/api/auth/verify", map[string]any{
		"email": address,
		"code":  h.LastCode(address),
	}).ExpectStatus(http.StatusOK)
}

// LastCode reads the six digits out of the most recent message to an address.
func (h *Harness) LastCode(address string) string {
	h.t.Helper()
	sent := h.Mail.Sent()
	for i := len(sent) - 1; i >= 0; i-- {
		if !strings.EqualFold(sent[i].To, address) {
			continue
		}
		if code := digits(sent[i].Text); code != "" {
			return code
		}
		h.t.Fatalf("message to %s carries no code:\n%s", address, sent[i].Text)
	}
	h.t.Fatalf("no message was sent to %s", address)
	return ""
}

// digits pulls the one run of six digits out of a message body. Reading the
// code the way a person would keeps the test honest about what was actually
// delivered.
func digits(text string) string {
	run := 0
	for i, r := range text {
		if r >= '0' && r <= '9' {
			run++
			if run == 6 {
				return text[i-5 : i+1]
			}
			continue
		}
		run = 0
	}
	return ""
}

// CopyCookiesFrom makes this client hold another's session cookie — which is
// what a stolen cookie is, and the only way to show that signing out withdraws
// one rather than merely forgetting it.
func (c *Client) CopyCookiesFrom(other *Client) {
	c.t.Helper()
	base, err := url.Parse(c.base)
	if err != nil {
		c.t.Fatal(err)
	}
	c.http.Jar.SetCookies(base, other.http.Jar.Cookies(base))
}

func (c *Client) GET(path string) *Response { return c.do(http.MethodGet, path, nil) }
func (c *Client) POST(path string, body any) *Response {
	return c.do(http.MethodPost, path, body)
}

func (c *Client) do(method, path string, body any) *Response {
	c.t.Helper()

	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			c.t.Fatal(err)
		}
		reader = bytes.NewReader(encoded)
	}

	req, err := http.NewRequest(method, c.base+path, reader)
	if err != nil {
		c.t.Fatal(err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for name, values := range c.headers {
		req.Header[name] = values
	}

	res, err := c.http.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	defer res.Body.Close()

	payload, err := io.ReadAll(res.Body)
	if err != nil {
		c.t.Fatal(err)
	}
	return &Response{
		t:       c.t,
		what:    method + " " + path,
		Status:  res.StatusCode,
		Header:  res.Header,
		Body:    payload,
		Cookies: res.Cookies(),
	}
}

type Response struct {
	t      *testing.T
	what   string
	Status int
	// What the response said to the caches between here and the reader — which
	// for a page that answers two readers differently is part of what it means.
	Header  http.Header
	Body    []byte
	Cookies []*http.Cookie
}

// Cookie returns a cookie the response set, so a test can read the attributes
// a browser would enforce.
func (r *Response) Cookie(name string) *http.Cookie {
	r.t.Helper()
	for _, cookie := range r.Cookies {
		if cookie.Name == name {
			return cookie
		}
	}
	r.t.Fatalf("%s: set no %s cookie", r.what, name)
	return nil
}

func (r *Response) ExpectStatus(want int) *Response {
	r.t.Helper()
	if r.Status != want {
		r.t.Fatalf("%s: status %d, want %d — body %s", r.what, r.Status, want, r.Body)
	}
	return r
}

// ExpectError asserts the machine-readable code, never a sentence: the words a
// user reads live in the client's copy.json.
func (r *Response) ExpectError(status int, code string) *Response {
	r.t.Helper()
	r.ExpectStatus(status)
	var body struct {
		Error string `json:"error"`
	}
	r.JSON(&body)
	if body.Error != code {
		r.t.Fatalf("%s: error %q, want %q", r.what, body.Error, code)
	}
	return r
}

func (r *Response) JSON(into any) {
	r.t.Helper()
	if err := json.Unmarshal(r.Body, into); err != nil {
		r.t.Fatalf("%s: body is not JSON: %v — %s", r.what, err, r.Body)
	}
}

// --- the database -----------------------------------------------------------

// A schema of its own, created once per test binary and emptied between tests.
// Per-test schemas would be cleaner still and cost a migration run each; the
// tests in a package do not run in parallel, so emptying is enough.
var (
	schema string
	pool   *pgxpool.Pool
)

// Main creates the throwaway schema, migrates it, runs the package's tests and
// drops it. A test package that uses this harness calls it from TestMain.
func Main(m *testing.M) {
	code, err := run(m)
	if err != nil {
		fmt.Fprintln(os.Stderr, "apitest:", err)
		fmt.Fprintln(os.Stderr, "the integration tests need the docker-compose Postgres — run `make up`")
		os.Exit(1)
	}
	os.Exit(code)
}

func run(m *testing.M) (int, error) {
	ctx := context.Background()

	base := databaseURL()
	admin, err := pgxpool.New(ctx, base)
	if err != nil {
		return 0, err
	}
	defer admin.Close()
	if err := admin.Ping(ctx); err != nil {
		return 0, err
	}

	schema = "test_" + randomHex(8)
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		return 0, err
	}
	defer func() {
		_, _ = admin.Exec(context.Background(), "DROP SCHEMA "+schema+" CASCADE")
	}()

	// public stays on the path so the citext extension, which is installed
	// database-wide, resolves; the throwaway schema comes first, so every
	// table the migrations create lands in it.
	scoped := withSearchPath(base, schema+",public")
	if err := store.MigrateSchema(ctx, scoped, schema); err != nil {
		return 0, err
	}
	if pool, err = pgxpool.New(ctx, scoped); err != nil {
		return 0, err
	}
	defer pool.Close()

	return m.Run(), nil
}

func connect(t *testing.T) *pgxpool.Pool {
	t.Helper()
	if pool == nil {
		t.Fatal("apitest: TestMain must call apitest.Main")
	}
	return pool
}

// truncate empties every table the migrations created, so one test cannot see
// another's rows. RESTART IDENTITY and CASCADE keep it a single statement
// whatever the foreign keys do.
func truncate(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	ctx := context.Background()

	rows, err := pool.Query(ctx, `
		SELECT tablename FROM pg_tables
		WHERE schemaname = $1 AND tablename <> 'goose_db_version'`, schema)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()

	var tables []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			t.Fatal(err)
		}
		tables = append(tables, schema+"."+name)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if len(tables) == 0 {
		return
	}
	if _, err := pool.Exec(ctx,
		"TRUNCATE "+strings.Join(tables, ", ")+" RESTART IDENTITY CASCADE"); err != nil {
		t.Fatal(err)
	}
}

func databaseURL() string {
	if url := os.Getenv("TEST_DATABASE_URL"); url != "" {
		return url
	}
	return "postgres://pomodorus:pomodorus@localhost:5433/pomodorus?sslmode=disable"
}

func withSearchPath(base, path string) string {
	parsed, err := url.Parse(base)
	if err != nil {
		return base
	}
	query := parsed.Query()
	query.Set("search_path", path)
	parsed.RawQuery = query.Encode()
	return parsed.String()
}

func randomHex(n int) string {
	raw := make([]byte, n)
	if _, err := rand.Read(raw); err != nil {
		panic(err)
	}
	return hex.EncodeToString(raw)
}
