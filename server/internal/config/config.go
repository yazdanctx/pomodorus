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
}

func Load() (Config, error) {
	c := Config{
		Env: env("ENV", "development"),
		// 8081 and 5433 rather than the obvious 8080 and 5432: this machine
		// already runs a native Postgres on 5432 and something else on 8080,
		// and a default that collides is a default that wastes an afternoon.
		Addr:         env("ADDR", ":8081"),
		DatabaseURL:  env("DATABASE_URL", "postgres://pomodorus:pomodorus@localhost:5433/pomodorus?sslmode=disable"),
		FastSessions: env("FAST_SESSIONS", "") == "1",
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
	return c, nil
}

func (c Config) IsDev() bool { return c.Env == "development" }

func env(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}
