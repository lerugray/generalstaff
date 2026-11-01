// Stand-in for `claude -p` in reviewer tests. Behavior comes from FAKE_CLAUDE_MODE:
//   verdict_exit:<n>   print a well-formed "verified" verdict, then exit <n>
//   verdict_hang       print the verdict, then never exit (until killed)
//   empty              print nothing, exit 0
export {};
await Bun.stdin.text();
const mode = process.env.FAKE_CLAUDE_MODE ?? "verdict_exit:0";
const verdict = JSON.stringify({
  verdict: "verified",
  reason: "all good",
  scope_drift_files: [],
  hands_off_violations: [],
  task_evidence: [],
  silent_failures: [],
  notes: "",
});
if (mode.startsWith("verdict_exit:")) {
  process.stdout.write(verdict);
  process.stderr.write("fatal: simulated failure\n");
  process.exit(parseInt(mode.slice("verdict_exit:".length), 10));
} else if (mode === "verdict_hang") {
  process.stdout.write(verdict);
  setInterval(() => {}, 1000);
} else if (mode === "empty") {
  process.exit(0);
}
