import assert from 'node:assert/strict';
import test from 'node:test';

import { createHash } from 'node:crypto';

import { ensureSharedObject, publishImmutableRevision, revisionObjectKeys } from './immutable-release.js';

const keys = revisionObjectKeys('jsc', 'a'.repeat(40), ['macos-arm64', 'linux-x64']);
const entries = keys.map((key) => ({ key, body: Buffer.from(key) }));

test('revision keys include archives, checksums, and the commit manifest last', () => {
  assert.deepEqual(keys, [
    `jsc/builds/${'a'.repeat(40)}/macos-arm64/jsc.tar.gz`,
    `jsc/builds/${'a'.repeat(40)}/macos-arm64/jsc.tar.gz.sha256`,
    `jsc/builds/${'a'.repeat(40)}/linux-x64/jsc.tar.gz`,
    `jsc/builds/${'a'.repeat(40)}/linux-x64/jsc.tar.gz.sha256`,
    `jsc/builds/${'a'.repeat(40)}/manifest.json`,
  ]);
});

test('a complete rerun fails before any mutation', async () => {
  const puts = [];
  let prepared = false;
  await assert.rejects(
    publishImmutableRevision(
      entries,
      async (key) => key.endsWith('/manifest.json'),
      async (entry) => puts.push(entry.key),
      async () => { prepared = true; },
    ),
    /already published or partially occupied/,
  );
  assert.deepEqual(puts, []);
  assert.equal(prepared, false);
});

test('a partial prior upload also fails before any mutation', async () => {
  const puts = [];
  await assert.rejects(
    publishImmutableRevision(
      entries,
      async (key) => key.endsWith('/linux-x64/jsc.tar.gz'),
      async (entry) => puts.push(entry.key),
    ),
    /linux-x64\/jsc\.tar\.gz/,
  );
  assert.deepEqual(puts, []);
});

test('a vacant revision conditionally creates every object with manifest last', async () => {
  const events = [];
  await publishImmutableRevision(
    entries,
    async () => false,
    async (entry, options) => events.push({ type: 'put', key: entry.key, options }),
    async () => events.push({ type: 'prepare' }),
  );
  assert.deepEqual(events, [
    { type: 'prepare' },
    ...keys.map((key) => ({ type: 'put', key, options: { ifNoneMatch: '*' } })),
  ]);
  assert.match(events.at(-1).key, /\/manifest\.json$/);
});

test('an existing shared object is verified rather than overwritten', async () => {
  const body = Buffer.from('shared ICU data');
  const expectedSha256 = createHash('sha256').update(body).digest('hex');
  const puts = [];
  await ensureSharedObject(
    { key: 'jsc/icu/70.1/icudt70l.dat', body },
    expectedSha256,
    async () => true,
    async () => body,
    async (...args) => puts.push(args),
  );
  assert.deepEqual(puts, []);

  await assert.rejects(
    ensureSharedObject(
      { key: 'jsc/icu/70.1/icudt70l.dat', body },
      expectedSha256,
      async () => true,
      async () => Buffer.from('corrupt'),
      async (...args) => puts.push(args),
    ),
    /does not match expected content/,
  );
  assert.deepEqual(puts, []);
});

test('an absent shared object is conditionally created', async () => {
  const entry = { key: 'jsc/icu/70.1/icudt70l.dat', body: Buffer.from('shared ICU data') };
  const puts = [];
  await ensureSharedObject(
    entry,
    createHash('sha256').update(entry.body).digest('hex'),
    async () => false,
    async () => assert.fail('GET must not run for an absent object'),
    async (...args) => puts.push(args),
  );
  assert.deepEqual(puts, [[entry, { ifNoneMatch: '*' }]]);
});
