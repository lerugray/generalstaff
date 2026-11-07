// A throwaway directory for a test, outside the repo checkout.
//
// Cycle and session code commit state/ in getRootDir(). A root under
// tests/fixtures/ sits inside this repo, so before v0.18.1 a test run could
// commit the developer's staged work. Test roots live in the OS temp dir
// instead. The path is realpath'd so it compares equal to what git and
// realpathSync report (macOS links /var to /private/var).

import { mkdtempSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

export function testTempDir(name: string): string {
  const safe = name.replace(/[^a-z0-9_-]/gi, "_");
  return mkdtempSync(join(realpathSync(tmpdir()), `gs-test-${safe}-`));
}
