#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

assert(process.argv[2], 'Usage: node scripts/test-embedder.js <native embedder fixture>');
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith('JSC_')) delete env[key];
const run = spawnSync(resolve(process.argv[2]), [], {
  encoding: 'utf8', env, timeout: 120_000, killSignal: 'SIGKILL', windowsHide: true,
});
assert.ifError(run.error);
assert.equal(run.status, 0,
  `Embedder test failed (${run.signal ?? run.status}):\n${run.stdout}\n${run.stderr}`);
assert(run.stdout.includes('concurrent contexts passed'), 'Embedder test did not finish');
process.stdout.write(run.stdout);
