import { convexAuth, createAccount } from "@convex-dev/auth/server";
import { ConvexCredentials } from "@convex-dev/auth/providers/ConvexCredentials";
import { ConvexError } from "convex/values";
import { Scrypt } from "lucia";
import type { GenericDatabaseWriter } from "convex/server";
import type { DataModel } from "./_generated/dataModel";
import copy from "../lib/copy.json";
import { isProfane } from "../lib/profanity";

const USERNAME_RE = /^[a-z0-9_]{3,20}$/;

/**
 * Username + password, and nothing else: no email, no verification, no reset.
 * `username` is the unique immutable handle shown in the feed and used in
 * profile URLs, and now also the login credential.
 *
 * This is `ConvexCredentials` rather than the stock `Password` provider
 * because `Password` takes the account identifier from the `email` its
 * `profile()` returns, and writes that same object to the user document — so
 * keeping it would mean storing every username a second time under a field
 * called `email`. Here the account id is just the username.
 *
 * The provider keeps the id `"password"`: that is what existing `authAccounts`
 * rows are filed under, and what the client passes to `signIn`.
 */
const UsernamePassword = ConvexCredentials<DataModel>({
  id: "password",
  crypto: {
    // The hashing the `Password` provider used, kept verbatim so credentials
    // written before this change still verify.
    async hashSecret(password: string) {
      return await new Scrypt().hash(password);
    },
    async verifySecret(password: string, hash: string) {
      return await new Scrypt().verify(hash, password);
    },
  },
  authorize: async (params, ctx) => {
    const username = String(params.username ?? "")
      .trim()
      .toLowerCase();
    const password = String(params.password ?? "");
    if (!USERNAME_RE.test(username)) {
      throw new ConvexError(copy.errors.usernameInvalid);
    }
    // No password rules beyond non-empty — casual personal app, even "test"
    // is fine. The stock provider would have demanded 8+ characters.
    if (password.length === 0) {
      throw new ConvexError(copy.errors.passwordEmpty);
    }

    // One call covers both flows, which is what lets the form be a single
    // button: `createAccount` returns the existing account when the id is
    // taken and the secret verifies, creates one when the id is free, and
    // throws when the id is taken and the secret does not. So an unknown
    // username signs you up and a known one signs you in, without the client
    // having to ask which case it is first — and since the check and the
    // write are one transaction, two devices racing on a new username cannot
    // both create it.
    try {
      const { user } = await createAccount(ctx, {
        provider: "password",
        account: { id: username, secret: password },
        profile: { username },
      });
      return { userId: user._id };
    } catch (error) {
      // Ours (username taken, from the callback below) already carry their
      // own Persian copy. Anything else means the account exists and the
      // password did not verify — the library reports that in English.
      if (error instanceof ConvexError) throw error;
      throw new ConvexError(copy.login.badCredentials);
    }
  },
});

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [UsernamePassword],
  callbacks: {
    // Runs inside the signup transaction, so throwing here aborts the whole
    // signup — that's what enforces username uniqueness.
    async afterUserCreatedOrUpdated(ctx, { userId, existingUserId }) {
      if (existingUserId !== null) return;
      // The callback ctx is typed against a generic data model; recover ours.
      const db = ctx.db as unknown as GenericDatabaseWriter<DataModel>;
      const user = await db.get(userId);
      const username = user?.username;
      if (!username || !USERNAME_RE.test(username)) {
        throw new ConvexError(copy.errors.usernameInvalid);
      }
      // A username is immutable and public — it heads every feed item and its
      // own profile URL — so a profane one is refused before it can be minted.
      // Checked here rather than in `authorize` on purpose: this callback runs
      // only on signup, so an account that already carries such a name can
      // still sign in (the feed hides it) instead of being locked out by a
      // wordlist that did not exist when it was created.
      if (isProfane(username)) {
        throw new ConvexError(copy.errors.usernameProfane);
      }
      const clash = await db
        .query("users")
        .withIndex("by_username", (q) => q.eq("username", username))
        .filter((q) => q.neq(q.field("_id"), userId))
        .first();
      if (clash) {
        throw new ConvexError(copy.errors.usernameTaken);
      }
    },
  },
});
