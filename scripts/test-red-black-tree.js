#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sdk = process.argv[2] && resolve(process.argv[2]);
if (process.platform !== "linux" || !sdk) {
    throw new Error("Usage on Linux: node scripts/test-red-black-tree.js /absolute/path/to/jsc-sdk");
}
const directory = mkdtempSync(join(tmpdir(), "jsc-tree-test-"));
try {
    // The first case checks the installed header. The second calls the real
    // static-library timer implementation, catching stale objects compiled
    // before that header was patched (or with the wrong include order).
    for (const fixture of ["red-black-tree-detach", "runloop-timer-detach"]) {
        const binary = join(directory, fixture);
        const compile = spawnSync(process.env.CXX || "clang++", [
            "-std=c++23", "-O2", "-DNDEBUG", "-DBUILDING_JSCONLY__=1",
            "-fno-rtti", "-fno-exceptions", "-ffunction-sections", "-fdata-sections",
            `-I${join(sdk, "include")}`, `-I${join(sdk, "include/bmalloc")}`,
            join(root, `tests/${fixture}.cpp`),
            join(sdk, "lib/libWTF.a"), join(sdk, "lib/libbmalloc.a"),
            "-Wl,--gc-sections", "-pthread", "-ldl", "-o", binary,
        ], { stdio: "inherit" });
        if (compile.error) throw compile.error;
        if (compile.status !== 0) throw new Error(`${fixture} compile failed: ${compile.status}`);
        const run = spawnSync(binary, [], { stdio: "inherit", timeout: 30_000 });
        if (run.error) throw run.error;
        if (run.status !== 0) throw new Error(`${fixture} failed: ${run.signal || run.status}`);
    }
} finally {
    rmSync(directory, { recursive: true, force: true });
}
