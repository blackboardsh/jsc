import assert from 'node:assert/strict';
import test from 'node:test';

import { createR2Client, signedRequest } from './r2-client.js';

const config = {
  accountId: 'account',
  accessKeyId: 'access',
  secretAccessKey: 'secret',
  bucket: 'bucket',
};

function response(status, text = '') {
  return { status, ok: status >= 200 && status < 300, text: async () => text };
}

test('HEAD treats only 200 as occupied and 404 as vacant', async () => {
  for (const [status, expected] of [[200, true], [404, false]]) {
    const client = createR2Client({ ...config, fetchImpl: async () => response(status) });
    assert.equal(await client.exists('jsc/builds/revision/manifest.json'), expected);
  }
  for (const status of [204, 403, 500]) {
    const client = createR2Client({ ...config, fetchImpl: async () => response(status, 'failure') });
    await assert.rejects(client.exists('jsc/builds/revision/manifest.json'), new RegExp(`${status} failure`));
  }
});

test('conditional PUT signs If-None-Match and a 412 hard-fails', async () => {
  const request = signedRequest({
    ...config,
    method: 'PUT',
    key: 'jsc/builds/revision/manifest.json',
    body: Buffer.from('manifest'),
    ifNoneMatch: '*',
    now: new Date('2026-08-10T12:00:00.000Z'),
  });
  assert.equal(
    request.url,
    'https://account.r2.cloudflarestorage.com/bucket/jsc/builds/revision/manifest.json',
  );
  assert.equal(request.headers['if-none-match'], '*');
  assert.match(request.headers.authorization, /SignedHeaders=.*if-none-match/);

  const client = createR2Client({ ...config, fetchImpl: async () => response(412, 'PreconditionFailed') });
  await assert.rejects(
    client.put('jsc/builds/revision/manifest.json', Buffer.from('manifest'), 'application/json', 'immutable', { ifNoneMatch: '*' }),
    /refusing to replace/,
  );
});

test('dry-run performs no network requests and preserves conditional intent', async () => {
  const logs = [];
  const client = createR2Client({
    ...config,
    dryRun: true,
    fetchImpl: async () => assert.fail('dry-run must not use the network'),
    log: (message) => logs.push(message),
  });
  assert.equal(await client.exists('jsc/builds/revision/manifest.json'), false);
  await client.put(
    'jsc/builds/revision/manifest.json',
    Buffer.from('manifest'),
    'application/json',
    'immutable',
    { ifNoneMatch: '*' },
  );
  assert.deepEqual(logs, [
    'dry-run HEAD jsc/builds/revision/manifest.json',
    'dry-run PUT jsc/builds/revision/manifest.json (8 bytes) If-None-Match: *',
  ]);
});
