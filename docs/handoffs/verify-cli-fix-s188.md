# Verify-only CLI: process-group fix round (s188)

Grounded: branch `s187/verify-cli-contract-r2` @ 6ccb354 (real-CLI seam PASS; tests 2467 pass / 0 fail, typecheck clean).
An adversarial review found two defects in the process-group code, both confirmed against the source by the seat.
Fix both, with tests that fail on the current code first.

1. **`src/verify_only/process_tree.ts` `linuxGroup`: state parsing.** The split `/\) (?=[A-Z] )/` requires an uppercase
   state letter, but Linux also reports lowercase states (`t` tracing stop, `x` dead; see fs/proc/array.c). For such a
   process the split does not happen, so field 2 of the whole string is read instead: an owned traced child vanishes
   from enumeration (the sweep can report reaped while it survives), and an unrelated process whose comm looks like
   `x <our-pgid> y` is parsed as our group member and receives SIGKILL. The pre-signal recheck uses the same parser.
   Fix: parse after the LAST `)` in the line (as the existing comment intends), then read state, ppid, pgrp positionally;
   reject a malformed record (throw, never guess). Tests: uppercase and lowercase states, comm containing spaces,
   parentheses and digits, and the `x <pgid> y` impostor must NOT be counted as a member.
2. **Enumeration failure disables git termination.** With `/proc` mounted `hidepid=1`, reading another user's
   `/proc/<pid>/stat` fails (EACCES/EPERM), `verificationGroupMembers` returns null, and `signalVerificationMembers`
   then signals nothing, so an inherited git child on timeout/abort receives no signal, and `releaseGitGroup` drops
   ownership after the reap deadline anyway. Fix: (a) treat EACCES/EPERM on a single entry as "not ours" (a process we
   may not read is not a member of our group) and keep enumerating; (b) when enumeration is still unproven (null), the
   inherited-git path must at least signal the KNOWN direct git child pid, never the group (the CLI leads the group);
   (c) ownership is released only when the child is proven gone, otherwise the result reports not-reaped exactly like
   the existing unproven path. Tests: injected EACCES entries, injected null enumeration with a live direct child
   (the child gets the signal; the CLI itself never does), and the not-reaped report.

Keep the change inside `src/verify_only/` plus tests; no behaviour change elsewhere; match the file's existing style.
Proof: `bun test` full suite before/after (2467 pass expected before) and `bun x tsc --noEmit` clean.
Do not commit, push or merge; leave the diff. Final message first line: `FIX SUBMITTED tests=<pass>/<total> new=<n>`
or `FIX BLOCKED <why>`, then under 20 lines on what changed.
