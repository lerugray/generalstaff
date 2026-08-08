#!/usr/bin/env node

// Generic skeleton: this file MUST be adapted inside the managed project.
// No project-specific browser dependency is imposed on GeneralStaff.
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";

const [artifactArg, reportArg = "player-path-evidence.json"] = process.argv.slice(2);
if (!artifactArg) {
  console.error("Usage: node player-path-probe.mjs <shipped-file> [report.json]");
  process.exit(2);
}

const artifact = resolve(artifactArg);
const reportPath = resolve(reportArg);
const repoRoot = resolve(process.cwd());
const seed = Number(process.env.PLAYER_PATH_SEED ?? 41041);
const iterations = Number(process.env.PLAYER_PATH_ITERATIONS ?? 20);

function adapterRequired(name) {
  throw new Error(`ADAPTER_REQUIRED: implement adapter.${name} for the real user path`);
}

function hasEvidence(value) {
  return value !== undefined && value !== null &&
    (typeof value !== "string" || value.trim().length > 0);
}

// Playwright/Puppeteer adapter hooks. Implementations must drive real input
// events, not call product engine modules. Return serializable evidence.
const adapter = {
  requiredCoverage: [
    "ADAPT: initial load",
    "ADAPT: primary interaction",
    "ADAPT: state transition",
    "ADAPT: failure and restart",
    "ADAPT: save/load or equivalent persistence boundary",
    "ADAPT: rapid input, resize, blur/focus, and user-gesture audio",
  ],
  inputScript: "ADAPT: describe deterministic real input events",
  maxHeapGrowthBytes: 0, // ADAPT: measured project-specific ceiling.
  async launch() { return adapterRequired("launch"); },
  async load(_page, _stagedPath) { return adapterRequired("load"); },
  async driveIteration(_page, _iteration, _seed) { return adapterRequired("driveIteration"); },
  async visualSignature(_page) { return adapterRequired("visualSignature"); },
  async heapBytes(_page) { return adapterRequired("heapBytes"); },
  async framesPerSecond(_page) { return adapterRequired("framesPerSecond"); },
  async assertStallFree(_page, _iteration) { return adapterRequired("assertStallFree"); },
};

const startedAt = new Date().toISOString();
const errors = { console: [], page: [] };
const samples = [];
const coverage = Object.fromEntries(
  adapter.requiredCoverage.map((name) => [name, { reached: false, evidence: [] }]),
);
let stagedDir;
let browser;
let report;

try {
  stagedDir = await mkdtemp(`${tmpdir()}/gs-player-path-`);
  if (stagedDir.startsWith(repoRoot + "/")) {
    throw new Error("Staging directory resolved inside the repository");
  }
  const stagedArtifact = resolve(stagedDir, basename(artifact));
  await copyFile(artifact, stagedArtifact);
  const sha256 = createHash("sha256").update(await readFile(stagedArtifact)).digest("hex");

  const launched = await adapter.launch();
  browser = launched.browser;
  const page = launched.page;
  if (!browser || !page) throw new Error("Adapter launch() must return { browser, page }");

  page.on("console", (message) => {
    if (message.type() === "error") errors.console.push(message.text());
  });
  page.on("pageerror", (error) => errors.page.push(error.stack ?? error.message));

  const runtime = await adapter.load(page, stagedArtifact);
  let previousVisual = await adapter.visualSignature(page);
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const reached = await adapter.driveIteration(page, iteration, seed);
    for (const item of reached ?? []) {
      if (!coverage[item.name]) throw new Error(`Undeclared coverage surface: ${item.name}`);
      if (!hasEvidence(item.evidence)) {
        throw new Error(`Coverage surface has no evidence: ${item.name}`);
      }
      coverage[item.name].reached = true;
      coverage[item.name].evidence.push(item.evidence);
    }
    await adapter.assertStallFree(page, iteration);
    const visual = await adapter.visualSignature(page);
    const changed = visual !== previousVisual;
    samples.push({
      iteration,
      timestamp: new Date().toISOString(),
      visualSignature: visual,
      visualChanged: changed,
      heapBytes: await adapter.heapBytes(page),
      framesPerSecond: await adapter.framesPerSecond(page),
    });
    if (!changed) throw new Error(`Visual liveness failed at iteration ${iteration}`);
    previousVisual = visual;
  }

  const heap = samples.map((sample) => sample.heapBytes);
  if (heap.some((value) => !Number.isFinite(value))) throw new Error("Heap samples are required");
  if (samples.some((sample) => !Number.isFinite(sample.framesPerSecond))) {
    throw new Error("Frame-rate samples are required; return a meaningful project sample");
  }
  const heapGrowthBytes = heap.at(-1) - heap[0];
  const uncovered = Object.entries(coverage)
    .filter(([, value]) => !value.reached || value.evidence.length === 0)
    .map(([name]) => name);
  const evidenceComplete =
    typeof runtime?.name === "string" && runtime.name.length > 0 &&
    typeof runtime?.version === "string" && runtime.version.length > 0 &&
    adapter.inputScript && !adapter.inputScript.startsWith("ADAPT:") &&
    adapter.maxHeapGrowthBytes > 0 && samples.length === iterations &&
    uncovered.length === 0 && errors.console.length === 0 && errors.page.length === 0 &&
    samples.every((sample) => sample.visualChanged) && heapGrowthBytes <= adapter.maxHeapGrowthBytes;
  if (!evidenceComplete) throw new Error("Required evidence is missing or failing");

  report = {
    schemaVersion: 1,
    verdict: "PASS",
    artifact: { source: artifact, exercisedPath: stagedArtifact, sha256 },
    runtime,
    startedAt,
    endedAt: new Date().toISOString(),
    seed,
    inputScript: adapter.inputScript,
    coverage,
    errors,
    stallDetector: { passed: true, checks: iterations },
    samples,
    heapGrowthBytes,
    maxHeapGrowthBytes: adapter.maxHeapGrowthBytes,
  };
} catch (error) {
  report = {
    schemaVersion: 1,
    verdict: "FAIL",
    startedAt,
    endedAt: new Date().toISOString(),
    artifact: { source: artifact },
    coverage,
    errors,
    samples,
    failure: error instanceof Error ? { message: error.message, stack: error.stack } : { message: String(error) },
  };
  process.exitCode = 1;
} finally {
  try { await browser?.close(); } catch (error) { process.exitCode = 1; report.closeError = String(error); }
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  // Evidence retains the staged path and hash; the disposable exercised copy is removed.
  if (stagedDir) await rm(stagedDir, { recursive: true, force: true });
  console.log(JSON.stringify({ verdict: report.verdict, report: reportPath }));
}
