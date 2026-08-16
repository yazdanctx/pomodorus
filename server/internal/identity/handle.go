// Package identity owns the Handle: the only public name anybody has here.
//
// Email is the credential and is never displayed. The handle is what appears
// in the feed, on the profile and in the profile URL — and it is claimed once
// and permanent afterwards, because a link somebody has shared is expected to
// keep working forever.
package identity

import (
	"errors"
	"regexp"
	"strings"

	"github.com/yazdanctx/pomodorus/server/internal/profanity"
)

// The shape, restated in the database as a CHECK constraint. Both exist on
// purpose: this one gives a readable answer, that one cannot be bypassed.
const (
	HandleMinLength = 3
	HandleMaxLength = 20
)

var handlePattern = regexp.MustCompile(`^[a-z0-9_]{3,20}$`)

var (
	ErrHandleFormat  = errors.New("identity: handle is not [a-z0-9_]{3,20}")
	ErrHandleProfane = errors.New("identity: handle is profane")
)

// NormalizeHandle folds a typed handle into the one form it is stored in.
//
// Case is folded rather than refused: somebody who types Yazdan means yazdan,
// and the alternative is refusing a handle for a reason nobody would guess.
// Uniqueness is case-insensitive in the column too, so /u/Yazdan and /u/yazdan
// can never be two people.
func NormalizeHandle(handle string) string {
	return strings.ToLower(strings.TrimSpace(handle))
}

// ValidateHandle checks everything that can be decided without the database.
// Uniqueness cannot, and is left to the unique index that owns it.
func ValidateHandle(handle string) error {
	if !handlePattern.MatchString(handle) {
		return ErrHandleFormat
	}
	if profanity.Contains(handle) {
		return ErrHandleProfane
	}
	return nil
}
