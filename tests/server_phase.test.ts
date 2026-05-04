// Server-side test for the /phase route + POST /phase/advance.
// Phase B+ deferred items: dashboard render of phase-ready data and the
// commander advance-button. Each scenario boots a real Bun.serve via
// startServer({ port: 0 }) and exercises the route via fetch().

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { startServer } from "../src/server";
import { setRootDir, getRootDir } from "../src/state";
import { defaultRoadmapYaml } from "../src/phase";

const FIXTURE_DIR = join(tmpdir(), `gs-server-phase-${process.pid}`);
let originalRoot: string;

function writeProjectsYaml(projectIds: string[]) {
  const lines = ["projects:"];
  for (const id of projectIds) {
    // Project path == FIXTURE_DIR so a single ROADMAP.yaml + PHASE_STATE.json
    // location works for both the route's loadRoadmap (relative to GS-root,
    // which we set via setRootDir(FIXTURE_DIR)) and project.path lookups.
    mkdirSync(join(FIXTURE_DIR, "state", id), { recursive: true });
    lines.push(
      `  - id: ${id}`,
      `    path: ${FIXTURE_DIR.replace(/\\/g, "/")}`,
      `    priority: 1`,
      `    engineer_command: "echo"`,
      `    verification_command: "echo"`,
      `    cycle_budget_minutes: 30`,
      `    branch: bot/work`,
      `    auto_merge: false`,
      `    hands_off:`,
      `      - secret/`,
    );
  }
  lines.push("dispatcher:", "  max_parallel_slots: 1");
  writeFileSync(join(FIXTURE_DIR, "projects.yaml"), lines.join("\n"), "utf8");
}

function writeRoadmap(projectId: string) {
  writeFileSync(
    join(FIXTURE_DIR, "state", projectId, "ROADMAP.yaml"),
    defaultRoadmapYaml(projectId),
    "utf8",
  );
}

function writePhaseState(projectId: string, currentPhase = "mvp") {
  writeFileSync(
    join(FIXTURE_DIR, "state", projectId, "PHASE_STATE.json"),
    JSON.stringify({
      project_id: projectId,
      current_phase: currentPhase,
      completed_phases: [],
    }),
    "utf8",
  );
}

function writePhaseReadySentinel(
  projectId: string,
  fromPhase = "mvp",
  toPhase = "launch",
) {
  writeFileSync(
    join(FIXTURE_DIR, "state", projectId, "PHASE_READY.json"),
    JSON.stringify({
      project_id: projectId,
      from_phase: fromPhase,
      to_phase: toPhase,
      detected_at: new Date(Date.now() - 60_000).toISOString(),
      criteria_results: [
        { kind: "all_tasks_done", passed: true, detail: "0 tasks; vacuous" },
      ],
    }),
    "utf8",
  );
}

beforeEach(() => {
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
  mkdirSync(FIXTURE_DIR, { recursive: true });
  originalRoot = getRootDir();
  setRootDir(FIXTURE_DIR);
});

afterEach(() => {
  setRootDir(originalRoot);
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
});

