import { describe, expect, it } from "bun:test";
import {
  GENERALSTAFF_TASK_CLAIM_PREFIX,
  parseTaskClaimFromEngineerStdout,
} from "../src/prompts/engineer_claim";

describe("parseTaskClaimFromEngineerStdout (gs-291)", () => {
  it("returns undefined for empty stdout", () => {
    expect(parseTaskClaimFromEngineerStdout("")).toBeUndefined();
  });

  it("parses a single claim line", () => {
    const line = `${GENERALSTAFF_TASK_CLAIM_PREFIX}{"attempted_task_id":"gs-100"}`;
    expect(parseTaskClaimFromEngineerStdout(`banner\n${line}\n`)).toBe("gs-100");
  });

  it("keeps the last claim when multiple lines match", () => {
    const a = `${GENERALSTAFF_TASK_CLAIM_PREFIX}{"attempted_task_id":"first"}`;
    const b = `${GENERALSTAFF_TASK_CLAIM_PREFIX}{"attempted_task_id":"second"}`;
    expect(parseTaskClaimFromEngineerStdout(`${a}\n${b}`)).toBe("second");
  });

  it("ignores malformed JSON after the prefix", () => {
    const bad = `${GENERALSTAFF_TASK_CLAIM_PREFIX}{not json`;
    const good = `${GENERALSTAFF_TASK_CLAIM_PREFIX}{"attempted_task_id":"ok"}`;
    expect(parseTaskClaimFromEngineerStdout(`${bad}\n${good}`)).toBe("ok");
  });

  it("ignores lines with wrong prefix", () => {
    expect(
      parseTaskClaimFromEngineerStdout(`echo {"attempted_task_id":"x"}\n`),
    ).toBeUndefined();
  });
});
