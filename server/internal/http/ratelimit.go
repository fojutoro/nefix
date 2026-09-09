package http

import (
	"context"
	"math"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Ten attempts a minute, from a bucket that holds ten. Someone signing in
// mistypes a password two or three times, never ten, so the ceiling sits far
// above real use and far below what makes guessing worthwhile. It matters
// more here than on an ordinary endpoint because every attempt runs argon2,
// which costs about 70ms and allocates 64 MiB: a few dozen at once is a
// memory problem before it is a credential one.
const (
	loginRate  = 10.0 / 60.0
	loginBurst = 10.0

	// Long enough that a bucket outlives the burst it was created for, short
	// enough that the map describes clients that are still here rather than
	// everyone who has ever visited.
	bucketIdle = 10 * time.Minute
	sweepEvery = time.Minute
)

type bucket struct {
	tokens float64
	seen   time.Time
}

type limiter struct {
	mu      sync.Mutex
	buckets map[string]*bucket
	rate    float64
	burst   float64
	idle    time.Duration
}

func newLimiter(rate, burst float64, idle time.Duration) *limiter {
	return &limiter{
		buckets: make(map[string]*bucket),
		rate:    rate,
		burst:   burst,
		idle:    idle,
	}
}

// The clock is a parameter so that a test can move time without sleeping
// through a minute of it.
func (l *limiter) allow(key string, now time.Time) (bool, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()

	b, ok := l.buckets[key]
	if !ok {
		l.buckets[key] = &bucket{tokens: l.burst - 1, seen: now}

		return true, 0
	}

	b.tokens = math.Min(l.burst, b.tokens+now.Sub(b.seen).Seconds()*l.rate)
	b.seen = now

	if b.tokens < 1 {
		// Rounded up: a client told to wait zero seconds retries at once and
		// is refused again, which teaches it nothing.
		wait := time.Duration(math.Ceil((1-b.tokens)/l.rate)) * time.Second

		return false, wait
	}
	b.tokens--

	return true, 0
}

func (l *limiter) sweep(now time.Time) {
	l.mu.Lock()
	defer l.mu.Unlock()

	for key, b := range l.buckets {
		if now.Sub(b.seen) >= l.idle {
			delete(l.buckets, key)
		}
	}
}

// Stops with the context. A server that has shut down must not leave this
// running, and a test must not leave one behind per call.
func (l *limiter) run(ctx context.Context, every time.Duration) {
	ticker := time.NewTicker(every)

	go func() {
		defer ticker.Stop()

		for {
			select {
			case <-ctx.Done():
				return
			case now := <-ticker.C:
				l.sweep(now)
			}
		}
	}()
}

// nginx sets X-Forwarded-For, appending the peer it saw, so the leftmost entry
// is the original client. RemoteAddr is therefore always 127.0.0.1 in
// production and would put every user in one bucket.
//
// The loopback check is the whole of what makes reading it safe. The header is
// supplied by whoever sent the request, so a client that can reach the server
// directly could put a different value in it each time and get a fresh bucket
// per attempt, which is not a limiter at all. Only a request that arrived from
// the proxy on loopback can have had the header written by the proxy.
func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}

	if ip := net.ParseIP(host); ip == nil || !ip.IsLoopback() {
		return host
	}

	forwarded := r.Header.Get("X-Forwarded-For")
	if forwarded == "" {
		return host
	}

	first, _, _ := strings.Cut(forwarded, ",")
	if first = strings.TrimSpace(first); first == "" {
		return host
	}

	return first
}

func (l *limiter) limit(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		allowed, wait := l.allow(clientIP(r), time.Now())
		if !allowed {
			w.Header().Set("Retry-After", strconv.Itoa(int(wait.Seconds())))
			writeError(w, http.StatusTooManyRequests, "too many attempts, please wait")

			return
		}

		next.ServeHTTP(w, r)
	})
}
