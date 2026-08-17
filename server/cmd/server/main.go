// Command server is the whole backend: the JSON API, the WebSocket hub, and
// the embedded React client, in one binary.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/yazdanctx/pomodorus/server/internal/clock"
	"github.com/yazdanctx/pomodorus/server/internal/config"
	"github.com/yazdanctx/pomodorus/server/internal/httpapi"
	"github.com/yazdanctx/pomodorus/server/internal/mail"
	"github.com/yazdanctx/pomodorus/server/internal/store"
)

func main() {
	log := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))

	if err := run(log); err != nil {
		log.Error("fatal", "error", err)
		os.Exit(1)
	}
}

func run(log *slog.Logger) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}

	// Cancelled on SIGINT/SIGTERM, which is what starts the shutdown below.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	db, err := store.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer db.Close()
	log.Info("database ready, schema up to date")

	api := httpapi.New(httpapi.Deps{
		Config: cfg,
		DB:     db,
		Log:    log,
		Clock:  clock.System(),
		Mailer: mail.NewSMTP(mail.SMTPConfig(cfg.SMTP)),
	})
	// The one thing this process does at boot besides listening: rebuild the
	// pending push notifications from a single query. Nothing was lost with
	// the old process — session state is derived from rows and now(), always —
	// so a failure here costs notifications rather than the timer, and is
	// logged rather than fatal.
	if err := api.Start(ctx); err != nil {
		log.Error("push: could not rebuild pending bells", "error", err)
	}
	defer api.Close()

	srv := &http.Server{
		Addr:    cfg.Addr,
		Handler: api,
		// Generous but finite: a WebSocket upgrade will opt out of the write
		// deadline itself, and nothing else here is long-lived.
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	errs := make(chan error, 1)
	go func() {
		log.Info("listening",
			"addr", cfg.Addr, "env", cfg.Env,
			"fastSessions", cfg.FastSessions, "push", cfg.VAPID.Configured())
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errs <- err
		}
	}()

	select {
	case err := <-errs:
		return err
	case <-ctx.Done():
		log.Info("shutting down")
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	return srv.Shutdown(shutdownCtx)
}
