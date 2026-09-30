CLI CONTRACT BLOCKED supplied seam requires budget refusal and cannot report realCliSeam=pass

Write probe succeeded: created, confirmed, and deleted .write-probe.
Read the brief, original app spec, A1, app report, and seam implementation.
Grounding: CLI dc6f443; supplied sibling app 0253d0a (the requested app revision).

The proof requirement rests on two false premises:
- App scripts/verify-gate-seam.cjs:29 initializes realCliSeam='fail' and never changes it.
- Line 38 requires state 'unavailable' and an unsupported/incomplete budget error. A repaired CLI cannot pass this assertion.
- App docs/handoffs/verify-gate-app-half-s185-REPORT.md:61 says a deterministic reviewer is still needed; it supplies no deterministic reviewer path. The default reviewer uses claude -p, prohibited by this brief.

Stopped under AGENTS.md §9.1: “If the instruction rests on a false premise ... say so and stop — don't implement against the broken premise.”
Needed correction: supply a passing-seam harness and deterministic reviewer, or amend the brief to permit building them in a temporary app copy.
No CLI implementation changes or tests run; before/after battery and real seam remain unclaimed.
Only this report was added. No model calls, commit, push, merge, or deployment. No work remains running.
