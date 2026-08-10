import { createHash } from 'node:crypto';

export function revisionObjectKeys(rootPrefix, revision, platforms) {
  const prefix = `${rootPrefix}/builds/${revision}`;
  return [
    ...platforms.flatMap((platform) => [
      `${prefix}/${platform}/jsc.tar.gz`,
      `${prefix}/${platform}/jsc.tar.gz.sha256`,
    ]),
    `${prefix}/manifest.json`,
  ];
}

export async function publishImmutableRevision(entries, objectExists, put, prepare = async () => {}) {
  const occupied = (await Promise.all(entries.map(async ({ key }) =>
    await objectExists(key) ? key : null
  ))).filter(Boolean);

  if (occupied.length > 0) {
    throw new Error(
      `JSC build revision is already published or partially occupied; refusing to mutate it: ${occupied.join(', ')}`,
    );
  }

  await prepare();
  for (const entry of entries) {
    await put(entry, { ifNoneMatch: '*' });
  }
}

export async function ensureSharedObject(entry, expectedSha256, objectExists, get, put) {
  if (await objectExists(entry.key)) {
    const existing = await get(entry.key);
    const actualSha256 = sha256(existing);
    if (existing.length !== entry.body.length || actualSha256 !== expectedSha256) {
      throw new Error(
        `Existing shared R2 object does not match expected content: ${entry.key} ` +
        `(size ${existing.length}, sha256 ${actualSha256})`,
      );
    }
    return;
  }
  await put(entry, { ifNoneMatch: '*' });
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
