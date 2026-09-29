# gs-patch-digest/v1

The identity of an uncommitted change-set: one `sha256:` value that names
exactly what a check verified. Anything that binds a change-set to a check
(`generalstaff cycle verify`, or a program wrapping it) must reproduce this
digest byte for byte. The vector file `tests/fixtures/gs-patch-digest-v1/vectors.json`
is the authority; this document explains it.

**Algorithm id:** `gs-patch-digest/v1`  
**Implementation:** `src/verify_only/digest.ts` (`collectChangeset`)  
**Vectors:** `tests/fixtures/gs-patch-digest-v1/vectors.json`  
**Independent restatement used by the tests:** `tests/helpers/digest_vectors.ts` (`oracleDigest`)

## 1. Definition

```
digest = "sha256:" + hex( sha256( D ++ U ) )
```

The input is the byte concatenation `D ++ U`. It is also stored, as written, as
the `digest-input.bin` evidence file of a verify-only cycle (see
[verify-only-cycle.md](./verify-only-cycle.md)).

### D: the tracked side

The exact stdout of one `git` invocation run in the checkout's top-level
directory:

```
git --no-pager
    -c core.hooksPath=<null device>   -c core.fsmonitor=false
    -c core.attributesFile=<null device>
    -c core.autocrlf=false            -c core.quotePath=true
    -c diff.external=                 -c diff.noprefix=false
    -c diff.algorithm=myers           -c diff.context=3
    -c diff.renames=true              -c diff.renameLimit=1000
    -c diff.indentHeuristic=true      -c diff.interHunkContext=0
    -c diff.mnemonicPrefix=false      -c diff.suppressBlankEmpty=false
    -c diff.srcPrefix=a/              -c diff.dstPrefix=b/
    -c diff.ignoreSubmodules=none     -c diff.submodule=short
    -c diff.orderFile=<null device>
    diff --no-color --no-ext-diff --no-textconv --full-index
    <base> -- [. ":(exclude,literal)<path>"...]
```

- `<base>` is the commit the change-set is measured against (7 to 64 hex
  characters at this layer; `cycle verify` requires the full id).
- The working tree is compared with `<base>`. Staged and unstaged changes
  together produce the same bytes: staging never moves the digest.
- The trailing pathspec (`.` and one `:(exclude,literal)` entry per exclusion,
  sorted by UTF-8 bytes) is present only when there are exclusions.
- `--full-index` puts the full object id of both sides on every `index` line.
  For a binary file, which git prints only as "Binary files ... differ", those
  ids are what bind its content.
- The environment is cleared to `PATH`, `HOME`, `USER`, `LOGNAME`, `LANG`,
  `LC_ALL`, `LC_CTYPE`, `TMPDIR`, `TMP`, `TEMP` (plus the Windows system
  variables), with `GIT_CONFIG_NOSYSTEM=1` and the user and system config files
  pointed at the null device. Repository-local configuration cannot change the
  bytes: every setting that affects diff text is pinned above. ONE user setting
  is not cleared away but carried in explicitly: the caller resolves its
  effective global excludes file once per run (`core.excludesFile` from the
  user's normal git config if set; else `$XDG_CONFIG_HOME/git/ignore` when
  `XDG_CONFIG_HOME` is set and non-empty (and only that: `$HOME/.config` is not
  consulted then, as in git); else `$HOME/.config/git/ignore`; else none) and pins it on every git call here as
  `-c core.excludesFile=<resolved path or the null device>`. The resolved path
  and the SHA-256 of its bytes are recorded with the receipt, so a reader can
  see exactly which third ignore source was in force. An indeterminate answer
  from git config is refused, never guessed past.
- The invocation must not write to the checkout. `git diff` refreshes and
  rewrites the index, so an implementation points `GIT_INDEX_FILE` at a private
  copy of the checkout's index for the duration.
- D is hashed as raw bytes. It need not be valid UTF-8.
- Output larger than the diff cap (default 8 MiB) is refused, never cut.

### U: the untracked side

`git ls-files --others --exclude-standard -z` in the same directory (same
environment, same private index, same `core.excludesFile` pin) lists exactly
the untracked, non-ignored files. Ignored files never appear, so they cannot
move the digest. `--exclude-standard` consults three ignore sources: the tree's
own `.gitignore` files, `.git/info/exclude`, and the pinned global excludes
file above. U is defined relative to that *effective* exclude set — the pinned
and recorded one, not the user's ambient config — so a locally-ignored file
stays out of the change-set, the bundle and the verify tree on every machine
that runs the check.

1. Drop excluded paths (section 3).
2. Sort the remaining paths by the UTF-8 bytes of the path (not by locale, not
   by UTF-16 code units).
3. For each path emit two lines, each ending in a single `\n`:

