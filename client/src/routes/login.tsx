import { useState, type FormEvent } from "react";
import { ArrowRight, KeyRound } from "lucide-react";
import { Link, useNavigate } from "react-router";

import { Failure } from "@/components/failure";
import { SubmitButton } from "@/components/submit-button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { messageFor, post, type ServerTimed } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { copy } from "@/lib/copy";
import { enDigits } from "@/lib/format";

/**
 * One flow, two steps: type an address, read the code, you are in.
 *
 * There is no sign-in/sign-up choice to make, because there is nothing to
 * choose between — an unknown address creates the account and a known one
 * signs in, and the screen never learns which happened. It also never learns
 * whether the address was known, because the server's answer is identical
 * either way.
 *
 * v1's login was a username and a password and has no reference screenshot;
 * this is built from the design tokens and v1's own furniture — the field
 * hint, the spinner-and-waiting-label submit, and the link back to the
 * landing.
 */
export function LoginRoute() {
  const [email, setEmail] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);

  return (
    <main className="flex flex-1 flex-col">
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="w-full max-w-xs space-y-8">
          {/* Set like the hero's title — same treatment, its own size. */}
          <h1 className="text-center text-2xl font-light tracking-widest uppercase text-yellow-600">
            {copy.app.name}
          </h1>

          {sentTo === null ? (
            <EmailStep email={email} onEmail={setEmail} onSent={setSentTo} />
          ) : (
            <CodeStep email={sentTo} onStartOver={() => setSentTo(null)} />
          )}

          {/* Without this a signed-out visitor has no way back to the landing
              but the browser's own. */}
          <Link
            to="/"
            className="flex items-center justify-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <ArrowRight className="size-3" />
            {copy.login.backHome}
          </Link>
        </div>
      </div>
    </main>
  );
}

function EmailStep({
  email,
  onEmail,
  onSent,
}: {
  email: string;
  onEmail: (email: string) => void;
  onSent: (email: string) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      await post<ServerTimed & { sent: boolean }>("/api/auth/request-code", {
        email,
      });
      onSent(email);
    } catch (failure) {
      setError(messageFor(failure));
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="email">{copy.login.email}</Label>
        <Input
          id="email"
          name="email"
          type="email"
          value={email}
          onChange={(event) => onEmail(event.target.value)}
          autoFocus
          required
          autoComplete="email"
          dir="ltr"
          // What is typed here is Latin all the way through, digits included.
          className="font-latin"
        />
        <p className="text-xs text-muted-foreground">{copy.login.emailHint}</p>
      </div>

      <Failure message={error} />

      <SubmitButton
        pending={pending}
        label={copy.login.sendCode}
        pendingLabel={copy.login.sending}
      />
    </form>
  );
}

/**
 * «کد رفت …» with the address set apart from the sentence around it.
 *
 * It cannot go through `t`, which returns a string: the address is Latin and
 * needs its own font and direction, and the UI font would otherwise draw the
 * digits in it as Persian numerals — `yazdan2000@…` reading `yazdan۲۰۰۰@…`.
 */
function SentTo({ email }: { email: string }) {
  const [before = "", after = ""] = copy.login.sentBody.split("{email}");
  return (
    <>
      {before}
      <span dir="ltr" className="font-latin">
        {email}
      </span>
      {after}
    </>
  );
}

function CodeStep({
  email,
  onStartOver,
}: {
  email: string;
  onStartOver: () => void;
}) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [resending, setResending] = useState(false);
  const auth = useAuth();
  const navigate = useNavigate();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      await post<ServerTimed & { handle: string | null }>("/api/auth/verify", {
        email,
        code,
      });
      // The server is the authority on who you are now, so ask it rather than
      // believing the response — the next screen depends on the handle.
      await auth.refresh();
      void navigate("/app", { replace: true });
    } catch (failure) {
      setError(messageFor(failure));
      setPending(false);
    }
  }

  async function resend() {
    setError(null);
    setResending(true);
    try {
      await post("/api/auth/request-code", { email });
      // The old code stops working the moment a new one is sent, so anything
      // half-typed is now wrong.
      setCode("");
    } catch (failure) {
      setError(messageFor(failure));
    } finally {
      setResending(false);
    }
  }

  return (
    <div className="space-y-4">
      <Alert>
        <KeyRound />
        <AlertTitle>{copy.login.sentTitle}</AlertTitle>
        <AlertDescription>
          <SentTo email={email} />
        </AlertDescription>
      </Alert>

      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="code">{copy.login.code}</Label>
          <Input
            id="code"
            name="code"
            // A code is typed, not read: it stays in ASCII digits, unlike
            // every other number in the app. inputMode gets a phone's numeric
            // keypad without refusing a paste.
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(event) => setCode(enDigits(event.target.value.trim()))}
            autoFocus
            required
            maxLength={6}
            dir="ltr"
            className="text-center font-mono tracking-[0.5em]"
          />
          <p className="text-xs text-muted-foreground">{copy.login.codeHint}</p>
        </div>

        <Failure message={error} />

        <SubmitButton
          pending={pending}
          label={copy.login.go}
          pendingLabel={copy.login.signingIn}
        />
      </form>

      <div className="flex items-center justify-between text-xs">
        <button
          type="button"
          onClick={() => void resend()}
          disabled={resending}
          className="text-muted-foreground hover:text-foreground disabled:opacity-50"
        >
          {resending ? copy.login.sending : copy.login.resend}
        </button>
        <button
          type="button"
          onClick={onStartOver}
          className="text-muted-foreground hover:text-foreground"
        >
          {copy.login.changeEmail}
        </button>
      </div>
    </div>
  );
}

