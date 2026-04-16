// GeneralStaff — doctor command: check prerequisites

interface CheckResult {
  name: string;
  found: boolean;
  version: string | null;
}

async function checkCommand(name: string, versionArg: string): Promise<CheckResult> {
  try {
    const proc = Bun.spawn([name, versionArg], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      return { name, found: false, version: null };
    }
    const version = stdout.trim().split("\n")[0];
    return { name, found: true, version };
  } catch {
    return { name, found: false, version: null };
  }
}

const PREREQUISITES: Array<{ name: string; versionArg: string }> = [
  { name: "bun", versionArg: "--version" },
  { name: "git", versionArg: "--version" },
  { name: "claude", versionArg: "--version" },
];

export async function runDoctor(): Promise<void> {
  console.log("GeneralStaff Doctor\n");
  console.log("Checking prerequisites...\n");

  const results: CheckResult[] = [];
  for (const prereq of PREREQUISITES) {
    const result = await checkCommand(prereq.name, prereq.versionArg);
    results.push(result);
  }

  let allPassed = true;
  for (const r of results) {
    if (r.found) {
      console.log(`  PASS  ${r.name} — ${r.version}`);
    } else {
      console.log(`  FAIL  ${r.name} — not found`);
      allPassed = false;
    }
  }

  console.log("");
  if (allPassed) {
    console.log("All prerequisites satisfied.");
  } else {
    console.log("Some prerequisites are missing. Install them before using GeneralStaff.");
    process.exit(1);
  }
}
