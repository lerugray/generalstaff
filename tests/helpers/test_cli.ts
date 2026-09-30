// Executable test doubles for argv-only child_process.spawn calls. Windows
// cannot execute a shebang or .cmd without a shell; use a native Bun launcher
// there, with the same JavaScript sidecar that the Unix wrapper runs.
import { spawnSync } from "child_process";
import { chmodSync, copyFileSync, linkSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let nativeLauncher: string | undefined;

function launcher(): string {
  if (nativeLauncher) return nativeLauncher;
  const dir = mkdtempSync(join(tmpdir(), "gs-test-launcher-"));
  process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, "launcher.ts");
  writeFileSync(source, `import { pathToFileURL } from "url";\nawait import(pathToFileURL(process.execPath + ".mjs").href);\n`);
  const output = join(dir, process.platform === "win32" ? "launcher.exe" : "launcher");
  const built = spawnSync(process.execPath, ["build", "--compile", source, "--outfile", output], {
    encoding: "utf8", timeout: 60_000,
  });
  if (built.status !== 0) throw new Error(`test launcher build failed: ${built.error ?? built.stderr}`);
  nativeLauncher = output;
  return output;
}

export function cliFixturePath(binDir: string, name: string): string {
  return join(binDir, name + (process.platform === "win32" ? ".exe" : ""));
}

/** POSIX shell quoting, including Git Bash's spelling of native Windows paths. */
export function shellQuote(value: string): string {
  const path = process.platform === "win32" ? value.replaceAll("\\", "/") : value;
  return `'${path.replaceAll("'", "'\\''")}'`;
}

export function installTestCli(binDir: string, name: string, source: string): string {
  const executable = cliFixturePath(binDir, name);
  writeFileSync(executable + ".mjs", source);
  if (process.platform === "win32") {
    try { linkSync(launcher(), executable); }
    catch { copyFileSync(launcher(), executable); }
  } else {
    writeFileSync(executable, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(executable + ".mjs")} "$@"\n`);
    chmodSync(executable, 0o755);
  }
  return executable;
}

/** A verification command still runs through the product's real Bash runner. */
export function scriptCommand(scratch: string, source: string): string {
  const script = join(scratch, `command-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(script, source);
  return `exec ${shellQuote(process.execPath)} ${shellQuote(script)}`;
}

/** Native PIDs (unlike MSYS sleep/$!), including a descendant for tree-kill tests. */
export function sleepingCommand(scratch: string, ms: number, ignoreTerm = false): string {
  const child = join(scratch, "sleeper.mjs");
  writeFileSync(child, `${ignoreTerm ? 'process.on("SIGTERM", () => {});' : ''}\nsetTimeout(() => {}, ${ms});\n`);
  return scriptCommand(scratch, `
import { spawn } from "child_process";
import { writeFileSync } from "fs";
${ignoreTerm ? 'process.on("SIGTERM", () => {});' : ''}
const child = spawn(${JSON.stringify(process.execPath)}, [${JSON.stringify(child)}], { stdio: "inherit" });
child.on("spawn", () => writeFileSync(${JSON.stringify(join(scratch, "pid.txt"))}, String(child.pid)));
child.on("exit", () => process.exit(0));
`);
}
