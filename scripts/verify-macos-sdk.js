#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function verifyArchitecture(output, expected, file) {
  assert.equal(output.trim(), expected, `${file}: expected only ${expected}, got ${output.trim()}`);
}

export function verifyDeploymentTarget(output, maximum, file) {
  const versions = [];
  let command;
  for (const line of output.split('\n')) {
    const loadCommand = line.match(/^\s*cmd (LC_\S+)/);
    if (loadCommand) command = loadCommand[1];
    const version = line.match(/^\s*(minos|version) (\d+(?:\.\d+){0,2})\s*$/);
    if (version && ((command === 'LC_BUILD_VERSION' && version[1] === 'minos') ||
        (command === 'LC_VERSION_MIN_MACOSX' && version[1] === 'version'))) versions.push(version[2]);
  }
  assert(versions.length, `${file}: no macOS deployment target found`);
  const parts = value => value.split('.').map(Number);
  const limit = parts(maximum);
  for (const version of versions) {
    const actual = parts(version);
    let comparison = 0;
    for (let index = 0; index < 3 && comparison === 0; ++index) {
      comparison = (actual[index] || 0) - (limit[index] || 0);
    }
    assert(comparison <= 0, `${file}: deployment target ${version} exceeds ${maximum}`);
  }
}

export function verifySystemDependencies(output, file) {
  for (const line of output.split('\n')) {
    const dependency = line.match(/^\s+(\S+) \(compatibility version/);
    if (!dependency) continue;
    assert(dependency[1].startsWith('/usr/lib/') || dependency[1].startsWith('/System/Library/'),
      `${file}: non-system runtime dependency ${dependency[1]}`);
  }
}

function archives(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = join(directory, entry.name);
    return entry.isDirectory() ? archives(file) : /\.(a|dylib)$/.test(entry.name) ? [file] : [];
  });
}

export function verifySdk(sdk, architecture, minimum, embedder) {
  assert(['arm64', 'x86_64'].includes(architecture), `Unsupported macOS architecture: ${architecture}`);
  const files = [join(sdk, 'bin/jsc'), ...archives(join(sdk, 'lib')), ...(embedder ? [embedder] : [])];
  const inspect = (tool, args) => execFileSync('xcrun', [tool, ...args], {
    encoding: 'utf8', maxBuffer: 128 * 1024 * 1024,
  });
  for (const file of files) {
    verifyArchitecture(inspect('lipo', ['-archs', file]), architecture, file);
    verifyDeploymentTarget(inspect('otool', ['-l', file]), minimum, file);
    if (!file.endsWith('.a')) verifySystemDependencies(inspect('otool', ['-L', file]), file);
  }
  console.log(`Verified ${files.length} macOS SDK binaries: ${architecture}, deployment target <= ${minimum}, system dylibs only`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert(process.platform === 'darwin' && process.argv[4],
    'Usage on macOS: node scripts/verify-macos-sdk.js <sdk> <arm64|x86_64> <minimum macOS> [embedder fixture]');
  verifySdk(resolve(process.argv[2]), process.argv[3], process.argv[4], process.argv[5]);
}
