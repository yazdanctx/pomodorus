package mail_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/yazdanctx/pomodorus/server/internal/mail"
)

// The SMTP client is the one part of sending that the in-memory mailer cannot
// stand in for, and it is the part that actually broke: SMTP's MAIL FROM takes
// a bare address and refuses «Pomodorus <no-reply@…>» outright, which no
// amount of testing against a fake would have caught.
//
// So this posts a real message to the docker-compose Mailpit over real SMTP
// and reads it back out of Mailpit's own API — the same path that runs in
// production, against the inbox the maintainer reads.

func mailpit(t *testing.T) (smtpHost, smtpPort, api string) {
	t.Helper()

	smtpHost = env("MAILPIT_HOST", "localhost")
	smtpPort = env("MAILPIT_SMTP_PORT", "1025")
	api = env("MAILPIT_API", "http://localhost:8025")

	conn, err := net.DialTimeout("tcp", net.JoinHostPort(smtpHost, smtpPort), 2*time.Second)
	if err != nil {
		t.Skip("Mailpit is not running — `make up` to exercise the real SMTP path")
	}
	_ = conn.Close()
	return smtpHost, smtpPort, api
}

func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func TestSendingThroughSMTPLandsInTheInbox(t *testing.T) {
	host, port, api := mailpit(t)

	// A display name in From is the ordinary case and the one that broke.
	sender := mail.NewSMTP(mail.SMTPConfig{
		Host: host,
		Port: port,
		From: "Pomodorus <no-reply@pomodorus.local>",
	})

	// Unique per run, so a leftover inbox cannot make this pass.
	to := fmt.Sprintf("smtp-test-%d@example.com", time.Now().UnixNano())
	subject := "کد ورودت به Pomodorus"
	body := "کد ورودت اینه:\n\n    424242\n"

	if err := sender.Send(context.Background(), mail.Message{
		To: to, Subject: subject, Text: body,
	}); err != nil {
		t.Fatal(err)
	}

	got := findMessage(t, api, to)
	// The Persian subject has to survive the wire, which is what the RFC 2047
	// encoding is for — a raw UTF-8 header is not something every server
	// carries intact.
	if got.Subject != subject {
		t.Errorf("subject %q, want %q", got.Subject, subject)
	}
	if !strings.Contains(got.Text, "424242") {
		t.Errorf("the code did not survive:\n%s", got.Text)
	}
}

type mailpitMessage struct {
	Subject string
	Text    string
}

func findMessage(t *testing.T, api, to string) mailpitMessage {
	t.Helper()

	var list struct {
		Messages []struct {
			ID string
			To []struct{ Address string }
		}
	}
	getJSON(t, api+"/api/v1/messages?limit=50", &list)

	for _, summary := range list.Messages {
		for _, recipient := range summary.To {
			if !strings.EqualFold(recipient.Address, to) {
				continue
			}
			var full mailpitMessage
			getJSON(t, api+"/api/v1/message/"+summary.ID, &full)
			return full
		}
	}
	t.Fatalf("nothing addressed to %s reached the inbox", to)
	return mailpitMessage{}
}

func getJSON(t *testing.T, url string, into any) {
	t.Helper()
	res, err := http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("GET %s: %s", url, res.Status)
	}
	if err := json.NewDecoder(res.Body).Decode(into); err != nil {
		t.Fatal(err)
	}
}
