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

The committed workflow checks for a new upstream tag every Monday and can also
be run manually from `main`. The same fan-in and R2 publishing gate is used for
scheduled, pushed, and manual workflows.

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
