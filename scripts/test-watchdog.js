#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sdk = process.argv[2] && resolve(process.argv[2]);
if (process.platform !== "linux" || !sdk) {
    throw new Error("Usage on Linux: node scripts/test-watchdog.js /absolute/path/to/jsc-sdk");
}
const directory = mkdtempSync(join(tmpdir(), "jsc-watchdog-test-"));
try {
    const binary = join(directory, "watchdog-rearm");
    const bridge = [];
    for (const source of ["linux-loader.c", "linux-trampolines.S"]) {
        const object = join(directory, `${source}.o`);
        const compile = spawnSync(process.env.CC || "clang", [
            "-O2", "-fPIC", `-I${join(root, "bridge")}`, "-DCOTTONTAIL_ICU_MIN_VERSION=70",
            "-c", join(root, "bridge", source), "-o", object,
        ], { stdio: "inherit" });
        if (compile.error) throw compile.error;
        if (compile.status !== 0) throw new Error(`ICU test bridge compile failed: ${compile.status}`);
        bridge.push(object);
    }
    const compile = spawnSync(process.env.CXX || "clang++", [
        "-std=c++23", "-O2", "-DNDEBUG", "-DBUILDING_JSCONLY__=1", "-DJS_NO_EXPORT=1",
        "-fno-rtti", "-fno-exceptions", "-ffunction-sections", "-fdata-sections",
        `-I${join(sdk, "include")}`, `-I${join(sdk, "include/bmalloc")}`,
        join(root, "tests/watchdog-rearm.cpp"),
        ...bridge,
        "-Wl,--start-group", ...[
            "libJavaScriptCore.a", "libWTF.a", "libbmalloc.a",
        ].map(library => join(sdk, "lib", library)), "-Wl,--end-group",
        "-Wl,--gc-sections", "-pthread", "-ldl", "-latomic", "-o", binary,
    ], { stdio: "inherit" });
    if (compile.error) throw compile.error;
    if (compile.status !== 0) throw new Error(`watchdog regression compile failed: ${compile.status}`);
    let failures = 0;
    const runtimeEnv = { ...process.env };
    // Keep build controls out of the engine's JSC_* runtime-option parser.
    for (const key of ["JSC_LOCAL_BUILD", "JSC_LOCAL_ICU_KEY", "JSC_ALLOW_WEBKIT_FORK"]) delete runtimeEnv[key];
    for (const mode of ["reset", "clear", "continue"]) {
        // The fixture owns no subprocesses. Bound the whole native process:
        // an in-VM timeout cannot protect a broken execution watchdog.
        const run = spawnSync(binary, [mode], { stdio: "inherit", env: runtimeEnv, timeout: 5_000, killSignal: "SIGKILL" });
        if (run.error || run.status !== 0) {
            ++failures;
            console.error(`FAIL: watchdog ${mode}: ${run.error?.message || run.signal || run.status}`);
        }
    }
    if (failures) throw new Error(`${failures} watchdog regression(s) failed`);
} finally {
    rmSync(directory, { recursive: true, force: true });
}
