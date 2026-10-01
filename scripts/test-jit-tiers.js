#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const binary = process.argv[2];
assert(binary, 'Usage: node scripts/test-jit-tiers.js <jsc binary>');
const fixture = fileURLToPath(new URL('../tests/jit-tiers.js', import.meta.url));
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (key.startsWith('JSC_')) delete env[key];
}

for (const tier of ['baseline', 'dfg', 'ftl']) {
  const result = spawnSync(binary, [
    '--useDollarVM=true',
    '--useJIT=true',
    `--useDFGJIT=${tier !== 'baseline'}`,
    `--useFTLJIT=${tier === 'ftl'}`,
    '--useConcurrentJIT=false',
    '--thresholdForJITAfterWarmUp=10',
    '--thresholdForOptimizeAfterWarmUp=100',
    '--thresholdForOptimizeAfterLongWarmUp=100',
    '--thresholdForOptimizeSoon=100',
    '--thresholdForFTLOptimizeAfterWarmUp=1000',
    '--thresholdForFTLOptimizeSoon=100',
    fixture, '--', tier,
  ], { encoding: 'utf8', env, timeout: 120_000, windowsHide: true });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${tier} execution failed (${result.signal ?? result.status}):\n${result.stdout}\n${result.stderr}`);
  assert(result.stdout.includes(`JIT tier ${tier} passed`), `${tier} did not confirm execution: ${result.stdout}`);
  process.stdout.write(result.stdout);
}

for (const tier of ['bbq', 'omg']) {
  const result = spawnSync(binary, [
    '--useDollarVM=true', '--useWasm=true', '--useConcurrentJIT=false',
    '--useBBQJIT=true', '--useBBQTierUpChecks=true',
    `--useOMGJIT=${tier === 'omg'}`,
    '--thresholdForBBQOptimizeAfterWarmUp=10',
    '--thresholdForOMGOptimizeAfterWarmUp=100',
    fileURLToPath(new URL('../tests/wasm-jit-tiers.js', import.meta.url)), '--', tier,
  ], { encoding: 'utf8', env, timeout: 120_000, windowsHide: true });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${tier} execution failed (${result.signal ?? result.status}):\n${result.stdout}\n${result.stderr}`);
  assert(result.stdout.includes(`Wasm tier ${tier} passed`), `${tier} did not confirm execution: ${result.stdout}`);
  process.stdout.write(result.stdout);
}
