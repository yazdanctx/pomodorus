# 0003 — Email OTP is the credential; the handle is the public identity

**Status:** accepted (2026-08-13). Reverses v1, which was emphatic that no
email address was collected, verified or stored anywhere.

## Context

v1 logged in with a username and a password, and the username *was* the
account: it was the credential, the public handle, and the profile URL at once.
There was no email, and therefore no password reset — a forgotten password
could only be sorted out by hand.

The rewrite calls for email + one-time code, and nothing else. That splits a
concept v1 had deliberately fused.

## Decision

- **Email is the credential.** It is never shown to anyone.
- **The handle is the public identity** — `[a-z0-9_]{3,20}`, unique, claimed
  once after the first successful code, and **immutable** thereafter.
- One flow, not two: an unknown address creates the account, a known one signs
  in. The form never asks which.
- The account exists from the moment the code is verified, before a handle is
  picked. Such a user is signed in but cannot appear anywhere public.

The handle's format, uniqueness, and immutability are all enforced in the
database (a `CHECK`, a unique index, and a trigger), because that is the only
layer that cannot be bypassed.

Codes are six digits, valid ten minutes, single-use, five attempts, hashed at
rest, compared in constant time, and rate-limited per address and per IP. The
endpoint always answers "sent", so it cannot be used to discover who has an
account.

## Alternatives rejected

- **A mutable handle.** Friendlier, but shared profile links rot, and a freed
  handle is an impersonation vector on a public feed.
- **Deriving the public name from the email local-part.** No claim step, but it
  publishes part of everyone's address in a public feed.

## Consequences

- Onboarding gains a step: verify, then claim.
- Password reset stops being a problem that exists.
- Delivery becomes a hard dependency of login — see ADR 0005, where it is the
  largest open risk in the project.
