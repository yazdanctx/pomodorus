// Package auth is the whole of signing in: there are no passwords anywhere in
// this app.
//
// One flow, not two. An address that has never been seen creates an account, a
// known one signs in, and the caller is never asked which it is doing. The
// account is created at the moment a code is *verified* rather than requested,
// which is what stops a mistyped address from quietly becoming a second, empty
// account — a code sent to an address you cannot read is a code nobody can
// enter.
package auth

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"net/mail"
	"net/netip"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/yazdanctx/pomodorus/server/internal/clock"
	mailer "github.com/yazdanctx/pomodorus/server/internal/mail"
	"github.com/yazdanctx/pomodorus/server/internal/store/db"
)

// The policy, in one place so the tests and the copy can both point at it.
const (
	// Six digits is what people can hold in their head between the mail app
	// and the browser. It is a small space, which is why everything below it
	// exists.
	CodeDigits = 6
	// Long enough to walk to another device, short enough that an old email in
	// an inbox stops being a way in.
	CodeTTL = 10 * time.Minute
	// Fumbling the code is ordinary; guessing it is not. At the limit the code
	// is invalidated rather than merely rejected.
	MaxAttempts = 5

	// A personal tool that asks you to sign in every fortnight is a personal
	// tool you stop using. The expiry slides on every use, so this is ninety
	// days of *disuse*, not ninety days total.
	SessionTTL = 90 * 24 * time.Hour

	// Rate limits. Per address, so a slow mail server is not a dead end but a
	// mailbox cannot be flooded; per IP, so one host cannot walk a list of
	// addresses.
	RateWindow       = 15 * time.Minute
	MaxCodesPerEmail = 5
	MaxCodesPerIP    = 20
)

// The errors a caller has to tell apart. Everything about a code that failed —
// wrong, expired, already used, out of attempts, never issued — is one error
// on purpose: distinguishing them tells an attacker which of those it was.
var (
	ErrInvalidEmail = errors.New("auth: not an email address")
	ErrRateLimited  = errors.New("auth: too many codes requested")
	ErrBadCode      = errors.New("auth: code is wrong, expired or already used")
	ErrNoSession    = errors.New("auth: no session")
)

type Service struct {
	q     *db.Queries
	clock clock.Clock
	mail  mailer.Mailer

	// A pepper, so that a database read alone does not hand anybody a pile of
	// live codes: the stored hash is useless without it. Generated at boot and
	// never persisted — an in-flight code stops working across a restart,
	// which costs one resend and buys one less secret to manage.
	secret []byte
}

func NewService(q *db.Queries, c clock.Clock, m mailer.Mailer) *Service {
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		// crypto/rand does not fail on any platform this runs on, and a
		// server that cannot generate a secret must not serve logins.
		panic("auth: no randomness available: " + err.Error())
	}
	return &Service{q: q, clock: c, mail: m, secret: secret}
}

// RequestCode mints a code for the address and mails it.
//
// It says nothing about whether the address has an account, because the
// caller's response is identical either way — that is what stops this endpoint
// being a way to find out who is registered here.
func (s *Service) RequestCode(ctx context.Context, address string, from netip.Addr) error {
	email, err := NormalizeEmail(address)
	if err != nil {
		return err
	}
	now := s.clock.Now()
	since := ts(now.Add(-RateWindow))

	perEmail, err := s.q.CountCodesForEmail(ctx, db.CountCodesForEmailParams{Email: email, CreatedAt: since})
	if err != nil {
		return fmt.Errorf("count codes for address: %w", err)
	}
	if perEmail >= MaxCodesPerEmail {
		return ErrRateLimited
	}

	var ip *netip.Addr
	if from.IsValid() {
		ip = &from
		perIP, err := s.q.CountCodesForIP(ctx, db.CountCodesForIPParams{RequestedIp: ip, CreatedAt: since})
		if err != nil {
			return fmt.Errorf("count codes for ip: %w", err)
		}
		if perIP >= MaxCodesPerIP {
			return ErrRateLimited
		}
	}

	// The previous code dies here rather than at its own expiry: two live
	// codes would mean the older email in the inbox still works.
	if err := s.q.SupersedeCodesForEmail(ctx, db.SupersedeCodesForEmailParams{
		Email: email, ConsumedAt: ts(now),
	}); err != nil {
		return fmt.Errorf("supersede codes: %w", err)
	}

	code, err := newCode()
	if err != nil {
		return err
	}
	if _, err := s.q.CreateLoginCode(ctx, db.CreateLoginCodeParams{
		Email:       email,
		CodeHash:    s.hash(email, code),
		RequestedIp: ip,
		CreatedAt:   ts(now),
		ExpiresAt:   ts(now.Add(CodeTTL)),
	}); err != nil {
		return fmt.Errorf("create code: %w", err)
	}

	return s.mail.Send(ctx, codeMessage(email, code))
}

