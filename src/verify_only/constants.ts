// Names shared by the verify-only path and the cycle-result reader.
// No imports: the reader can use these without pulling in the verify modules.

/** The digest contract that binds a change-set to a check. */
export const PATCH_DIGEST_ALGORITHM = "gs-patch-digest/v1" as const;

/** `verify.mode` value on a receipt written by `cycle verify`. */
export const VERIFY_MODE = "verify_only" as const;

/** Evidence file holding the frozen digest input (`D ++ U`) of a check. */
export const DIGEST_INPUT_FILENAME = "digest-input.bin" as const;
