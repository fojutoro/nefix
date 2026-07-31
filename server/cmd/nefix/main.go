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
)

var (
	version = "dev"
	commit  = "none"
)

// Localhost only: a reverse proxy sits in front.
const defaultAddr = "127.0.0.1:8080"

func main() {
	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))

	addr := os.Getenv("NEFIX_ADDR")
	if addr == "" {
		addr = defaultAddr
	}

	srv := &http.Server{
		Handler:           nefixhttp.New(version, commit),
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
		os.Exit(1)
	case <-ctx.Done():
		stop()
	}

	// Graceful shutdown with 10s timeout to force-close if needed.
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if err := srv.Shutdown(shutdownCtx); err != nil {
		logger.Error("shutdown failed", "error", err)
		os.Exit(1)
	}

	logger.Info("stopped")
}
