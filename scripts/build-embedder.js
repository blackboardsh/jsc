#!/usr/bin/env node

import { execFileSync, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const buildDir = resolve(process.argv[2] || process.env.WEBKIT_OUTPUTDIR || join(root, "WebKitBuild"));
const outputDir = resolve(process.argv[3] || join(buildDir, "cottontail-embedder"));
const database = JSON.parse(readFileSync(join(buildDir, "compile_commands.json"), "utf8"));
const source = join(root, "bridge", "cottontail-jsc-embedder.cpp");
const header = join(root, "bridge", "cottontail-jsc-embedder.h");
const abiMatch = readFileSync(header, "utf8").match(/#define\s+CT_JSC_EMBEDDER_ABI_VERSION\s+(\d+)u?/);
if (!abiMatch) throw new Error("Could not read CT_JSC_EMBEDDER_ABI_VERSION from embedder header");
const abiVersion = Number(abiMatch[1]);
const object = join(outputDir, process.platform === "win32" ? "cottontail-jsc-embedder.obj" : "cottontail-jsc-embedder.o");
const library = join(outputDir, process.platform === "win32" ? "CottontailJSCEmbedder.lib" : "libCottontailJSCEmbedder.a");
const manifestPath = join(outputDir, "embedder-manifest.json");

mkdirSync(outputDir, { recursive: true });
rmSync(object, { force: true });
rmSync(library, { force: true });

const representative = database.find(entry =>
  /JavaScriptCore[/\\]API[/\\]JSStringRef\.cpp$/.test(entry.file)
) || database.find(entry =>
  /JavaScriptCore[/\\].*\.cpp$/.test(entry.file)
);
if (!representative?.command) {
  throw new Error("Could not find a JavaScriptCore C++ command in compile_commands.json");
}

const quote = value => process.platform === "win32"
  ? `"${value.replaceAll('"', '\\"')}"`
  : `'${value.replaceAll("'", "'\\''")}'`;
let command = representative.command;
if (process.platform === "win32") {
  command = command
    .replace(/(?:\/Fo|-o\s+)(?:"[^"]+"|\S+)/i, `/Fo${quote(object)}`)
    .replace(new RegExp(escapeRegExp(representative.file), "g"), quote(source));
  execSync(command, { cwd: representative.directory, stdio: "inherit", shell: "cmd.exe" });
  const librarian = process.env.LLVM_LIB || "llvm-lib";
  execFileSync(librarian, [`/OUT:${library}`, object], { stdio: "inherit" });
} else {
  command = command
    .replace(/-o\s+(?:'[^']+'|"[^"]+"|\S+)/, `-o ${quote(object)}`)
    .replace(new RegExp(escapeRegExp(representative.file), "g"), quote(source));
  execSync(command, { cwd: representative.directory, stdio: "inherit", shell: "/bin/sh" });
  execFileSync(process.env.AR || "ar", ["rcs", library, object], { stdio: "inherit" });
}

copyFileSync(header, join(outputDir, basename(header)));
const packagedHeader = join(outputDir, basename(header));
const sha256 = path => createHash("sha256").update(readFileSync(path)).digest("hex");
const webkitSha = execFileSync("git", ["-C", join(root, "WebKit"), "rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
writeFileSync(manifestPath, `${JSON.stringify({
  schema: 1,
  abiVersion,
  webkitSha,
  headerSha256: sha256(packagedHeader),
  sourceSha256: sha256(source),
  platform: `${process.platform}-${process.arch}`,
}, null, 2)}\n`);
console.log(JSON.stringify({ library, header: packagedHeader, manifest: manifestPath }));

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
