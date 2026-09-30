import { afterEach, expect, it } from "bun:test";
import { spawn } from "child_process";
import { createHash } from "crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "fs";
import { join } from "path";
import { makeVerifyFixture, type VerifyFixture } from "./helpers/verify_only_fixture";

let fx: VerifyFixture;
afterEach(() => fx?.cleanup());
const cli = join(import.meta.dir, "../src/cli.ts");
async function owned(args: string[], env: Record<string, string> = {}) {
  const child = spawn(process.execPath, ["run", cli, ...args], {
    cwd: fx.root, env: fx.env(env), detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout!.on("data", b => stdout += b);
  child.stderr!.on("data", b => stderr += b);
  const exitCode = await new Promise<number | null>(r => child.on("close", r));
  return { stdout, stderr, exitCode, pid: child.pid! };
}
async function bundle(env: Record<string, string> = {}) {
  writeFileSync(join(fx.checkout, "a.txt"), "changed\n");
  const result = await fx.runCli(["changeset", "bundle", `--checkout=${fx.checkout}`, `--base=${fx.base}`, `--out=${join(fx.scratch, "bundle")}`, "--json"], {env});
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stdout);
}
function args(b: any, extra: string[] = []) {
  return ["cycle", "verify", `--project=${fx.projectId}`, `--checkout=${fx.checkout}`, `--base=${fx.base}`, "--branch=main", `--bundle=${b.bundlePath}`, `--digest=${b.digest}`, "--digest-algorithm=gs-patch-digest/v1", "--json", ...extra];
}
async function receipt(result: {stdout: string}) {
  const start = JSON.parse(result.stdout);
  const read = await fx.runCli(["cycle", "result", start.cycleId, "--json"]);
  expect(read.exitCode).toBe(0);
  return JSON.parse(read.stdout);
}
it("M4: budget discovery is complete and has no project or state side effects", async () => {
  fx = makeVerifyFixture();
  renameSync(join(fx.root,"projects.yaml"),join(fx.root,"projects.fixture"));
  const before = readdirSync(fx.root).sort();
  const r = await fx.runCli(["cycle", "verify", "--print-budgets", "--json"]);
  expect(r.exitCode).toBe(0);
  const { budgets: b } = JSON.parse(r.stdout);
  expect(b).toMatchObject({preflightCap:120, overall:900, verification:600, reviewer:300, grace:10, cleanup:30});
  expect(b.worstCaseWallClockSec).toBeGreaterThanOrEqual(b.preflightCap + b.overall + b.grace + b.cleanup);
  expect(b.formula).toContain("cleanup");
  expect(readdirSync(fx.root).sort()).toEqual(before);
  expect(fx.claudeInvocations()).toHaveLength(0);
  expect(fx.vendorCalls()).toHaveLength(0);
  const tuned=await fx.runCli(["cycle","verify","--print-budgets","--json","--verification-timeout=1200","--grace=7"]);
  expect(JSON.parse(tuned.stdout).budgets).toMatchObject({overall:1500,verification:1200,grace:7,worstCaseWallClockSec:1657});
});
it("M2 identity: start and terminal receipt name the caller-owned verification tree", async () => {
  fx = makeVerifyFixture();
  const r = await owned(args(await bundle()));
  expect(r.exitCode).toBe(0);
  expect(JSON.parse(r.stdout).verificationTreeId).toBe(r.pid);
  expect((await receipt(r)).verify.verificationTreeId).toBe(r.pid);
});
it("M2 ownership: command inherits the caller group and grace is honored before force kill", async () => {
  if (process.platform === "win32") return;
  fx = makeVerifyFixture({verificationCommand: ({scratch}) => `trap '' TERM; echo $$ > '${scratch}/leader'; sleep 60 & echo $! > '${scratch}/child'; wait`});
  const b = await bundle();
  const child = spawn(process.execPath, ["run", cli, ...args(b, ["--verification-timeout=1", "--reviewer-timeout=1", "--overall-timeout=8", "--grace=2"])], {
    cwd: fx.root, env: fx.env(), detached: true, stdio:["ignore","pipe","pipe"],
  });
  let stdout=""; child.stdout!.on("data", b => stdout+=b); child.stderr!.resume();
  const completion = new Promise<number | null>(r=>child.on("close",r));
  const marker=join(fx.scratch,"child");
  const deadline=Date.now()+5000;
  while (!existsSync(marker) && Date.now()<deadline) await Bun.sleep(20);
  const pid=Number(readFileSync(marker,"utf8"));
  // getpgid is a scoped kernel read; unlike ps it works in the Mac sandbox.
  let pgid:number;
  if(process.platform==="darwin") {
    const {dlopen,FFIType}=await import("bun:ffi");
    const lib=dlopen("/usr/lib/libSystem.B.dylib",{getpgid:{args:[FFIType.i32],returns:FFIType.i32}});
    pgid=lib.symbols.getpgid(pid);lib.close();
  } else pgid=Number(readFileSync(`/proc/${pid}/stat`,"utf8").split(") ")[1].split(" ")[2]);
  const started=Date.now();
  const code=await completion;
  expect(pgid).toBe(child.pid!);
  expect(code).toBe(1);
  expect(Date.now()-started).toBeGreaterThanOrEqual(2600);
  expect(()=>process.kill(pid,0)).toThrow();
  expect((await receipt({stdout})).verify.reaped).toBe(true);
},15000);
it("M3: explicit excludes pin survives a changed XDG environment and rejects changed bytes", async () => {
  fx=makeVerifyFixture();
  const xdg=join(fx.scratch,"custom-xdg");mkdirSync(join(xdg,"git"),{recursive:true});
  const pin=join(xdg,"git/ignore");writeFileSync(pin,"private.txt\n");
  writeFileSync(join(fx.checkout,"private.txt"),"ignored\n");
  const hash=createHash("sha256").update(readFileSync(pin)).digest("hex");
  const b=await bundle({XDG_CONFIG_HOME:xdg});
  const options=[`--excludes-file=${pin}`,`--excludes-file-sha256=${hash}`];
  const r=await owned(args(b,options),{XDG_CONFIG_HOME:join(fx.scratch,"different-xdg")});
  expect(r.exitCode).toBe(0);
  const pinnedFacts=(await receipt(r)).verify;
  expect(pinnedFacts).toMatchObject({excludesFilePath:pin,excludesFileSha256:hash});
  expect(pinnedFacts.globalExcludesFile).toBeUndefined(); // A1's aliased reader must not receive duplicate fields.
  writeFileSync(pin,"changed-pattern\n");
  const refused=await owned(args(b,options));
  expect(refused.exitCode).toBe(3);
  expect(JSON.parse(refused.stdout)).toMatchObject({refused:true,cycleId:null,reason:"excludes_mismatch"});
});
it("M3: explicit none is pinned and malformed pairs are usage errors", async () => {
  fx=makeVerifyFixture();writeFileSync(join(fx.checkout,"new-file.txt"),"included with none\n");const b=await bundle();
  const xdg=join(fx.scratch,"ambient-ignore");mkdirSync(join(xdg,"git"),{recursive:true});writeFileSync(join(xdg,"git/ignore"),"new-file.txt\n");
  const r=await owned(args(b,["--excludes-file=none","--excludes-file-sha256="]),{XDG_CONFIG_HOME:xdg});
  expect(r.exitCode).toBe(0);
  expect((await receipt(r)).verify).toMatchObject({excludesFilePath:"none",excludesFileSha256:""});
  const bad=await owned(args(b,["--excludes-file=none","--excludes-file-sha256=abc"]));
  expect(bad.exitCode).toBe(2);
});

it("fixed reviewer is explicit, records evidence, rejects invalid verdicts and never invokes a provider", async () => {
  fx=makeVerifyFixture({extraProjectYaml:["    review:","      reviewers:","        - provider: claude","          label: first","        - provider: claude","          label: second"].join("\n")});const b=await bundle();
  for(const verdict of ["verified","verified_weak","verification_failed","invalid",""]) {
    const r=await owned(args(b),{
      GENERALSTAFF_REVIEWER_PROVIDER:"fixed", GENERALSTAFF_REVIEWER_FIXED_VERDICT:verdict,
      GENERALSTAFF_REVIEWER_FALLBACK_PROVIDER:"claude",
    });
    expect(r.exitCode).toBe(verdict.startsWith("verified")?0:1);
    const doc=await receipt(r);
    expect(doc.verify.reviewerProvider).toBe("fixed");
    expect(doc.receipts.reviewer.present).toBe(true);
    const response=readFileSync(join(fx.root,doc.evidence.reviewerResponsePath),"utf8");
    expect(response).toContain("fixed");
    expect(fx.claudeInvocations()).toHaveLength(0);
    expect(fx.vendorCalls()).toHaveLength(0);
    expect(existsSync(fx.engineerSentinel)).toBe(false);
  }
});
it("fixed approval cannot override a failed verification command", async () => {
  fx=makeVerifyFixture({verificationCommand:"exit 7"});
  const r=await owned(args(await bundle()),{GENERALSTAFF_REVIEWER_PROVIDER:"fixed",GENERALSTAFF_REVIEWER_FIXED_VERDICT:"verified"});
  expect(r.exitCode).toBe(1);
  expect((await receipt(r)).verify.failureCategory).toBe("verification_nonzero");
  expect(fx.claudeInvocations()).toHaveLength(0);
});

it("M2: caller group termination reaches grandchildren and preserves an unrelated process", async () => {
  if(process.platform==="win32")return;
  fx=makeVerifyFixture({verificationCommand:({scratch})=>`sleep 60 & echo $! > '${scratch}/owned-child'; wait`});
  const b=await bundle();
  const decoy=spawn("sleep",["60"],{detached:true,stdio:"ignore"});
  const decoyDone=new Promise(r=>decoy.once("close",r));
  const child=spawn(process.execPath,["run",cli,...args(b,["--grace=1"])],{cwd:fx.root,env:fx.env(),detached:true,stdio:["ignore","pipe","pipe"]});
  let stdout="";child.stdout!.on("data",b=>stdout+=b);child.stderr!.resume();
  const done=new Promise<number|null>(r=>child.once("close",r));
  try{
    const marker=join(fx.scratch,"owned-child");const deadline=Date.now()+5000;
    while(!existsSync(marker)&&Date.now()<deadline)await Bun.sleep(20);
    const grandchild=Number(readFileSync(marker,"utf8"));
    process.kill(-child.pid!,"SIGTERM");
    expect(await done).toBe(143);
    expect(()=>process.kill(grandchild,0)).toThrow();
    expect(()=>process.kill(decoy.pid!,0)).not.toThrow();
    const doc=await receipt({stdout});expect(doc.state).toBe("failed");
    expect(existsSync(doc.verify.worktreePath)).toBe(false);
  }finally{
    if(child.exitCode===null&&child.signalCode===null){try{process.kill(-child.pid!,"SIGKILL");}catch{}}
    decoy.kill("SIGKILL");await Promise.all([done,decoyDone]);
  }
},15000);
it("M2: a returned command cannot leave background children alive", async()=>{
  if(process.platform==="win32")return;
  fx=makeVerifyFixture({verificationCommand:({scratch})=>`sleep 60 </dev/null >/dev/null 2>&1 & echo $! > '${scratch}/leftover'; exit 0`});
  const result=await owned(args(await bundle(),["--grace=1"]));
  expect(result.exitCode).toBe(0);
  expect(()=>process.kill(Number(readFileSync(join(fx.scratch,"leftover"),"utf8")),0)).toThrow();
  expect((await receipt(result)).verify.reaped).toBe(true);
});

it("M2: caller force kill reaches Git descendants during preflight", async()=>{
  if(process.platform==="win32")return;
  fx=makeVerifyFixture();const b=await bundle();const marker=join(fx.scratch,"git-child");
  const realGit=Bun.which("git")!;const shim=join(fx.binDir,"git");
  writeFileSync(shim,`#!/bin/sh\ncase " $* " in *" config --global --path --get core.excludesFile "*) sleep 60 & echo $! > '${marker}'; wait; exit 1;; esac\nexec '${realGit}' "$@"\n`);chmodSync(shim,0o755);
  const child=spawn(process.execPath,["run",cli,...args(b)],{cwd:fx.root,env:fx.env(),detached:true,stdio:"ignore"});
  const done=new Promise(r=>child.once("close",r));let descendant:number|undefined;
  try{
    const deadline=Date.now()+5000;while(!existsSync(marker)&&Date.now()<deadline)await Bun.sleep(20);
    descendant=Number(readFileSync(marker,"utf8"));process.kill(-child.pid!,"SIGKILL");await done;
    const until=Date.now()+3000;while(Date.now()<until){try{process.kill(descendant,0);}catch{break;}await Bun.sleep(25);}
    expect(()=>process.kill(descendant!,0)).toThrow();
  }finally{
    if(child.exitCode===null&&child.signalCode===null){try{process.kill(-child.pid!,"SIGKILL");}catch{}}
    // Both PIDs came from this fixture; never use name-based cleanup.
    if(descendant){try{process.kill(descendant,"SIGKILL");}catch{}}
    await done;
  }
},15000);
