import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { stringify } from "yaml";
import {
  appendInboxRow, checkAides, findAide, loadAides, parseInbox, readInbox,
  sayToAide, type InboxRow,
} from "../src/aides";
import { startServer } from "../src/server";
import { getRootDir, setRootDir } from "../src/state";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

describe("Aides", () => {
  let root: string;
  let originalRoot: string;

  function registry(aides: unknown[]) {
    writeFileSync(join(root, "aides.yaml"), stringify({ aides }));
  }

  function aide(name: string, door: unknown = { type: "file", path: "door.md" }) {
    return {
      name, kind: "fictional bot", owner: "Example Operator",
      description: "An illustrative Aide", door, inbox: `${name}.md`,
      capabilities: ["review"], credential_scope: "Own review workspace",
      hard_lines: ["Record decisions"],
    };
  }

  async function cli(args: string[]) {
    const child = Bun.spawn(["bun", "run", CLI, "aides", ...args], {
      cwd: root, stdout: "pipe", stderr: "pipe", env: { ...process.env },
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    return { stdout, stderr, code };
  }

  beforeEach(() => {
    originalRoot = getRootDir();
    root = mkdtempSync(join(tmpdir(), "gs-aides-test-"));
    setRootDir(root);
  });

  afterEach(() => {
    setRootDir(originalRoot);
    rmSync(root, { recursive: true, force: true });
  });

  it("loads an optional registry and rejects duplicate names, missing paths, and credential-shaped values", () => {
    expect(loadAides(root)).toEqual([]);
    expect(checkAides(root)).toContain("aides.yaml is missing");
    registry([aide("Cinder")]);
    expect(loadAides(root)[0].name).toBe("Cinder");
    expect(checkAides(root)).toEqual(expect.arrayContaining([
      expect.stringContaining("inbox is missing"),
      expect.stringContaining("file door is missing"),
    ]));
    writeFileSync(join(root, "Cinder.md"), "");
    writeFileSync(join(root, "door.md"), "");
    expect(checkAides(root)).toEqual([]);
    registry([aide("Cinder"), aide("cinder")]);
    expect(() => loadAides(root)).toThrow("duplicate Aide name");
    const planted = aide("Cinder");
    planted.credential_scope = `sk-proj-${"a".repeat(25)}`;
    registry([planted]);
    expect(() => checkAides(root)).toThrow("credential-shaped");
    expect(findAide([aide("Cinder") as any], "cinder").name).toBe("Cinder");
  });

  it("validates HTTP header environment names without keeping values", () => {
    registry([aide("Lumen", { type: "http", url: "https://agent.invalid/door", headers: { Authorization: "AIDE_AUTH" } })]);
    expect(loadAides(root)[0].door).toEqual({ type: "http", url: "https://agent.invalid/door", headers: { Authorization: "AIDE_AUTH" } });
    registry([aide("Lumen", { type: "http", url: "https://agent.invalid/door", headers: { Authorization: "Bearer abc" } })]);
    expect(() => loadAides(root)).toThrow("environment variable name");
    registry([aide("Lumen", { type: "http", url: "https://name:pass@agent.invalid/door" })]);
    expect(() => loadAides(root)).toThrow("must not contain user info");
    registry([aide("Lumen", { type: "http", url: "https://agent.invalid/door?key=value" })]);
    expect(() => loadAides(root)).toThrow("must not contain user info");
  });

  it("parses rows and preserves every concurrent append", async () => {
    const file = join(root, "inbox.md");
    const makeRow = (i: number): InboxRow => ({
      timestamp: "2026-01-01 10:00 UTC", from: "Cinder", title: `Decision ${i}`,
      tags: ["decision", "ready"], body: [`Item ${i}`],
    });
    await Promise.all(Array.from({ length: 40 }, (_, i) => appendInboxRow(file, makeRow(i))));
    const rows = await readInbox(file);
    expect(rows).toHaveLength(40);
    expect(rows.map((row) => row.title)).toEqual(Array.from({ length: 40 }, (_, i) => `Decision ${i}`));
    expect(rows[0].tags).toEqual(["decision", "ready"]);
    expect(parseInbox(readFileSync(file, "utf8"))).toEqual(rows);
  });

  it("sends through a file door and then records an outbound inbox row", async () => {
    registry([aide("Cinder")]);
    writeFileSync(join(root, "Cinder.md"), "");
    writeFileSync(join(root, "door.md"), "");
    await sayToAide(loadAides(root)[0], "Please review", root);
    expect((await readInbox(join(root, "door.md")))[0].body).toEqual([
      "Operator Example Operator via GeneralStaff:", "Please review",
    ]);
    expect((await readInbox(join(root, "Cinder.md")))[0]).toMatchObject({
      from: "GeneralStaff", title: "Outbound request", tags: ["outbound"], body: ["Please review"],
    });
  });

  it("sends command-door text on stdin without shell interpolation", async () => {
    const script = join(root, "fake-command.ts");
    const received = join(root, "received.txt");
    writeFileSync(script, `await Bun.write(${JSON.stringify(received)}, await Bun.stdin.text());`);
    registry([aide("Lumen", { type: "command", argv: [process.execPath, "run", script] })]);
    writeFileSync(join(root, "Lumen.md"), "");
    expect(checkAides(root)).toEqual([]);
    await sayToAide(loadAides(root)[0], "quote ' ; $(unused)", root);
    expect(readFileSync(received, "utf8")).toContain("quote ' ; $(unused)");
    expect((await readInbox(join(root, "Lumen.md")))[0].tags).toEqual(["outbound"]);
  });

  it("sends HTTP JSON with a header value read from the environment", async () => {
    let received: unknown = null;
    const server = Bun.serve({ port: 0, fetch: async (request) => {
      received = {
        message: (await request.json() as { message: string }).message,
        authorization: request.headers.get("Authorization"),
      };
      return new Response("accepted");
    } });
    const previous = process.env.AIDES_TEST_AUTH;
    process.env.AIDES_TEST_AUTH = "fictional-test-value";
    try {
      registry([aide("Lumen", { type: "http", url: server.url.toString(), headers: { Authorization: "AIDES_TEST_AUTH" } })]);
      writeFileSync(join(root, "Lumen.md"), "");
      await sayToAide(loadAides(root)[0], "Please decide", root);
      expect(received).toEqual({
        message: "Operator Example Operator via GeneralStaff:\nPlease decide",
        authorization: "fictional-test-value",
      });
      expect((await readInbox(join(root, "Lumen.md")))[0].tags).toEqual(["outbound"]);
    } finally {
      if (previous === undefined) delete process.env.AIDES_TEST_AUTH;
      else process.env.AIDES_TEST_AUTH = previous;
      server.stop(true);
    }
  });

  it("wires list, show, say, inbox, and check through the CLI", async () => {
    registry([aide("Cinder")]);
    writeFileSync(join(root, "Cinder.md"), "");
    writeFileSync(join(root, "door.md"), "");
    expect((await cli(["list"])).stdout).toContain("Cinder");
    expect((await cli(["show", "Cinder"])).stdout).toContain("Credential scope: Own review workspace");
    expect((await cli(["check"])).code).toBe(0);
    expect((await cli(["say", "Cinder", "Please review"])).code).toBe(0);
    const inbox = await cli(["inbox", "Cinder", "--since", "2026-01-01"]);
    expect(inbox.code).toBe(0);
    expect(inbox.stdout).toContain("Outbound request [outbound]");
    const planted = aide("Cinder");
    planted.credential_scope = `sk-proj-${"a".repeat(25)}`;
    registry([planted]);
    const check = await cli(["check"]);
    expect(check.code).toBe(1);
    expect(check.stderr).toContain("credential-shaped");
  });

  it("renders a read-only dashboard section with escaped recent rows", async () => {
    registry([aide("Cinder")]);
    writeFileSync(join(root, "Cinder.md"), "");
    writeFileSync(join(root, "door.md"), "");
    await appendInboxRow(join(root, "Cinder.md"), {
      timestamp: "2026-01-01 10:00 UTC", from: "Cinder", title: "Review <done>",
      tags: ["ready"], body: ["<script>alert(1)</script>"],
    });
    const server = await startServer({ port: 0 });
    try {
      const html = await (await fetch(server.url)).text();
      expect(html).toContain("id=\"aides-heading\"");
      expect(html).toContain("Review &lt;done&gt;");
      expect(html).not.toContain("<script>alert(1)</script>");
    } finally { server.stop(); }
  });
});
