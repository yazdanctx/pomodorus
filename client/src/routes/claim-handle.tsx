import { useState, type FormEvent } from "react";
import { Loader2, TriangleAlert } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { messageFor, post } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { copy, t } from "@/lib/copy";
import { enDigits } from "@/lib/format";

/**
 * The one irreversible decision in the app, and the screen says so before you
 * commit rather than after.
 *
 * A user who has verified an address but has no handle yet lands here instead
 * of the timer, every time they sign in, until they pick one — the state is
 * the server's answer to "who are you", so abandoning the step and coming back
 * resumes at it with nothing remembered on the device.
 *
 * No v1 reference: v1 had no such step. Built from the tokens alongside the
 * login screen it follows.
 */
export function ClaimHandleRoute() {
  const auth = useAuth();
  const [handle, setHandle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      await post("/api/handle", { handle });
      await auth.refresh();
    } catch (failure) {
      setError(messageFor(failure));
      setPending(false);
    }
  }

  async function signOut() {
    await post("/api/auth/sign-out");
    await auth.refresh();
  }

  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <div className="w-full max-w-xs space-y-8">
        <div className="space-y-2 text-center">
          <h1 className="text-base font-medium">{copy.handle.title}</h1>
          <p className="text-sm text-muted-foreground">{copy.handle.body}</p>
        </div>

        {/* Said before the field, not beside the button: this is the thing to
            know while choosing, not a confirmation to skim past. */}
        <Alert>
          <TriangleAlert />
          <AlertTitle>{copy.handle.permanentTitle}</AlertTitle>
          <AlertDescription>{copy.handle.permanent}</AlertDescription>
        </Alert>

        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="handle">{copy.handle.label}</Label>
            <Input
              id="handle"
              name="handle"
              value={handle}
              // Lowercased as it is typed rather than refused afterwards:
              // somebody who types Yazdan means yazdan, and the server folds
              // it anyway. Persian digits are pushed back to ASCII because a
              // handle is Latin by construction.
              onChange={(event) =>
                setHandle(enDigits(event.target.value.trim().toLowerCase()))
              }
              autoFocus
              required
              minLength={3}
              maxLength={20}
              pattern="[a-z0-9_]+"
              autoComplete="username"
              dir="ltr"
              className="[font-family:ui-sans-serif,system-ui,sans-serif]"
            />
            <p className="text-xs text-muted-foreground">{copy.handle.hint}</p>
          </div>

          {/* The box is held whether or not there is a preview in it, so the
              button does not move as the field fills. */}
          <p
            className="h-4 text-xs text-muted-foreground [font-family:ui-sans-serif,system-ui,sans-serif]"
            dir="ltr"
          >
            {handle && t(copy.handle.preview, { handle })}
          </p>

          <div aria-live="polite">
            {error && (
              <Alert className="text-foreground">
                <TriangleAlert />
                <AlertDescription className="text-foreground">
                  {error}
                </AlertDescription>
              </Alert>
            )}
          </div>

          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? (
              <>
                <Loader2 className="animate-spin" />
                {copy.handle.claiming}
              </>
            ) : (
              copy.handle.claim
            )}
          </Button>
        </form>

        {/* The only way out of a half-made account that is not picking a name.
            Without it, somebody who signed in with the wrong address is stuck
            on this screen with nothing to press. */}
        <button
          type="button"
          onClick={() => void signOut()}
          className="w-full text-center text-xs text-muted-foreground hover:text-foreground"
        >
          {copy.handle.signOut}
        </button>
      </div>
    </main>
  );
}
