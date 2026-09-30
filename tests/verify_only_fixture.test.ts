import { expect, it } from "bun:test";
import { spawn } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { installTestCli } from "./helpers/test_cli";

// Exercise the platform launcher with spaces in paths and shell
// metacharacters in arguments. It must remain argv-only.
it("test CLI preserves arguments, stdin and PID", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gs test cli "));
  try {
    const executable = installTestCli(dir, "probe", `
import { readFileSync } from "fs";
console.log(JSON.stringify({ args: process.argv.slice(2), stdin: readFileSync(0, "utf8"), pid: process.pid }));
`);
    const args = ["two words", "quote'and\"double", "back\\slash", "$literal; &"];
    const child = spawn(executable, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", chunk => stdout += chunk);
    child.stderr!.on("data", chunk => stderr += chunk);
    child.stdin!.end("prompt\n");
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ args, stdin: "prompt\n", pid: child.pid });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
