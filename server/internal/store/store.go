// Package store owns the database connection and the schema's version.
package store

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"

	"github.com/yazdanctx/pomodorus/server/internal/migrations"
)

// Open connects, verifies the connection, and brings the schema up to date.
//
// Migrations run at boot from an embedded FS rather than as a separate deploy
// step, so there is no window in which a new binary talks to an old schema.
// That skew is what repeatedly broke the previous version of this app in
// production, and a deploy that can't half-apply can't reproduce it.
func Open(ctx context.Context, databaseURL string) (*pgxpool.Pool, error) {
	poolCfg, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, fmt.Errorf("parse DATABASE_URL: %w", err)
	}
	poolCfg.MaxConns = 10
	poolCfg.MaxConnLifetime = time.Hour

	pool, err := pgxpool.NewWithConfig(ctx, poolCfg)
	if err != nil {
		return nil, fmt.Errorf("connect: %w", err)
	}

	pingCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := pool.Ping(pingCtx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping: %w", err)
	}

	if err := Migrate(ctx, databaseURL); err != nil {
		pool.Close()
		return nil, err
	}
	return pool, nil
}

// Migrate brings the schema up to date, using the connection's own search
// path — which in production is the one schema there is.
func Migrate(ctx context.Context, databaseURL string) error {
	return MigrateSchema(ctx, databaseURL, "")
}

// MigrateSchema migrates into a named schema.
//
// The name is needed for one reason: goose keeps its bookkeeping in a
// goose_db_version table, and an unqualified name resolves against the whole
// search path. The test harness migrates a throwaway schema while keeping
// public on the path so the citext extension resolves, and without qualifying
// the version table goose would read public's, conclude the throwaway schema
// was already up to date, and create nothing at all.
//
// It runs over a throwaway database/sql handle because that is the only thing
// goose speaks; everything else in the app uses pgx directly.
func MigrateSchema(ctx context.Context, databaseURL, schema string) error {
	connCfg, err := pgx.ParseConfig(databaseURL)
	if err != nil {
		return fmt.Errorf("parse DATABASE_URL: %w", err)
	}

	db := stdlib.OpenDB(*connCfg)
	defer db.Close()

	goose.SetBaseFS(migrations.FS)
	goose.SetLogger(goose.NopLogger())
	if schema != "" {
		goose.SetTableName(schema + ".goose_db_version")
	}
	if err := goose.SetDialect("postgres"); err != nil {
		return fmt.Errorf("goose dialect: %w", err)
	}
	if err := goose.UpContext(ctx, db, migrations.Dir); err != nil {
		return fmt.Errorf("migrate: %w", err)
	}
	return nil
}
