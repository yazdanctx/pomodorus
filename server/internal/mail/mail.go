// Package mail sends the one kind of message this app sends: a login code.
//
// Locally that goes to Mailpit over the same SMTP client that runs in
// production, rather than through a development-only branch — so what is
// exercised in a test is the code path that ships. The in-memory
// implementation exists for the API tests, where reading the code out of a
// slice is what makes the whole login flow legible in one function.
package mail

import (
	"context"
	"fmt"
	"mime"
	"net"
	netmail "net/mail"
	"net/smtp"
	"strings"
	"sync"
)

type Message struct {
	To      string
	Subject string
	Text    string
}

type Mailer interface {
	Send(ctx context.Context, msg Message) error
}

// SMTPConfig is what a provider gives you. Username and password are empty
// against Mailpit, which accepts unauthenticated mail.
type SMTPConfig struct {
	Host     string
	Port     string
	Username string
	Password string
	From     string
}

func NewSMTP(cfg SMTPConfig) *SMTP { return &SMTP{cfg: cfg} }

type SMTP struct{ cfg SMTPConfig }

func (s *SMTP) Send(_ context.Context, msg Message) error {
	addr := net.JoinHostPort(s.cfg.Host, s.cfg.Port)

	// nil auth rather than an empty PlainAuth: net/smtp refuses to send
	// credentials over an unencrypted connection, which is exactly the local
	// case, and an empty username is not a credential worth sending anyway.
	var auth smtp.Auth
	if s.cfg.Username != "" {
		auth = smtp.PlainAuth("", s.cfg.Username, s.cfg.Password, s.cfg.Host)
	}

	if err := smtp.SendMail(addr, auth, envelopeAddress(s.cfg.From), []string{msg.To}, s.compose(msg)); err != nil {
		return fmt.Errorf("send to %s: %w", msg.To, err)
	}
	return nil
}

// envelopeAddress strips the display name. SMTP's MAIL FROM takes a bare
// address and refuses «Pomodorus <no-reply@…>» outright; the display name
// belongs in the From header, which is a different thing entirely.
func envelopeAddress(from string) string {
	if parsed, err := netmail.ParseAddress(from); err == nil {
		return parsed.Address
	}
	return from
}

func (s *SMTP) compose(msg Message) []byte {
	var b strings.Builder
	fmt.Fprintf(&b, "From: %s\r\n", s.cfg.From)
	fmt.Fprintf(&b, "To: %s\r\n", msg.To)
	// RFC 2047, because the subject is Persian and a raw UTF-8 header is not
	// something every mail server will carry intact. Encode leaves plain
	// ASCII alone, so this costs nothing when there is nothing to encode.
	fmt.Fprintf(&b, "Subject: %s\r\n", mime.QEncoding.Encode("utf-8", msg.Subject))
	b.WriteString("MIME-Version: 1.0\r\n")
	b.WriteString("Content-Type: text/plain; charset=UTF-8\r\n")
	b.WriteString("Content-Transfer-Encoding: 8bit\r\n")
	b.WriteString("\r\n")
	b.WriteString(msg.Text)
	return []byte(b.String())
}

// Memory keeps every message it is given, so a test can read the code the
// user would have read.
type Memory struct {
	mu   sync.Mutex
	sent []Message
}

func NewMemory() *Memory { return &Memory{} }

func (m *Memory) Send(_ context.Context, msg Message) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.sent = append(m.sent, msg)
	return nil
}

// Sent returns every message so far, oldest first.
func (m *Memory) Sent() []Message {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]Message{}, m.sent...)
}

// Last returns the most recent message, and whether there was one.
func (m *Memory) Last() (Message, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(m.sent) == 0 {
		return Message{}, false
	}
	return m.sent[len(m.sent)-1], true
}
