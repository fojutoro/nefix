package main

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	nefixhttp "github.com/fojutoro/nefix/server/internal/http"
	"github.com/fojutoro/nefix/server/internal/store"
)

var (
	version = "dev"
	commit  = "none"
)

// Localhost only: a reverse proxy sits in front.
const defaultAddr = "127.0.0.1:8080"

const defaultDBPath = "nefix.db"

func main() {
	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	// store logs migrations through the default logger.
	slog.SetDefault(logger)

	addr := os.Getenv("NEFIX_ADDR")
	if addr == "" {
		addr = defaultAddr
	}

	dbPath := os.Getenv("NEFIX_DB")
	if dbPath == "" {
		dbPath = defaultDBPath
	}

	// Before the listener binds: a process that is accepting requests must
	// have a schema that matches its code.
	db, err := store.Open(dbPath)
	if err != nil {
		logger.Error("opening database failed", "path", dbPath, "error", err)
		os.Exit(1)
	}

	// Only an explicit "false" disables it; anything else stays secure.
	secureCookies := os.Getenv("NEFIX_SECURE_COOKIES") != "false"
	if !secureCookies {
		logger.Warn("secure cookies disabled, development only", "env", "NEFIX_SECURE_COOKIES=false")
	}

	srv := &http.Server{
		Handler:           nefixhttp.New(version, commit, db, nefixhttp.CookieConfig{Secure: secureCookies}),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      15 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	// Listen for Ctrl+C or termination signals; stop() cleans up listeners.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	ln, err := net.Listen("tcp", addr)
	if err != nil {
		logger.Error("listen failed", "addr", addr, "error", err)
		db.Close()
		os.Exit(1)
	}

	logger.Info("listening", "addr", ln.Addr().String(), "version", version, "commit", commit)

	// Buffered channel so the server goroutine can report errors
	// without blocking, even if main is waiting on the select below.
	serveErr := make(chan error, 1)
	go func() {
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serveErr <- err
		}
	}()

	// Wait for serve error or shutdown signal.
	select {
	case err := <-serveErr:
		logger.Error("serve failed", "error", err)
		db.Close()
		os.Exit(1)
	case <-ctx.Done():
		stop()
	}

	// Graceful shutdown with 10s timeout to force-close if needed.
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if err := srv.Shutdown(shutdownCtx); err != nil {
		logger.Error("shutdown failed", "error", err)
		db.Close()
		os.Exit(1)
	}

	if err := db.Close(); err != nil {
		logger.Error("closing database failed", "error", err)
		os.Exit(1)
	}

	logger.Info("stopped")
}
