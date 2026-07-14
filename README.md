# Cottontail JavaScriptCore builds

This repository builds static JSCOnly artifacts from upstream WebKit release
tags for macOS ARM64, Windows x64, and Linux x64/ARM64. Windows 11 on ARM
runs the Windows x64 artifact through its built-in x64 emulation.

Supported builds use operating-system ICU libraries and data. JavaScriptCore is
compiled against the ICU 70 C API with ICU symbol renaming disabled:

- macOS links `libicucore`.
- Windows links the Windows 11 combined `icu.dll` through the Windows SDK.
- Linux links `libcottontail_icu.a`, a small ABI bridge which resolves the
  installed ICU's version-suffixed C symbols at startup. ICU 70 and newer are
  accepted.

The Linux bridge deliberately contains no ICU implementation or locale data.
When embedding the Linux static JavaScriptCore libraries, also link
`libcottontail_icu.a` and `libdl`.

Run the **Build JavaScriptCore (Cottontail)** workflow manually. With no input it
selects the most recently created upstream `WebKit-*` tag; an exact tag can also
be supplied. A prerelease is created only after every platform build and its
Intl smoke test succeeds.

Every artifact uses JSC's complete Baseline, DFG, FTL, and WebAssembly JIT
stack. Production builds omit the sampling profiler, remote inspector, and API
tests. There are no reduced-tier build profiles.