// Verify checks a code and, if it is good, creates the account if there is not
// one already and opens a session.
//
// The returned token is the only time it exists in plaintext; the caller puts
// it in a cookie and the database keeps a hash.
func (s *Service) Verify(ctx context.Context, address, code string) (string, db.User, error) {
	email, err := NormalizeEmail(address)
	if err != nil {
		return "", db.User{}, err
	}
	now := s.clock.Now()

	live, err := s.q.LiveCodeForEmail(ctx, db.LiveCodeForEmailParams{Email: email, ExpiresAt: ts(now)})
	if errors.Is(err, pgx.ErrNoRows) {
		return "", db.User{}, ErrBadCode
	}
	if err != nil {
		return "", db.User{}, fmt.Errorf("read code: %w", err)
	}

	if !hmac.Equal(live.CodeHash, s.hash(email, strings.TrimSpace(code))) {
		if _, err := s.q.RecordFailedAttempt(ctx, db.RecordFailedAttemptParams{
			ID: live.ID, Attempts: MaxAttempts, ConsumedAt: ts(now),
		}); err != nil {
			return "", db.User{}, fmt.Errorf("record attempt: %w", err)
		}
		return "", db.User{}, ErrBadCode
	}

	// Single use, decided by the database rather than by this function: two
	// requests racing with the same correct code produce exactly one winner.
	used, err := s.q.ConsumeLoginCode(ctx, db.ConsumeLoginCodeParams{ID: live.ID, ConsumedAt: ts(now)})
	if err != nil {
		return "", db.User{}, fmt.Errorf("consume code: %w", err)
	}
	if used == 0 {
		return "", db.User{}, ErrBadCode
	}

	user, err := s.q.UpsertUserByEmail(ctx, db.UpsertUserByEmailParams{Email: email, CreatedAt: ts(now)})
	if err != nil {
		return "", db.User{}, fmt.Errorf("upsert user: %w", err)
	}

	token, err := s.openSession(ctx, user.ID, now)
	if err != nil {
		return "", db.User{}, err
	}
	return token, user, nil
}

// User resolves a session token, sliding its expiry forward as it goes.
func (s *Service) User(ctx context.Context, token string) (db.User, error) {
	if token == "" {
		return db.User{}, ErrNoSession
	}
	now := s.clock.Now()
	hash := tokenHash(token)

	row, err := s.q.UserForSession(ctx, db.UserForSessionParams{TokenHash: hash, ExpiresAt: ts(now)})
	if errors.Is(err, pgx.ErrNoRows) {
		return db.User{}, ErrNoSession
	}
	if err != nil {
		return db.User{}, fmt.Errorf("read session: %w", err)
	}

	// Written on use rather than on a schedule: a session being used never
	// lapses, and one that is not eventually does. Writing on every request
	// would be a write per request, so only move it once it has drifted.
	if row.ExpiresAt.Time.Sub(now) < SessionTTL-time.Hour {
		if err := s.q.TouchAuthSession(ctx, db.TouchAuthSessionParams{
			TokenHash: hash, LastSeenAt: ts(now), ExpiresAt: ts(now.Add(SessionTTL)),
		}); err != nil {
			return db.User{}, fmt.Errorf("touch session: %w", err)
		}
	}
	return row.User, nil
}

// SignOut deletes the row, which is what makes a stolen cookie stop working.
// A self-contained signed token could not be withdrawn like this.
func (s *Service) SignOut(ctx context.Context, token string) error {
	if token == "" {
		return nil
	}
	return s.q.DeleteAuthSession(ctx, tokenHash(token))
}

func (s *Service) openSession(ctx context.Context, user pgtype.UUID, now time.Time) (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("session token: %w", err)
	}
	token := base64.RawURLEncoding.EncodeToString(raw)

	if err := s.q.CreateAuthSession(ctx, db.CreateAuthSessionParams{
		TokenHash: tokenHash(token),
		UserID:    user,
		CreatedAt: ts(now),
		ExpiresAt: ts(now.Add(SessionTTL)),
	}); err != nil {
		return "", fmt.Errorf("create session: %w", err)
	}
	return token, nil
}

// hash binds the code to the address, so a code minted for one inbox cannot be
// presented against another.
func (s *Service) hash(email, code string) []byte {
	mac := hmac.New(sha256.New, s.secret)
	mac.Write([]byte(email))
	mac.Write([]byte{0})
	mac.Write([]byte(code))
	return mac.Sum(nil)
}

// A session token is 32 random bytes, so there is nothing to brute-force and a
// plain digest is enough. Only the digest is stored.
func tokenHash(token string) []byte {
	sum := sha256.Sum256([]byte(token))
	return sum[:]
}

// NormalizeEmail is the one place an address is turned into the form the rest
// of the app uses. Case is folded by citext in the database as well, because
// the column is what cannot be bypassed.
func NormalizeEmail(address string) (string, error) {
	trimmed := strings.TrimSpace(address)
	parsed, err := mail.ParseAddress(trimmed)
	if err != nil {
		return "", ErrInvalidEmail
	}
	// ParseAddress accepts «Name <a@b.c>»; only the address is the identity.
	lowered := strings.ToLower(parsed.Address)
	_, domain, _ := strings.Cut(lowered, "@")
	if !strings.Contains(domain, ".") || strings.HasSuffix(domain, ".") {
		// A domain with no dot is not deliverable off this machine, and
		// accepting one would mean minting a code nobody can read.
		return "", ErrInvalidEmail
	}
	return lowered, nil
}

// newCode returns a uniformly random decimal code.
func newCode() (string, error) {
	digits := make([]byte, CodeDigits)
	for i := range digits {
		n, err := randomDigit()
		if err != nil {
			return "", err
		}
		digits[i] = byte('0' + n)
	}
	return string(digits), nil
}

func randomDigit() (int, error) {
	// Ten does not divide 256, so the top of the byte range is rejected rather
	// than folded — folding would make 0-5 fractionally likelier than 6-9.
	var b [1]byte
	for {
		if _, err := rand.Read(b[:]); err != nil {
			return 0, fmt.Errorf("random digit: %w", err)
		}
		if b[0] < 250 {
			return int(b[0]) % 10, nil
		}
	}
}

func ts(t time.Time) pgtype.Timestamptz {
	return pgtype.Timestamptz{Time: t, Valid: true}
}
