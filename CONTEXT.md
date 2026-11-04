# Pomodorus

A Persian-language focus timer: a person runs timed work, the app credits the
time to their history, and a live feed shows who is working right now.

## Language

### Sessions

**Session**:
A stored span of time belonging to one person: a pomodoro, a break, or a
blackhole. It is a fact, never a ticking clock; its state follows from its
columns and the current time.
_Avoid_: timer (that is the screen), job

**Pomodoro**:
A work session with a nominal length chosen when it starts. It is credited for
that nominal length at its nominal end, however late it is confirmed.
_Avoid_: work session, focus session

**Break**:
The rest a pomodoro earns, short or long, anchored at the pomodoro's nominal
end. Not credited.

**Blackhole**:
An open-ended session with no nominal length. It runs until the person stops
it and is credited for its actual elapsed time, up to the credit cap. A
blackhole starts with at least one task, may gain or lose tasks while live,
and may host pomodoros and breaks inside it. It is ended by a stop, which
credits it, or a discard, which throws it away.
_Avoid_: long session, marathon, deep work mode

**Inner pomodoro**:
A pomodoro, with its full cycle and breaks, run inside a blackhole against one
of the blackhole's tasks. Its time belongs to the blackhole's span and is never
credited a second time; it is what attributes part of that span to a task. One
cut short by a stop is not a completed pomodoro.
_Avoid_: nested session, sub-session

**Credit cap**:
The ceiling on how much of a blackhole's elapsed time is credited. Past it the
blackhole stays live until stopped, but earns nothing further.

**Live session**:
The one session a person has that is neither confirmed nor cancelled: running,
ringing, or an open blackhole. A person has at most one. An inner pomodoro is
not a second live session; it belongs to the blackhole that is.

**Ringing**:
A session past its end that nobody has confirmed yet. Nothing advances on its
own; a ring waits for a tap.

**Multi task**:
The label a blackhole wears when it holds more than one task, in place of a
single task's name, and the bucket its time lands in when no inner pomodoro
attributed it to one task.

### Tasks

**Task**:
What a session is for: a named, per-person label, public or private. A
pomodoro has at most one; a blackhole may have several.
_Avoid_: category (the code's name for it), tag, project

### History and records

**Credited time**:
Focus time that counts toward a person's history and records: a pomodoro's
nominal length, or a blackhole's capped elapsed time.

**Tehran day**:
The unit of history. A day is a calendar day in Tehran, whatever clock the
device is on, so the chart and the records never disagree.

**Tehran week**:
Saturday through Friday, in Tehran days.

**Record**:
A person's own best on one measure, with the date it was set: best day, best
week, longest blackhole, longest streak, most pomodoros in a day. Records are
a person against their own past, never against other people, and are derived
from credited time rather than kept as facts of their own.
_Avoid_: leaderboard (implies rivals), high score

**Streak**:
Consecutive Tehran days each with some credited time.

### Connectivity

**Replay**:
Sending the sessions a device recorded while offline to the server once it is
back online. A finished session is always accepted, overlap included; only the
live slot can be lost, to whichever device reached the server first.
_Avoid_: sync (too vague), drain

**Mirror**:
The device's local copy of a person's own data: sessions, tasks, intervals and
records. The timer, blackhole, history and records run from it with no network.
_Avoid_: cache (that is the feed's stale copy), local store
