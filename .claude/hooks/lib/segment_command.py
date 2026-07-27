#!/usr/bin/env python3
"""segment_command.py — quote-aware, heredoc-aware command segmentation for
SailCommand Bash-matching hooks (#216).

Splits a shell command string into top-level segments on &&, ||, ;, |, (, )
and real newlines, WITHOUT being fooled by three shapes a PR review found
reproducible against the previous pure-`tr`/`read` bash implementation:

  Blocker 1 (quote-unaware split): `tr ';&|' '\\n\\n\\n'` operated on raw
  bytes, so a separator character INSIDE a quoted string —
  `git commit -m "fix: tidy grep usage; grep -n foo bar was wrong"` — was
  treated exactly like a real shell operator, manufacturing a phantom
  segment out of whatever quoted text followed it.

  Blocker 2 (heredoc body lines not recognised as data): the bash `while
  read -r seg` loop that consumed segments already split on every real
  newline before any "first line only" logic could run, so a heredoc BODY
  line that is itself, verbatim, `npm ci` or `grep foo .` (ordinary
  documentation-example text) was indistinguishable from a real invocation.

  Blocker 3 (subshell defeats the anchor): a leading `(` was not part of
  any recognised prefix, and a trailing `)` glued onto the last word of a
  segment (`ci)` != `ci`), so `(npm ci)` and `(cd app && npm ci)` — an
  ordinary "run this without a persistent cd" idiom — silently never
  matched at all. This is the worse failure direction (#216): the ORIGINAL
  unanchored hook over-fired but never missed a real invocation; an
  anchored hook that under-fires is a net loss (a missed `npm ci` means
  THIRD-PARTY-NOTICES.txt drifts and CI fails ~10 minutes later).

Approach: a two-pass scan, not another layer of regex/tr.
  1. strip_heredoc_bodies() blanks every heredoc BODY line (between a
     `<<[-]DELIM` marker and its closing delimiter line) — heredoc bodies
     are DATA, never commands, so nothing inside one can ever start a
     segment.
  2. segments() then does a single character-by-character scan tracking
     quote state (single/double) and one level of backslash-escaping. A
     top-level separator (`;`, `&`, `|`, `(`, `)`, `{`, `}`, real newline)
     ends the current segment ONLY when not inside a quote — this both
     ignores a quoted separator (Blocker 1) and, because `(`/`)` are
     themselves separators, cleanly unwraps a subshell without leaving a
     stray character glued to the first/last word (Blocker 3): `(npm ci)`
     yields the single clean segment `npm ci`, not `(npm` and not `ci)`.

Known, documented gaps (this is still a heuristic, not a POSIX shell
parser) — for anything a genuine invocation could hide behind, prefer
FAILING CLOSED (still matching) over silently missing it, per #216's "a
missed real invocation is worse than a stray reminder" rule:
  - command/process substitution ($(...), <(...), `...`) are not descended
    into; a program name appearing only inside one is not recognised as a
    segment start on its own (it is still visible as plain text inside
    whatever OUTER segment contains it, so this fails toward "not matched
    on that exact sub-invocation" rather than toward a phantom match).
  - multiple heredocs on one line are stripped in the order their `<<`
    markers appear, matching the common case; not proven for exotic
    nesting.
  - a mismatched/unterminated quote leaves the scanner "stuck" in quote
    mode for the remainder of the string, folding everything after it
    into one final segment — this can only ever REDUCE how much is
    inspected, i.e. it fails toward under-segmenting a malformed string,
    never toward inventing a phantom boundary.

Usage:
  printf '%s' "$CMD" | python3 segment_command.py
  -> one non-blank segment per output line (leading/trailing whitespace
     stripped; each segment is guaranteed newline-free by construction, so
     this is safe for a plain `while IFS= read -r seg` consumer).

Offline self-test:
  python3 segment_command.py --selftest
"""
import re
import sys

_HEREDOC_RE = re.compile(r"<<(-?)\s*(?:'([^']*)'|\"([^\"]*)\"|([^\s;&|(){}<>]+))")