describe("GET /phase — phase-ready dashboard", () => {
  it("renders the empty state when no projects have a sentinel", async () => {
    writeProjectsYaml(["alpha"]);
    writeRoadmap("alpha");
    const server = await startServer({ port: 0 });
    try {
      const res = await fetch(`${server.url}/phase`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      const body = await res.text();
      expect(body).toContain("Phase-ready projects");
      expect(body).toContain("No projects ready to advance");
      expect(body).toContain("1 have a ROADMAP.yaml");
    } finally {
      server.stop();
    }
  });

  it("renders a row + advance form for each project with a sentinel", async () => {
    writeProjectsYaml(["alpha", "beta"]);
    writeRoadmap("alpha");
    writePhaseState("alpha");
    writePhaseReadySentinel("alpha");
    const server = await startServer({ port: 0 });
    try {
      const res = await fetch(`${server.url}/phase`);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain("alpha");
      expect(body).toContain("mvp");
      expect(body).toContain("launch");
      expect(body).toContain('action="/phase/advance"');
      expect(body).toContain('name="project_id" value="alpha"');
      // beta has no sentinel -> not in the table.
      expect(body).not.toContain('value="beta"');
    } finally {
      server.stop();
    }
  });

  it("nav has Phase link with aria-current on /phase", async () => {
    writeProjectsYaml(["alpha"]);
    writeRoadmap("alpha");
    const server = await startServer({ port: 0 });
    try {
      const res = await fetch(`${server.url}/phase`);
      const body = await res.text();
      // Active-state on the Phase nav link
      expect(body).toMatch(/<a href="\/phase"[^>]*aria-current="page"[^>]*>Phase<\/a>/);
    } finally {
      server.stop();
    }
  });

  it("renders an error panel when projects.yaml is missing instead of leaking the stack", async () => {
    // Fresh-machine bootstrap path: GS-root exists but no projects.yaml
    // has been written yet. Used to surface as a Bun fallback error page;
    // should render a graceful "run gs doctor" pointer instead.
    const server = await startServer({ port: 0 });
    try {
      const res = await fetch(`${server.url}/phase`);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain("Could not enumerate projects");
      expect(body).toContain("generalstaff doctor");
    } finally {
      server.stop();
    }
  });

  it("renders flash params from a redirect", async () => {
    writeProjectsYaml(["alpha"]);
    writeRoadmap("alpha");
    const server = await startServer({ port: 0 });
    try {
      const res = await fetch(
        `${server.url}/phase?flash_project=alpha&flash_status=ok&flash_message=Advanced+mvp+%E2%86%92+launch`,
      );
      const body = await res.text();
      expect(body).toContain("Advanced mvp → launch");
      expect(body).toContain("phase-flash-ok");
    } finally {
      server.stop();
    }
  });
});

describe("POST /phase/advance — commander advance button", () => {
  it("advances when criteria pass + redirects (303) with success flash", async () => {
    writeProjectsYaml(["alpha"]);
    writeRoadmap("alpha");
    writePhaseState("alpha");
    writePhaseReadySentinel("alpha");
    const server = await startServer({ port: 0 });
    try {
      const res = await fetch(`${server.url}/phase/advance`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: server.url,
        },
        body: "project_id=alpha",
        redirect: "manual",
      });
      expect(res.status).toBe(303);
      const location = res.headers.get("location") ?? "";
      expect(location.startsWith("/phase?")).toBe(true);
      const params = new URLSearchParams(location.slice("/phase?".length));
      expect(params.get("flash_project")).toBe("alpha");
      expect(params.get("flash_status")).toBe("ok");
      expect(params.get("flash_message")).toContain("mvp");
      expect(params.get("flash_message")).toContain("launch");

      // PHASE_STATE.json reflects the advance.
      const phaseState = JSON.parse(
        readFileSync(join(FIXTURE_DIR, "state", "alpha", "PHASE_STATE.json"), "utf8"),
      );
      expect(phaseState.current_phase).toBe("launch");
      expect(phaseState.completed_phases.length).toBe(1);
      expect(phaseState.completed_phases[0].phase_id).toBe("mvp");

      // Sentinel cleared.
      expect(existsSync(join(FIXTURE_DIR, "state", "alpha", "PHASE_READY.json"))).toBe(false);

      // Default-roadmap launch phase has 2 literal tasks; they got seeded.
      const tasks = JSON.parse(
        readFileSync(join(FIXTURE_DIR, "state", "alpha", "tasks.json"), "utf8"),
      );
      expect(tasks.length).toBe(2);
    } finally {
      server.stop();
    }
  });

  it("redirects with error flash when project has no roadmap", async () => {
    writeProjectsYaml(["alpha"]);
    // No ROADMAP.yaml.
    const server = await startServer({ port: 0 });
    try {
      const res = await fetch(`${server.url}/phase/advance`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: server.url,
        },
        body: "project_id=alpha",
        redirect: "manual",
      });
      expect(res.status).toBe(303);
      const params = new URLSearchParams(
        (res.headers.get("location") ?? "").slice("/phase?".length),
      );
      expect(params.get("flash_status")).toBe("error");
      expect(params.get("flash_message")).toContain("ROADMAP.yaml");
    } finally {
      server.stop();
    }
  });

  it("redirects with error flash when project_id is unknown", async () => {
    writeProjectsYaml(["alpha"]);
    const server = await startServer({ port: 0 });
    try {
      const res = await fetch(`${server.url}/phase/advance`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: server.url,
        },
        body: "project_id=ghost",
        redirect: "manual",
      });
      expect(res.status).toBe(303);
      const params = new URLSearchParams(
        (res.headers.get("location") ?? "").slice("/phase?".length),
      );
      expect(params.get("flash_status")).toBe("error");
      expect(params.get("flash_message")).toContain("not registered");
    } finally {
      server.stop();
    }
  });

  it("redirects with error flash when project_id is missing from body", async () => {
    writeProjectsYaml(["alpha"]);
    const server = await startServer({ port: 0 });
    try {
      const res = await fetch(`${server.url}/phase/advance`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: server.url,
        },
        body: "",
        redirect: "manual",
      });
      expect(res.status).toBe(303);
      const params = new URLSearchParams(
        (res.headers.get("location") ?? "").slice("/phase?".length),
      );
      expect(params.get("flash_status")).toBe("error");
      expect(params.get("flash_message")).toContain("required");
    } finally {
      server.stop();
    }
  });

  it("rejects POST with mismatched Origin (403, no advance)", async () => {
    writeProjectsYaml(["alpha"]);
    writeRoadmap("alpha");
    writePhaseState("alpha");
    writePhaseReadySentinel("alpha");
    const server = await startServer({ port: 0 });
    try {
      const res = await fetch(`${server.url}/phase/advance`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: "http://evil.example.com",
        },
        body: "project_id=alpha",
        redirect: "manual",
      });
      expect(res.status).toBe(403);
      // Sentinel still present — advance did not run.
      expect(existsSync(join(FIXTURE_DIR, "state", "alpha", "PHASE_READY.json"))).toBe(true);
      // PHASE_STATE.json untouched (still mvp).
      const phaseState = JSON.parse(
        readFileSync(join(FIXTURE_DIR, "state", "alpha", "PHASE_STATE.json"), "utf8"),
      );
      expect(phaseState.current_phase).toBe("mvp");
    } finally {
      server.stop();
    }
  });

  it("accepts POST with no Origin header (older clients / curl)", async () => {
    writeProjectsYaml(["alpha"]);
    writeRoadmap("alpha");
    writePhaseState("alpha");
    writePhaseReadySentinel("alpha");
    const server = await startServer({ port: 0 });
    try {
      // Note: Bun's fetch always sets Origin on POST when constructing
      // from a URL. Using Request directly + omitting Origin is fragile;
      // simplest path is to send same-origin (which we already cover in
      // the success test) and confirm the absent-Origin path via the
      // exported helper directly.
      const { isAcceptableOrigin } = await import("../src/server/routes/phase");
      const reqWithoutOrigin = new Request("http://127.0.0.1:1/phase/advance", {
        method: "POST",
        headers: { Host: "127.0.0.1:1" },
      });
      expect(isAcceptableOrigin(reqWithoutOrigin)).toBe(true);

      const reqWithMatchingOrigin = new Request("http://127.0.0.1:1/phase/advance", {
        method: "POST",
        headers: { Origin: "http://127.0.0.1:1", Host: "127.0.0.1:1" },
      });
      expect(isAcceptableOrigin(reqWithMatchingOrigin)).toBe(true);

      const reqWithMismatchingOrigin = new Request("http://127.0.0.1:1/phase/advance", {
        method: "POST",
        headers: { Origin: "http://attacker.example", Host: "127.0.0.1:1" },
      });
      expect(isAcceptableOrigin(reqWithMismatchingOrigin)).toBe(false);
    } finally {
      server.stop();
    }
  });
});