```
gs-untracked-file: <path>
gs-content-sha256:<64 lowercase hex sha256 of the file's bytes>
```

U is the concatenation of those records, or empty when there are none.

Rules for the files themselves:

- Paths must be valid UTF-8 and contain no control character (in particular no
  newline, which would let one path forge a neighbour's record).
- A symlink is refused, never followed. The refusal is enforced by opening the
  file without following links, not only by a pre-check.
- An entry that is not a regular file (a nested repository, a device) is refused.
- A file over the size cap (default 64 MiB), or more files than the count cap
  (default 4096), is refused, never truncated or sampled.
- File modes, timestamps and ownership are not part of the digest.

## 2. The empty change-set

D and U both empty: the digest is `sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`,
the SHA-256 of zero bytes. `cycle verify` refuses to check an empty change-set.

## 3. Exclusions

A caller may name repo-relative paths that are left out of both D and U (for
example scaffold a tool wrote into the checkout). Each is normalized to forward
slashes with one trailing slash removed, and must not be empty, absolute, or
contain `.` or `..` segments. An exclusion hides only its own path and paths
below it, never an ancestor: excluding `foo/bar/baz` does not hide a file named
`foo` that replaces the `foo/` directory.

## 4. The transport form (not hashed)

A bundle carries its tracked side as `git diff --binary` with the same pins
(binary-capable, applied with `git apply`). Binary patch payloads depend on the
compression library, so they are never hashed. A check applies the transport
patch to a clean worktree, copies the bundled untracked files in, and then
recomputes D and U from that worktree with the definitions above. The
recomputed digest, compared with the digest the caller bound, is what proves
the bundle is the change-set.

## 5. Refusal codes

An implementation refuses (throws) rather than return a digest for:

| Code | Cause |
| --- | --- |
| `checkout_invalid` | checkout path not absolute, not traversal-free, or not a directory |
| `revision_invalid` | base not 7 to 64 hex characters |
| `exclude_invalid` | an exclusion path that is not clean and repo-relative |
| `git_missing`, `git_failed`, `git_timeout` | git could not run, failed, or ran out of time |
| `diff_too_large` | D over the cap |
| `too_many_untracked` | more untracked files than the cap |
| `file_too_large` | one untracked file over the cap |
| `untracked_symlink` | an untracked symlink |
| `untracked_unreadable` | an untracked entry that is missing, unreadable or not a regular file |
| `untracked_path_invalid` | a path with a control character or a non-repo-relative shape |
| `path_not_utf8` | an untracked path that is not valid UTF-8 |
| `copy_failed` | an untracked file could not be read or copied; maps to `materialize_failed` in `cycle verify` |

The vector file's `refuse` entries use these codes. The caps are parameters:
the vector `limits` object lowers them so the refusals can be tested without
huge files. An implementation must expose the same three limits for testing
(`maxDiffBytes`, `maxUntrackedFiles`, `maxUntrackedFileBytes`).

## 6. The vector file

`vectors.json` is language neutral. Each vector describes a base commit
(`base`: files as UTF-8 `text` or `base64`), a list of working-tree `steps`
(`write`, `delete`, `stage`, `rename`, `symlink`), optional `exclude`,
`limits` and `globalExcludes`, and an `expect`. `globalExcludes` is
`{source, text}`: `config` puts `text` in a file that the user's global git
config names as `core.excludesFile`; `xdg` sets `XDG_CONFIG_HOME` and puts
`text` in `$XDG_CONFIG_HOME/git/ignore` with no `core.excludesFile`; `none`
has no global excludes file. The implementation resolves it as in section 2
and pins the result:

| `expect` | Meaning |
| --- | --- |
| `digest` | the exact digest (present for every vector that does not refuse) |
| `sameAs` / `differsFrom` | another vector's id: the digest must equal / differ from that vector's |
| `refuse` | a refusal code from section 5 |
| `diffContains` | a substring D must contain (proves the case exercised what it claims) |

Vectors marked `posixOnly` need symlinks or paths Windows cannot hold. To build
a vector's repository: `git init`, write the `base` files, commit them, then
apply the `steps` in sequence. The base commit id is not part of the digest, so
any commit with those files yields the same value.

Every digest in the file was produced by the independent restatement in
`tests/helpers/digest_vectors.ts` (plain `git` plus `sha256`, sharing no code
with the implementation) and is checked against the implementation on every
test run. An implementation in another language passes when it reproduces every
`digest`, `sameAs`, `differsFrom` and `refuse`.

## 7. Versioning

The algorithm id is part of every receipt (`identity.patchDigestAlgorithm`). Any
change to the bytes hashed is a new id (`gs-patch-digest/v2`); readers must not
guess and refuse ids they do not know.
