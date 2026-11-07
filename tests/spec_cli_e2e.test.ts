import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const CLI_PATH = join(import.meta.dir, "..", "src", "cli.ts");

const YAML = `
projects:
  - id: alpha
    path: PROJ
    priority: 1
    engineer_command: "echo hi"
    verification_command: "echo ok"
    cycle_budget_minutes: 30
    hands_off:
      - CLAUDE.md
dispatcher:
  state_dir: ./state
  fleet_state_file: ./fleet_state.json
  stop_file: ./STOP
  override_file: ./next_project.txt
  picker: priority_x_staleness
  max_cycles_per_project_per_session: 3
  log_dir: ./logs
  digest_dir: ./digests
`;

async function runCli(args: string[], cwd: string, env: Record<string, string | undefined> = {}) {
  const proc = Bun.spawn(["bun", "run", CLI_PATH, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GS_CO_SEAT: undefined, GENERALSTAFF_SPEC_GATE_OVERRIDE: undefined, OPENROUTER_API_KEY: undefined, ...env },
    cwd,
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

describe("generalstaff spec / forks resolve (CLI)", () => {
  let dir: string;
  let proj: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gs-spec-e2e-"));
    proj = join(dir, "proj");
    mkdirSync(proj, { recursive: true });
    mkdirSync(join(dir, "state", "alpha"), { recursive: true });
    writeFileSync(join(dir, "projects.yaml"), YAML.replace("PROJ", proj.replaceAll("\\", "/")));
    writeFileSync(
      join(dir, "state", "alpha", "tasks.json"),
      JSON.stringify([{ id: "a-1", title: "Add the match screen", status: "pending", priority: 1, user_facing: true }]),
    );
    writeFileSync(
      join(dir, "state", "fork-ledger.json"),
      JSON.stringify({
        forks: [{ id: "alpha::pick", project: "alpha", title: "pick", kind: "fork", status: "pending", first_seen: "t", last_seen: "t" }],
      }),
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("spec check with no anchor warns and exits 0", async () => {
    const r = await runCli(["spec", "check", "--project", "alpha", "--task", "a-1"], dir);
    expect(r.exitCode).toBe(0);
    expect(r.stdout + r.stderr).toMatch(/anchor/i);
  });

  it("spec check on a user-facing card with no owner words exits 4 without a model call", async () => {
    writeFileSync(join(proj, "SPEC.md"), "A player plays a match.\n");
    const r = await runCli(["spec", "check", "--project", "alpha", "--task", "a-1"], dir);
    expect(r.exitCode).toBe(4);
    expect(r.stdout + r.stderr).toContain("no owner words");
  });

  it("spec check with a bad flag exits 2", async () => {
    const r = await runCli(["spec", "check"], dir);
    expect(r.exitCode).toBe(2);
  });

  it("spec audit exits 2 and lists the card with MISSING owner words when the task is done", async () => {
    writeFileSync(
      join(dir, "state", "alpha", "tasks.json"),
      JSON.stringify([{ id: "a-1", title: "Add the match screen", status: "done", priority: 1, user_facing: true }]),
    );
    const out = join(dir, "audit.md");
    const r = await runCli(["spec", "audit", "--project", "alpha", "--out", out], dir);
    expect(r.exitCode).toBe(2);
    expect(readFileSync(out, "utf8")).toContain("MISSING");
  });

  it("a co-seat cannot pass an override", async () => {
    writeFileSync(join(proj, "SPEC.md"), "A player plays a match.\n");
    const r = await runCli(
      ["spec", "check", "--project", "alpha", "--task", "a-1", "--override", "checker was down today"],
      dir,
      { GS_CO_SEAT: "1" },
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("Co-seat refused");
  });

  it("forks resolve records a ruling with owner words", async () => {
    const r = await runCli(["forks", "resolve", "alpha::pick", "use the grid", "--owner-words", "I want the grid view"], dir);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("ruling");
    const led = JSON.parse(readFileSync(join(dir, "state", "fork-ledger.json"), "utf8"));
    expect(led.forks[0].resolution_kind).toBe("ruling");
  });

  it("forks resolve without words records a seat option; --kind ruling without words exits 1", async () => {
    const bad = await runCli(["forks", "resolve", "alpha::pick", "x", "--kind", "ruling"], dir);
    expect(bad.exitCode).toBe(1);
    const ok = await runCli(["forks", "resolve", "alpha::pick", "option B"], dir);
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout).toContain("seat_option");
  });

  it("a co-seat cannot record a fork resolution", async () => {
    const r = await runCli(["forks", "resolve", "alpha::pick", "x", "--owner-words", "one two three"], dir, { GS_CO_SEAT: "1" });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("Co-seat refused");
    const led = JSON.parse(readFileSync(join(dir, "state", "fork-ledger.json"), "utf8"));
    expect(led.forks[0].status).toBe("pending");
  });
});
