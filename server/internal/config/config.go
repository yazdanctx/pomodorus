// Package config reads the process environment once, at boot, and fails loudly
// rather than letting a missing value turn into a confusing error later.
package config

import (
	"fmt"
	"os"
	"strings"
)

type Config struct {
	// Env is "development" or "production". It gates exactly one behaviour so
	// far — see FastSessions — and must never gate anything security-relevant.
	Env         string
	Addr        string
	DatabaseURL string

	// FastSessions collapses every session to a few seconds while still
	// recording its full nominal duration, so the whole timer (bell, ring,
	// break, cycle) is testable in a minute instead of two hours.
	//
	// Read from the server environment and never from the client: a request
	// that could ask for a fast session would be a request that could mint
	// unlimited focus time.
	FastSessions bool

	// TrustProxyHeaders says the server is behind a proxy that sets
	// X-Forwarded-For and X-Forwarded-Proto, and that those headers may
	// therefore be believed.
	//
	// Off by default, because a header anyone can set is a header that defeats
	// the per-host rate limit: without a proxy in front, a caller who sends a
	// fresh X-Forwarded-For on every request looks like a fresh host every
	// time. This is a fact about the deployment, not a security toggle — the
	// unsafe direction is the one that needs saying out loud.
	TrustProxyHeaders bool

	// Where login codes are posted. Locally this is Mailpit; in production it
	// is the host's own email service. The same client runs in both, so what
	// is exercised in development is the code path that ships.
	SMTP SMTPConfig

	// How this server names itself to the browsers' push services. Absent in
	// development, where most work has nothing to do with the bell reaching a
	// closed tab, and required in production, where its absence would be a
	// promise the install prompt makes and the app then quietly breaks.
	VAPID VAPIDConfig
}

// SMTPConfig deliberately mirrors mail.SMTPConfig rather than being it: the
// config package reads the environment and should not depend on how anything
// is delivered. The conversion in cmd/server is the seam, and it is one line.
type SMTPConfig struct {
	Host     string
	Port     string
	Username string
	Password string
	From     string
}

// VAPIDConfig is the keypair every push service knows this server by, and the
// address one of them would use to complain. It mirrors push.VAPID for the
// same reason SMTPConfig mirrors mail.SMTPConfig: this package reads the
// environment and should not depend on what the values are for.
//
// The keypair is permanent. Rotating it invalidates every subscription ever
// handed out — silently, since a browser has no way to be told — so it is
// configuration read from the environment and never something minted at boot.
type VAPIDConfig struct {
	Subject    string
	PublicKey  string
	PrivateKey string
}

// Configured says the bell can reach a closed tab. Everything the push path
// touches is written to be a no-op when this is false, so development without
// a keypair is development with one feature missing rather than a broken app.
func (v VAPIDConfig) Configured() bool {
	return v.PublicKey != "" && v.PrivateKey != ""
}

func Load() (Config, error) {
	c := Config{
		Env: env("ENV", "development"),
		// 8081 and 5433 rather than the obvious 8080 and 5432: this machine
		// already runs a native Postgres on 5432 and something else on 8080,
		// and a default that collides is a default that wastes an afternoon.
		Addr:              env("ADDR", ":8081"),
		DatabaseURL:       env("DATABASE_URL", "postgres://pomodorus:pomodorus@localhost:5433/pomodorus?sslmode=disable"),
		FastSessions:      env("FAST_SESSIONS", "") == "1",
		TrustProxyHeaders: env("TRUST_PROXY_HEADERS", "") == "1",
		SMTP: SMTPConfig{
			Host:     env("SMTP_HOST", "localhost"),
			Port:     env("SMTP_PORT", "1025"),
			Username: env("SMTP_USERNAME", ""),
			Password: env("SMTP_PASSWORD", ""),
			From:     env("SMTP_FROM", "Pomodorus <no-reply@pomodorus.local>"),
		},
		VAPID: VAPIDConfig{
			Subject:    env("VAPID_SUBJECT", ""),
			PublicKey:  env("VAPID_PUBLIC_KEY", ""),
			PrivateKey: env("VAPID_PRIVATE_KEY", ""),
		},
	}

	if c.DatabaseURL == "" {
		return c, fmt.Errorf("DATABASE_URL is required")
	}
	if c.Env != "development" && c.Env != "production" {
		return c, fmt.Errorf("ENV must be development or production, got %q", c.Env)
	}
	if c.FastSessions && c.Env == "production" {
		return c, fmt.Errorf("FAST_SESSIONS must never be set in production: it mints focus time out of nothing")
	}
	if err := c.checkVAPID(); err != nil {
		return c, err
	}
	return c, nil
}

// checkVAPID refuses the half-configured cases rather than letting them turn
// into a bell that silently never arrives.
//
// Half a keypair is always a mistake: a subscription minted against a public
// key that nothing can sign for is a device that will never be reached, and
// nothing about it looks wrong until somebody waits out a pomodoro. In
// production the absent case is a mistake too — push is the whole reason the
// app is installable — so it is the one thing here that fails the boot.
func (c Config) checkVAPID() error {
	v := c.VAPID
	if (v.PublicKey == "") != (v.PrivateKey == "") {
		return fmt.Errorf("VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY must be set together: half a keypair mints subscriptions nothing can send to")
	}
	if !v.Configured() {
		if c.Env == "production" {
			return fmt.Errorf("VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are required in production: without them no bell reaches a closed tab. Generate a pair with `make vapid`")
		}
		return nil
	}
	// RFC 8292 wants a way to reach whoever runs the server, and the push
	// services enforce the shape rather than the address.
	if !strings.HasPrefix(v.Subject, "mailto:") && !strings.HasPrefix(v.Subject, "https://") {
		return fmt.Errorf("VAPID_SUBJECT must be a mailto: or https:// URL, got %q", v.Subject)
	}
	return nil
}

func (c Config) IsDev() bool { return c.Env == "development" }

func env(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}
