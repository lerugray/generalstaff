// Run by state.test.ts in an isolated POSIX process with a tiny file-size
// limit. Unlike a permissions error, EFBIG happens after temp creation.
import { setRootDir, loadFleetState, updateProjectFleetState, saveFleetState } from "../../src/state";

process.on("SIGXFSZ", () => {});
setRootDir(process.argv[2]!);
const fleet = await loadFleetState();
updateProjectFleetState(fleet, "x".repeat(100_000), "verified", 1);
try {
  await saveFleetState(fleet);
  throw new Error("Expected a partial-write failure under the fixture file-size limit");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "EFBIG") throw error;
  console.log("EFBIG");
}
