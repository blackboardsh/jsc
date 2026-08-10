import assert from "node:assert/strict";
import test from "node:test";

import { rewriteCompileCommand } from "./embedder-command.mjs";

test("rewrites Windows commands when compile database and command use different slashes", () => {
  const command = [
    "C:\\LLVM\\bin\\clang-cl.exe",
    "/nologo",
    '/Fo"D:\\a\\jsc\\jsc\\WebKitBuild\\Release\\JavaScriptCore\\CMakeFiles\\jsc.dir\\jsc.cpp.obj"',
    "/c",
    '"D:\\a\\jsc\\jsc\\WebKit\\Source\\JavaScriptCore\\jsc.cpp"',
  ].join(" ");

  const rewritten = rewriteCompileCommand({
    command,
    directory: "D:/a/jsc/jsc/WebKitBuild/Release",
    originalSource: "D:/a/jsc/jsc/WebKit/Source/JavaScriptCore/jsc.cpp",
    source: "D:\\a\\jsc\\jsc\\bridge\\cottontail-jsc-embedder.cpp",
    object: "D:\\a\\jsc\\jsc\\WebKitBuild\\Release\\cottontail-embedder\\cottontail-jsc-embedder.obj",
    platform: "win32",
  });

  assert.match(rewritten, /bridge\\cottontail-jsc-embedder\.cpp/);
  assert.match(rewritten, /cottontail-embedder\\cottontail-jsc-embedder\.obj/);
  assert.match(rewritten, /\/DSTATICALLY_LINKED_WITH_JavaScriptCore/);
  assert.doesNotMatch(rewritten, /JavaScriptCore\\jsc\.cpp/);
});

test("rewrites a relative Windows source using its basename fallback", () => {
  const rewritten = rewriteCompileCommand({
    command: 'clang-cl.exe /Foout\\old.obj /c "..\\..\\Source\\JavaScriptCore\\API\\JSStringRef.cpp"',
    directory: "D:/build/JavaScriptCore",
    originalSource: "D:/source/Source/JavaScriptCore/API/JSStringRef.cpp",
    source: "D:/source/bridge/cottontail-jsc-embedder.cpp",
    object: "D:/build/cottontail-jsc-embedder.obj",
    platform: "win32",
  });

  assert.equal(
    rewritten,
    'clang-cl.exe /Fo"D:/build/cottontail-jsc-embedder.obj" /c /DSTATICALLY_LINKED_WITH_JavaScriptCore "D:/source/bridge/cottontail-jsc-embedder.cpp"',
  );
});

test("inserts the Windows static definition before an end-of-options marker", () => {
  const rewritten = rewriteCompileCommand({
    command: 'clang-cl.exe /Foout\\old.obj /c -- "D:\\src\\source.cpp"',
    directory: "D:/build",
    originalSource: "D:/src/source.cpp",
    source: "D:/src/embedder.cpp",
    object: "D:/build/embedder.obj",
    platform: "win32",
  });

  assert.equal(
    rewritten,
    'clang-cl.exe /Fo"D:/build/embedder.obj" /c /DSTATICALLY_LINKED_WITH_JavaScriptCore -- "D:/src/embedder.cpp"',
  );
});

test("does not duplicate the Windows static JavaScriptCore definition", () => {
  const rewritten = rewriteCompileCommand({
    command: "clang-cl.exe /DSTATICALLY_LINKED_WITH_JavaScriptCore /Foout\\old.obj /c source.cpp",
    directory: "D:/build",
    originalSource: "source.cpp",
    source: "embedder.cpp",
    object: "embedder.obj",
    platform: "win32",
  });

  assert.equal(
    rewritten.match(/STATICALLY_LINKED_WITH_JavaScriptCore/g)?.length,
    1,
  );
});

test("rewrites Unix compiler commands", () => {
  const rewritten = rewriteCompileCommand({
    command: "clang++ -O3 -o '/tmp/old.o' -c '/src/Source/JavaScriptCore/API/JSStringRef.cpp'",
    directory: "/build",
    originalSource: "/src/Source/JavaScriptCore/API/JSStringRef.cpp",
    source: "/src/bridge/cottontail-jsc-embedder.cpp",
    object: "/build/cottontail-jsc-embedder.o",
    platform: "darwin",
  });

  assert.equal(
    rewritten,
    "clang++ -O3 -o '/build/cottontail-jsc-embedder.o' -c '/src/bridge/cottontail-jsc-embedder.cpp'",
  );
});

test("rejects commands without a compiler output", () => {
  assert.throws(() => rewriteCompileCommand({
    command: "clang-cl.exe /c source.cpp",
    directory: "D:/build",
    originalSource: "source.cpp",
    source: "embedder.cpp",
    object: "embedder.obj",
    platform: "win32",
  }), /Could not replace compiler output/);
});

test("rejects commands where the original source cannot be identified", () => {
  assert.throws(() => rewriteCompileCommand({
    command: "clang++ -o old.o -c unrelated.cpp",
    directory: "/build",
    originalSource: "/src/expected.cpp",
    source: "/src/embedder.cpp",
    object: "/build/embedder.o",
    platform: "linux",
  }), /Could not uniquely replace source/);
});
