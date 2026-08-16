package httpapi

import (
	"errors"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"time"

	"github.com/yazdanctx/pomodorus/server/internal/auth"
	"github.com/yazdanctx/pomodorus/server/internal/store/db"
)

// The session cookie. httpOnly so JavaScript cannot read it, SameSite=Lax so
// it is not sent on cross-site posts, and — the reason it is a cookie at all —
// attached to the WebSocket upgrade by the browser without a token in a query
// string.
const sessionCookie = "pomodorus_session"

type requestCodeRequest struct {
	Email string `json:"email"`
}

type sentResponse struct {
	Sent      bool  `json:"sent"`
	ServerNow int64 `json:"serverNow"`
}

func (s *Server) requestCode(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := timeout(r, 15*time.Second)
	defer cancel()

	var body requestCodeRequest
	if err := readJSON(r, &body); err != nil {
		s.writeError(w, http.StatusBadRequest, "malformed_request")
		return
	}

	err := s.auth.RequestCode(ctx, body.Email, s.clientIP(r))
	switch {
	case err == nil:
	case errors.Is(err, auth.ErrInvalidEmail):
		// Refusing an address that is not an address leaks nothing about who
		// has an account — it is a statement about the string, not the inbox.
		s.writeError(w, http.StatusBadRequest, "invalid_email")
		return
	case errors.Is(err, auth.ErrRateLimited):
		s.writeError(w, http.StatusTooManyRequests, "rate_limited")
		return
	default:
		s.log.Error("request code", "error", err)
		s.writeError(w, http.StatusInternalServerError, "server_error")
		return
	}

	// "We sent it", whether or not the address has an account. Anything else
	// turns this endpoint into a way of finding out who is registered here.
	writeJSON(w, http.StatusOK, sentResponse{Sent: true, ServerNow: s.now().UnixMilli()})
}

type verifyRequest struct {
	Email string `json:"email"`
	Code  string `json:"code"`
}

// meResponse is the whole of what the client needs to know about who it is.
// The email is never in it: it is the credential, and it is never displayed.
type meResponse struct {
	Handle    *string `json:"handle"`
	ServerNow int64   `json:"serverNow"`
}

func (s *Server) verifyCode(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := timeout(r, 10*time.Second)
	defer cancel()

	var body verifyRequest
	if err := readJSON(r, &body); err != nil {
		s.writeError(w, http.StatusBadRequest, "malformed_request")
		return
	}

	token, user, err := s.auth.Verify(ctx, body.Email, body.Code)
	switch {
	case err == nil:
	case errors.Is(err, auth.ErrInvalidEmail):
		s.writeError(w, http.StatusBadRequest, "invalid_email")
		return
	case errors.Is(err, auth.ErrBadCode):
		// One error for wrong, expired, already used and out of attempts:
		// telling them apart tells an attacker which it was.
		s.writeError(w, http.StatusUnauthorized, "bad_code")
		return
	default:
		s.log.Error("verify code", "error", err)
		s.writeError(w, http.StatusInternalServerError, "server_error")
		return
	}

	now := s.now()
	s.setSessionCookie(w, r, token, now.Add(auth.SessionTTL))
	writeJSON(w, http.StatusOK, meResponse{Handle: user.Handle, ServerNow: now.UnixMilli()})
}

func (s *Server) signOut(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := timeout(r, 5*time.Second)
	defer cancel()

	if cookie, err := r.Cookie(sessionCookie); err == nil {
		if err := s.auth.SignOut(ctx, cookie.Value); err != nil {
			s.log.Error("sign out", "error", err)
			s.writeError(w, http.StatusInternalServerError, "server_error")
			return
		}
	}

	// Cleared whether or not there was a row, so a stale cookie stops being
	// sent even if the session it names was already gone.
	s.clearSessionCookie(w, r)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) me(w http.ResponseWriter, r *http.Request) {
	user, ok := s.currentUser(r)
	if !ok {
		s.writeError(w, http.StatusUnauthorized, "not_signed_in")
		return
	}
	writeJSON(w, http.StatusOK, meResponse{Handle: user.Handle, ServerNow: s.now().UnixMilli()})
}

// currentUser resolves the session cookie. It is the only way a handler learns
// who is asking.
func (s *Server) currentUser(r *http.Request) (db.User, bool) {
	cookie, err := r.Cookie(sessionCookie)
	if err != nil {
		return db.User{}, false
	}
	ctx, cancel := timeout(r, 5*time.Second)
	defer cancel()

	user, err := s.auth.User(ctx, cookie.Value)
	if err != nil {
		if !errors.Is(err, auth.ErrNoSession) {
			s.log.Error("resolve session", "error", err)
		}
		return db.User{}, false
	}
	return user, true
}

func (s *Server) setSessionCookie(w http.ResponseWriter, r *http.Request, token string, expires time.Time) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookie,
		Value:    token,
		Path:     "/",
		Expires:  expires,
		MaxAge:   int(auth.SessionTTL.Seconds()),
		HttpOnly: true,
		Secure:   s.isHTTPS(r),
		SameSite: http.SameSiteLaxMode,
	})
}

func (s *Server) clearSessionCookie(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookie,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   s.isHTTPS(r),
		SameSite: http.SameSiteLaxMode,
	})
}

// isHTTPS reads the connection, not the environment. The Secure flag is
// security-relevant and so may not be decided by ENV; in production the app
// sits behind a TLS-terminating proxy, which is what the forwarded header is
// for — and it is only believed when there is a proxy configured to set it.
func (s *Server) isHTTPS(r *http.Request) bool {
	if r.TLS != nil {
		return true
	}
	if !s.cfg.TrustProxyHeaders {
		return false
	}
	return strings.EqualFold(firstHeaderValue(r, "X-Forwarded-Proto"), "https")
}

// clientIP is used for one thing: the per-host rate limit. It is never
// identity and is never shown.
//
// The forwarded header is believed only behind a proxy configured to set it.
// Anyone can send that header, so trusting it unconditionally would mean a
// caller who varies it per request looks like a fresh host every time — which
// is the per-host limit not existing at all.
func (s *Server) clientIP(r *http.Request) netip.Addr {
	if s.cfg.TrustProxyHeaders {
		if forwarded := firstHeaderValue(r, "X-Forwarded-For"); forwarded != "" {
			if addr, err := netip.ParseAddr(forwarded); err == nil {
				return addr.Unmap()
			}
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	addr, err := netip.ParseAddr(host)
	if err != nil {
		// An unparseable peer address is not a reason to refuse a login; the
		// per-address limit still applies.
		return netip.Addr{}
	}
	return addr.Unmap()
}

func firstHeaderValue(r *http.Request, name string) string {
	value := r.Header.Get(name)
	first, _, _ := strings.Cut(value, ",")
	return strings.TrimSpace(first)
}
