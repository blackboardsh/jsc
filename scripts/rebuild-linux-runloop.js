#!/usr/bin/env node

// A local static-SDK iteration aid. The normal build applies the same maintained
// patch to every translation unit; this rebuilds only the affected timer object.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const [sdkValue, outputValue, manifestValue] = process.argv.slice(2);
if (process.platform !== "linux" || !sdkValue || !outputValue || !manifestValue) {
    throw new Error("Usage on Linux: node scripts/rebuild-linux-runloop.js SDK NEW_OUTPUT COTTONTAIL_JSC_MANIFEST");
}
const sdk = resolve(sdkValue);
const output = resolve(outputValue);
const manifestPath = resolve(manifestValue);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const platform = process.arch === "arm64" ? "linux-arm64" : process.arch === "x64" ? "linux-amd64" : null;
if (!platform || !manifest.assets[platform]) throw new Error("Unsupported native SDK architecture");
if (existsSync(output) || output.startsWith(`${sdk}${sep}`)) {
    throw new Error("Output must be a new directory outside the source SDK");
}
const revision = readFileSync(join(sdk, "WEBKIT_REVISION"), "utf8").trim();
if (revision !== manifest.upstreamCommit || !/^[a-f0-9]{40}$/.test(revision)) {
    throw new Error("SDK source revision differs from the supplied pinned manifest");
}
const stamp = readFileSync(join(sdk, ".jsc-vendored"), "utf8").trim();
if (!stamp.startsWith(`${manifest.tag} ${manifest.assets[platform].sha256} `)) {
    throw new Error("Expected an unmodified published SDK with its verified vendoring stamp");
}
const hash = (data) => createHash("sha256").update(data).digest("hex");
const hashFile = (path) => hash(readFileSync(path));
function run(command, args, options = {}) {
    const result = spawnSync(command, args, { stdio: "inherit", ...options });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${command} failed: ${result.signal || result.status}`);
    return result;
}

cpSync(sdk, output, { recursive: true });
writeFileSync(join(output, ".jsc-vendored"), "local-runloop build-in-progress\n");
const source = join(output, "share/cottontail-jsc/runloop-source");
const sources = {};
for (const path of ["Source/WTF/config.h", "Source/WTF/wtf/RedBlackTree.h", "Source/WTF/wtf/generic/RunLoopGeneric.cpp"]) {
    const url = `https://raw.githubusercontent.com/WebKit/WebKit/${revision}/${path}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Source download failed: ${response.status} ${url}`);
    const contents = Buffer.from(await response.arrayBuffer());
    const destination = join(source, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, contents);
    sources[path] = { url, sha256: hash(contents) };
}
const header = "Source/WTF/wtf/RedBlackTree.h";
if (sources[header].sha256 !== hashFile(join(sdk, "include/wtf/RedBlackTree.h"))) {
    throw new Error("Installed tree header differs from the pinned upstream source");
}
const patch = join(root, "patches/red-black-tree-detach-node.patch");
run("git", ["apply", "--check", patch], { cwd: source });
run("git", ["apply", patch], { cwd: source });
cpSync(join(source, header), join(output, "include/wtf/RedBlackTree.h"));

const object = join(source, "RunLoopGeneric.cpp.o");
const compiler = process.env.CXX || "clang++";
const args = [
    "-std=c++23", "-O2", "-DNDEBUG", "-DBUILDING_JSCONLY__=1",
    "-DBUILDING_WITH_CMAKE=1", "-DHAVE_CONFIG_H=1", "-DU_DISABLE_RENAMING=1",
    "-fno-rtti", "-fno-exceptions", "-fPIC",
    `-I${join(source, "Source/WTF")}`, `-I${join(output, "include")}`,
    `-I${join(output, "include/bmalloc")}`,
    "-c", join(source, "Source/WTF/wtf/generic/RunLoopGeneric.cpp"), "-o", object,
];
run(compiler, args);
const archive = join(output, "lib/libWTF.a");
run(process.env.AR || "ar", ["r", archive, object]);
run(process.execPath, [join(root, "scripts/test-red-black-tree.js"), output]);

const provenance = {
    purpose: "Local Cottontail static relink; timer object only. The SDK's standalone bin/jsc is unchanged.",
    platform, sourceSDK: sdk, publishedVendoringStamp: stamp,
    publishedAsset: manifest.assets[platform], upstreamCommit: revision,
    jscBuildRevision: manifest.jscBuildRevision,
    manifestSha256: hashFile(manifestPath), patchSha256: hashFile(patch), sources,
    compiler, compilerVersion: spawnSync(compiler, ["--version"], { encoding: "utf8" }).stdout.trim(),
    compilerArguments: args, generatedConfigSha256: hashFile(join(output, "include/cmakeconfig.h")),
    archiveBeforeSha256: hashFile(join(sdk, "lib/libWTF.a")), archiveAfterSha256: hashFile(archive),
    replacedMember: "RunLoopGeneric.cpp.o", objectSha256: hashFile(object),
};
// Do not let this local derivative masquerade as the checksum-verified SDK.
writeFileSync(join(output, ".jsc-vendored"), `local-runloop ${provenance.archiveAfterSha256}\n`);
writeFileSync(join(output, "share/cottontail-jsc/runloop-rebuild.json"), `${JSON.stringify(provenance, null, 2)}\n`);
console.log(`Local timer SDK: ${output}`);
