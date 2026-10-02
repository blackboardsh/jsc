#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [sdkArgument, llvmArgument, outputArgument] = process.argv.slice(2);
assert(process.platform === 'win32' && sdkArgument && llvmArgument && outputArgument,
  'Usage on Windows: node scripts/test-windows-embedder.js <SDK> <LLVM root> <test output>');
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sdk = resolve(sdkArgument);
const llvm = resolve(llvmArgument);
const output = resolve(outputArgument);
mkdirSync(output, { recursive: true });
const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
const clangVersion = readdirSync(join(llvm, 'lib/clang')).find(name => /^\d+$/.test(name));
assert(clangVersion, 'LLVM compiler runtime directory is missing');
const libraries = ['CottontailJSCEmbedder.lib', 'JavaScriptCore.lib', 'WTF.lib', 'bmalloc.lib'];
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith('JSC_')) delete env[key];
for (const [fixture, completed] of [
  ['embedder-jit', 'concurrent contexts passed'],
  ['windows-stack-precommit', 'recursion, and reentry passed'],
]) {
  const binary = join(output, `${fixture}.exe`);
  const args = [
    `/clang:--target=${arch}-pc-windows-msvc`, '/MT', '/O2', '/Gy', '/std:c++20', '/DJS_NO_EXPORT=1',
    `/I${join(sdk, 'include')}`, `/I${join(sdk, 'include/cottontail')}`,
    join(root, `tests/${fixture}.cpp`), `/Fo${join(output, `${fixture}.obj`)}`, `/Fe${binary}`,
    '-fuse-ld=lld', '/link', '/opt:ref', '/stack:33554432',
    ...libraries.map(name => join(sdk, 'lib', name)),
    join(llvm, 'lib/clang', clangVersion, `lib/windows/clang_rt.builtins-${arch}.lib`),
    'icu.lib', 'winmm.lib', 'dbghelp.lib', 'shlwapi.lib', 'ws2_32.lib',
    'kernel32.lib', 'user32.lib', 'gdi32.lib', 'shell32.lib', 'ole32.lib',
    'oleaut32.lib', 'uuid.lib', 'advapi32.lib',
  ];
  const compile = spawnSync(join(llvm, 'bin/clang-cl.exe'), args, { stdio: 'inherit', windowsHide: true, timeout: 120_000 });
  assert.ifError(compile.error);
  assert.equal(compile.status, 0, `Static SDK ${fixture} test failed to compile/link`);
  const run = spawnSync(binary, [], { encoding: 'utf8', windowsHide: true, timeout: 120_000, env });
  assert.ifError(run.error);
  assert.equal(run.status, 0, `${fixture} test failed (${run.signal ?? run.status}):\n${run.stdout}\n${run.stderr}`);
  assert(run.stdout.includes(completed), `${fixture} test did not finish`);
  process.stdout.write(run.stdout);
}
