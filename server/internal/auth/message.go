package auth

import (
	"fmt"

	mailer "github.com/yazdanctx/pomodorus/server/internal/mail"
)

// The one message this app sends. It lives here rather than in the client's
// copy.json because the client never renders it — the server does, and a
// string the server needs cannot live in a file the server does not ship.
//
// The code is set in ASCII digits deliberately: everything the app *displays*
// is in Persian numerals, but this is a string somebody retypes into a field,
// and the field takes ASCII.
func codeMessage(email, code string) mailer.Message {
	return mailer.Message{
		To:      email,
		Subject: "کد ورودت به Pomodorus",
		Text: fmt.Sprintf(`سلام!

کد ورودت اینه:

    %s

%d دقیقه اعتبار داره و فقط یه بار کار می‌کنه.

اگه تو درخواستش نکردی، بی‌خیالش شو — بدون این کد کسی نمی‌تونه وارد اکانتت شه.

— Pomodorus
`, code, int(CodeTTL.Minutes())),
	}
}
