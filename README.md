# Cottontail JavaScriptCore builds

This repository produces static JSCOnly SDKs from upstream WebKit release tags
for the Cottontail target matrix:

- macOS ARM64
- Linux x64
- Linux ARM64
- Windows x64 (also used through Windows-on-ARM x64 emulation)

Every SDK enables the complete Baseline, DFG, FTL, and WebAssembly JIT stack.
Sampling profiler, remote inspector, and API tests are disabled. There are no
reduced-tier build profiles.

## ICU contract

JSC is compiled against the unversioned ICU 70 C API. The SDK also includes a
static ICU 70.1 fallback implementation built with archive data packaging:

- executable fallback code: `lib/cottontail-icu/*.{a,lib}`
- checksum and ABI metadata: `lib/cottontail-icu/ICU_FALLBACK.json`
- separately published database: `jsc/icu/70.1/icudt70l.dat`

The database is deliberately absent from each SDK tarball, so it is neither
duplicated four times in R2 nor accidentally copied into downstream app bundles.

Cottontail links the fallback code into its own executable, probes the operating
system ICU first, and downloads the external database only when the installed
ICU is absent or older than ABI 70. The data file is architecture-independent,
and the build fan-in verifies that all four native ICU builds produced the exact
same SHA-256 before publishing one canonical copy.

The standalone Linux `jsc` shell uses the bridge under `bridge/` only for its
build-time smoke test. Runtime selection for an embedded JSC belongs to
Cottontail, and the required symbol contract is published under
`share/cottontail-jsc/`.

## GitHub Actions build and publishing

GitHub Actions resolves the newest upstream `WebKit-*` tag, checks out WebKit directly
with the large test suites excluded, and builds all four native targets. Set
the `webkit_ref` manual-workflow input to build an exact tag instead. Automatic
selection orders tags by upstream commit date rather than the numeric-looking tag name;
the workflow uses its built-in `GITHUB_TOKEN` to query GitHub's GraphQL API. No
custom GitHub token is required.

The workflow can also be run manually from `main`. A new publication requires a
new JSC repository commit: the repository revision is the immutable build key,
so rebuilding the same commit (including with a newer WebKit tag) is rejected.

The R2 publisher runs only after every build and Intl smoke test passes. It
uploads to the `electrobun-artifacts` bucket under `jsc/` and requires these
GitHub repository secrets:

- `JSC_R2_ACCOUNT_ID`
- `JSC_R2_ACCESS_KEY_ID`
- `JSC_R2_SECRET_ACCESS_KEY`

Configure this value as either a GitHub repository secret or variable. The
secret takes precedence when both exist:

- `JSC_R2_PUBLIC_BASE_URL` (for example `https://electrobun-artifacts.blackboard.sh`)

Published objects use immutable build paths:

- `jsc/builds/<jsc-repo-commit>/<platform>/jsc.tar.gz`
- `jsc/builds/<jsc-repo-commit>/manifest.json`
- `jsc/icu/70.1/icudt70l.dat`

Convenience pointers are updated only after the complete matrix is uploaded:

- `jsc/releases/<WebKit-tag>/manifest.json`
- `jsc/latest.json`

Pull requests build and retain GitHub Actions artifacts but skip R2. Run
`node scripts/upload-release-r2.js --dry-run` against a locally assembled
`release/` directory to validate the publication set without credentials.

## Local stack build

Run `node scripts/build-local-jsc.js` to produce the host SDK consumed by a
sibling Cottontail checkout. The command fingerprints committed and uncommitted
JSC/WebKit inputs, reuses an unchanged SDK, and preserves the generated
`WebKit`, `WebKitBuild`, and ICU build directories for local iteration.

The first invocation needs the same host dependencies as the corresponding
GitHub Actions build. Set `COTTONTAIL_ROOT` when the Cottontail checkout is not
at `../cottontail`. Set `DASH_LOCAL_REBUILD_JSC=1` or pass `--force` to rebuild
an otherwise current SDK.

On Unix, set `DASH_JSC_BUILD_JOBS` to a positive integer to bound local compiler
parallelism, for example `DASH_JSC_BUILD_JOBS=4 node scripts/build-local-jsc.js`.
The SDK uses regular static archives so copied libraries retain their object
files when consumed outside the WebKit build directory.

The Linux SDK build also runs an execution-watchdog regression:

```sh
node scripts/test-watchdog.js /absolute/path/to/jsc-sdk
```

It links the SDK's actual static JSC library and uses the same system ICU
bridge as the JSC shell. Separate native processes verify that callbacks can
explicitly reset or clear the execution limit, and that an unchanged false
return rearms the limit until a later callback interrupts a continuous loop.
Each process has an external five-second deadline. The watchdog patch is
applied to all SDK targets; this SDK test runner currently executes on Linux.
The patch clears the consumed CPU deadline before invoking the callback. This
prevents an expired deadline from being mistaken for a timer that the callback
explicitly restarted, while preserving callback-driven reset and clear behavior.

For the Linux timer lifetime fix, an existing pinned Cottontail SDK can also be
used for a small local static-library rebuild:

```sh
node scripts/rebuild-linux-runloop.js /absolute/path/to/published-sdk /new/local-sdk /absolute/path/to/cottontail/scripts/jsc-manifest.json
node scripts/test-red-black-tree.js /new/local-sdk
```

This verifies the SDK's source revision and published vendoring stamp, downloads
three source files at that exact WebKit commit, applies the maintained tree patch,
and recompiles `RunLoopGeneric.cpp.o` against the SDK's generated headers. It
copies the SDK, records input/output hashes and compiler arguments in
`share/cottontail-jsc/runloop-rebuild.json`, and changes only the copied static
timer object and tree header. The original SDK and its cached verification stamp
remain intact. The copied `bin/jsc` shell is unchanged; validate the fix by
relinking Cottontail against the copied static SDK. This helper is for local
iteration; the normal SDK build applies the patch to every translation unit.

The native regression exercises checked-pointer deletion and all 120 removal
orders of a five-node tree, including reuse after removal. Before the fix,
removing a parent and child then deleting the child first causes the parent's
destructor to abort. The same retained child reference caused Linux watchdog
timers to abort while opening editors in Dash Desktop.
An additional case schedules and stops actual `RunLoop` timers, then destroys
the child before the retained parent. It validates the linked `libWTF.a`, so a
patched header paired with a stale compiled timer object still fails the check.
