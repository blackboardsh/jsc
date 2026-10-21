import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyArchitecture, verifyDeploymentTarget, verifySystemDependencies } from './verify-macos-sdk.js';

test('a release archive must contain only the requested architecture', () => {
  verifyArchitecture('x86_64\n', 'x86_64', 'libJavaScriptCore.a');
  assert.throws(() => verifyArchitecture('arm64\n', 'x86_64', 'libJavaScriptCore.a'), /expected only x86_64/);
  assert.throws(() => verifyArchitecture('x86_64 arm64\n', 'x86_64', 'libJavaScriptCore.a'), /expected only x86_64/);
});

test('every archive member must support the deployment baseline', () => {
  const member = minimum => `Archive : libicuuc.a\nlibicuuc.a(member.o):\nLoad command 1\n      cmd LC_BUILD_VERSION\n  cmdsize 32\n platform 1\n    minos ${minimum}\n      sdk 26.0\n   ntools 1\n     tool 3\n  version 1230.0\n`;
  verifyDeploymentTarget(member('14.0') + member('13.0'), '14.0', 'libicuuc.a');
  assert.throws(() => verifyDeploymentTarget(member('14.0') + member('26.0'), '14.0', 'libicuuc.a'), /26.0 exceeds 14.0/);
  assert.throws(() => verifyDeploymentTarget(member('14.1'), '14.0', 'libicuuc.a'), /14.1 exceeds 14.0/);
  assert.throws(() => verifyDeploymentTarget('not a Mach-O file', '14.0', 'libicuuc.a'), /no macOS deployment target/);
});

test('legacy Mach-O minimum versions are checked too', () => {
  verifyDeploymentTarget('      cmd LC_VERSION_MIN_MACOSX\n  cmdsize 16\n  version 10.15\n      sdk 14.0\n', '14.0', 'legacy.o');
});

test('packaged executables must not load runner-installed libraries', () => {
  const dependency = path => `jsc:\n\t${path} (compatibility version 1.0.0, current version 1.0.0)\n`;
  verifySystemDependencies(dependency('/usr/lib/libicucore.A.dylib'), 'jsc');
  verifySystemDependencies(dependency('/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation'), 'jsc');
  for (const path of ['/usr/local/opt/icu/lib/libicuuc.dylib', '/opt/homebrew/lib/libicuuc.dylib', '@rpath/libicuuc.dylib']) {
    assert.throws(() => verifySystemDependencies(dependency(path), 'jsc'), /non-system runtime dependency/);
  }
});
