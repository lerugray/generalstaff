// Preflight refusals for `generalstaff cycle verify`.
//
// A refusal means the check never started: nonzero exit, one scrubbed reason
// line, and NO receipt (no cycle_start, no cycle_end). Each refusal has a
// stable machine code; the human message is for people only.

import { BundleError, type BundleErrorCode } from "./bundle";
import { DigestError, type DigestErrorCode } from "./digest";
import { GitReapError, scrubLine } from "./git";

export type RefusalCode =
  | "invalid_argument"
  | "project_not_registered"
  | "checkout_invalid"
  | "base_unresolvable"
  | "bundle_missing"
  | "bundle_empty"
  | "bundle_unreadable"
  | "bundle_escapes"
  | "bundle_extra_files"
  | "snapshot_limit"
  | "unsupported_digest_algorithm"
  | "digest_mismatch"
  | "excludes_mismatch"
  | "empty_patch"
  | "no_verification_command"
  | "verify_in_progress"
  | "materialize_failed"
  | "git_reap_failed"
  | "interrupted"
  | "internal_error";

export class VerifyRefusal extends Error {
  constructor(
    public readonly code: RefusalCode,
    message: string,
  ) {
    super(message);
    this.name = "VerifyRefusal";
  }
}

/** The single scrubbed line printed for a refusal. */
export function refusalLine(refusal: VerifyRefusal): string {
  return scrubLine(refusal.message);
}

const BUNDLE_CODE_MAP: Partial<Record<BundleErrorCode | DigestErrorCode, RefusalCode>> = {
  git_reap_failed: "git_reap_failed",
  bundle_missing: "bundle_missing",
  bundle_empty: "bundle_empty",
  bundle_unreadable: "bundle_unreadable",
  bundle_escapes: "bundle_escapes",
  bundle_too_deep: "snapshot_limit",
  untracked_symlink: "bundle_escapes",
  empty_patch: "empty_patch",
  file_too_large: "snapshot_limit",
  too_many_untracked: "snapshot_limit",
  diff_too_large: "snapshot_limit",
  checkout_invalid: "checkout_invalid",
  revision_invalid: "invalid_argument",
  exclude_invalid: "invalid_argument",
};

/** Turn a bundle or digest error into a refusal. Other errors pass through. */
export function toRefusal(err: unknown): unknown {
  if (err instanceof VerifyRefusal) return err;
  if (err instanceof GitReapError) return new VerifyRefusal(err.code, err.message);
  if (err instanceof BundleError || err instanceof DigestError) {
    const code = BUNDLE_CODE_MAP[err.code] ?? "materialize_failed";
    return new VerifyRefusal(code, err.message);
  }
  return err;
}
