package httpapi

import (
	"context"
	"net/http"
	"time"
)

// timeout derives a request-scoped context with a deadline, so a slow query
// cannot outlive the client that asked for it.
func timeout(r *http.Request, d time.Duration) (context.Context, context.CancelFunc) {
	return context.WithTimeout(r.Context(), d)
}