def strip_heredoc_bodies(cmd: str) -> str:
    """Blank out heredoc BODY lines so they can never be mistaken for real
    segments (#216 Blocker 2)."""
    lines = cmd.split("\n")
    out = []
    i, n = 0, len(lines)
    while i < n:
        line = lines[i]
        out.append(line)
        for m in _HEREDOC_RE.finditer(line):
            dash = m.group(1) == "-"
            delim = m.group(2) or m.group(3) or m.group(4)
            if not delim:
                continue
            i += 1
            while i < n:
                body = lines[i]
                cmp = body.lstrip("\t") if dash else body
                if cmp == delim:
                    out.append(body)
                    break
                out.append("")
                i += 1
        i += 1
    return "\n".join(out)


def segments(cmd: str):
    """Yield one top-level segment (string, may be blank) per &&/||/;/|/(/)/
    newline boundary, respecting quotes (#216 Blocker 1) and unwrapping
    subshell parens cleanly (#216 Blocker 3)."""
    cmd = strip_heredoc_bodies(cmd)
    segs = []
    cur = []
    quote = None  # None | "'" | '"'
    i, n = 0, len(cmd)
    while i < n:
        c = cmd[i]
        if quote:
            cur.append(c)
            if c == quote:
                quote = None
            i += 1
            continue
        if c in ("'", '"'):
            quote = c
            cur.append(c)
            i += 1
            continue
        if c == "\\" and i + 1 < n:
            cur.append(c)
            cur.append(cmd[i + 1])
            i += 2
            continue
        if c in ";|(){}\n" or c == "&":
            segs.append("".join(cur))
            cur = []
            i += 1
            continue
        cur.append(c)
        i += 1
    segs.append("".join(cur))
    return segs


def _selftest() -> int:
    cases = [
        (
            "double-quoted separator is not a boundary (Blocker 1)",
            'git commit -m "fix: tidy grep usage; grep -n foo bar was wrong"',
            ['git commit -m "fix: tidy grep usage; grep -n foo bar was wrong"'],
        ),
        (
            "single-quoted separator is not a boundary (Blocker 1)",
            "gh pr comment 216 --body 'note to self; grep for the culprit later'",
            ["gh pr comment 216 --body 'note to self; grep for the culprit later'"],
        ),
        (
            "echo with a semicolon inside quotes is not a boundary (Blocker 1)",
            'echo "reminder: run before committing; npm ci is required"',
            ['echo "reminder: run before committing; npm ci is required"'],
        ),
        (
            "heredoc body lines are blanked, not segmented (Blocker 2)",
            "cat > /tmp/notes.md <<EOF\nExample:\nnpm ci\nThat installs cleanly.\nEOF",
            ["cat > /tmp/notes.md <<EOF", "EOF"],
        ),
        (
            "heredoc body mentioning grep is blanked (Blocker 2)",
            "cat > /tmp/notes.md <<EOF\nExample:\ngrep foo .\nEOF",
            ["cat > /tmp/notes.md <<EOF", "EOF"],
        ),
        (
            "bare subshell unwraps cleanly (Blocker 3)",
            "(npm ci)",
            ["npm ci"],
        ),
        (
            "compound subshell unwraps cleanly (Blocker 3)",
            "(cd app && npm ci)",
            ["cd app", "npm ci"],
        ),
        (
            "&&/;/| still split top-level segments",
            "git status && npm --prefix app update",
            ["git status", "npm --prefix app update"],
        ),
    ]
    fail = 0
    for desc, cmd, want in cases:
        got = [s.strip() for s in segments(cmd) if s.strip()]
        if got != want:
            print(f"SELFTEST FAIL: {desc} -> got {got!r} want {want!r}")
            fail = 1
    print("SELFTEST OK" if fail == 0 else "SELFTEST FAILURES")
    return fail


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--selftest":
        sys.exit(_selftest())
    # Exit non-zero (no partial output) on ANY unexpected failure — the bash
    # wrapper (anchor.sh's sc_segments) treats a non-zero exit as "cannot
    # decide" and fails CLOSED (assumes a real invocation) rather than
    # silently treating "no segments" as "definitely nothing to see" (#216:
    # a missed real invocation is worse than a spurious reminder).
    try:
        _out = [s.strip() for s in segments(sys.stdin.read()) if s.strip()]
    except Exception:
        sys.exit(1)
    for _s in _out:
        print(_s)
