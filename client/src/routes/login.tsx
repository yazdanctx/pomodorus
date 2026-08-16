import { useState, type FormEvent } from "react";
import { ArrowRight, KeyRound, TriangleAlert } from "lucide-react";
import { Link, useNavigate } from "react-router";

import { Failure } from "@/components/failure";
import { SubmitButton } from "@/components/submit-button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { messageFor, post, type ServerTimed } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { copy, t } from "@/lib/copy";
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
 * this is built from the design tokens and v1's own furniture — the bordered
 * iconned alert taking the NavBar's band, the field hint, the
 * spinner-and-waiting-label submit, and the link back to the landing.
 */
export function LoginRoute() {
  const [email, setEmail] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);

  return (
    <main className="flex flex-1 flex-col">
      {/* The NavBar is hidden on this route, so the notice takes its band:
          full width of the content frame, on the NavBar's own px-6. */}
      <div className="shrink-0 space-y-2 px-6 py-4">
        <Alert>
          <TriangleAlert />
          <AlertTitle>{copy.landing.experimentalTitle}</AlertTitle>
          <AlertDescription>
            {copy.landing.experimental}
            <p>{copy.landing.experimentalVibes}</p>
          </AlertDescription>
        </Alert>
        <Alert>
          <KeyRound />
          <AlertTitle>{copy.login.otpTitle}</AlertTitle>
          <AlertDescription>{copy.login.otpBody}</AlertDescription>
        </Alert>
      </div>

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
        <AlertDescription>{t(copy.login.sentBody, { email })}</AlertDescription>
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

