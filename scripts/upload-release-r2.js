#!/usr/bin/env node

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  ensureSharedObject,
  publishImmutableRevision,
  revisionObjectKeys,
} from './immutable-release.js';
import { createR2Client, sha256 } from './r2-client.js';

const dryRun = process.argv.includes('--dry-run') || process.env.JSC_R2_DRY_RUN === '1';
const bucket = 'electrobun-artifacts';
const rootPrefix = 'jsc';
const publicBaseUrl = (process.env.JSC_R2_PUBLIC_BASE_URL ?? 'https://preview.invalid').replace(/\/+$/, '');
const expectedDataSha256 = '672dafc4940a0183cb48c3e369c1a0795cc8dfbf19951c86ced0ad78398f9480';
const matrix = {
  'macos-arm64': 'cottontail-jsc-macos-arm64',
  'linux-x64': 'cottontail-jsc-linux-amd64',
  'linux-arm64': 'cottontail-jsc-linux-arm64',
  'windows-x64': 'cottontail-jsc-windows-amd64',
};

function fail(message) {
  console.error(message);
  process.exit(1);
}
if (process.env.CIRCLECI === 'true' && process.env.CIRCLE_BRANCH !== 'main') {
  console.log(`Skipping R2 upload from ${process.env.CIRCLE_BRANCH ?? '(unknown branch)'}`);
  process.exit(0);
}
if (process.env.GITHUB_ACTIONS === 'true' && process.env.GITHUB_REF !== 'refs/heads/main') {
  console.log(`Skipping R2 upload from ${process.env.GITHUB_REF ?? '(unknown ref)'}`);
  process.exit(0);
}
const metadata = JSON.parse(readFileSync('build-metadata/webkit.json', 'utf8'));
const required = ['JSC_R2_ACCOUNT_ID', 'JSC_R2_ACCESS_KEY_ID', 'JSC_R2_SECRET_ACCESS_KEY', 'JSC_R2_PUBLIC_BASE_URL'];
if (!dryRun) {
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length) fail(`Missing R2 variables: ${missing.join(', ')}`);
}

const artifacts = Object.entries(matrix).map(([platform, base]) => {
  const archivePath = join('release', `${base}.tar.gz`);
  const checksumPath = `${archivePath}.sha256`;
  if (!existsSync(archivePath) || !existsSync(checksumPath)) fail(`Missing ${archivePath}`);
  const body = readFileSync(archivePath);
  const checksum = sha256(body);
  if (readFileSync(checksumPath, 'utf8').trim().split(/\s+/)[0].toLowerCase() !== checksum) {
    fail(`Checksum mismatch for ${archivePath}`);
  }
  const dataPath = join('release', `icudt70l-${platform}.dat`);
  if (!existsSync(dataPath) || sha256(readFileSync(dataPath)) !== expectedDataSha256) {
    fail(`ICU data mismatch for ${dataPath}`);
  }
  return { platform, body, checksum, size: statSync(archivePath).size };
});

const revision = metadata.buildRevision;
const publishedAt = new Date().toISOString();
const snapshotKey = (platform) => `${rootPrefix}/builds/${revision}/${platform}/jsc.tar.gz`;
const manifestObject = {
  schema: 1,
  name: 'cottontail-jsc',
  webkitRef: metadata.webkitRef,
  webkitSha: metadata.webkitSha,
  revision,
  publishedAt,
  icu: {
    version: '70.1',
    abi: 70,
    data: {
      url: `${publicBaseUrl}/${rootPrefix}/icu/70.1/icudt70l.dat`,
      sha256: expectedDataSha256,
      size: statSync('release/icudt70l-macos-arm64.dat').size,
    },
  },
  platforms: Object.fromEntries(artifacts.map((artifact) => [artifact.platform, {
    ...(artifact.platform === 'windows-x64' ? { msvcRuntime: 'MT' } : {}),
    archive: {
      url: `${publicBaseUrl}/${snapshotKey(artifact.platform)}`,
      sha256: artifact.checksum,
      size: artifact.size,
    },
  }])),
};
const manifest = Buffer.from(`${JSON.stringify(manifestObject, null, 2)}\n`);
const r2 = createR2Client({
  accountId: process.env.JSC_R2_ACCOUNT_ID ?? 'dry-run-account',
  accessKeyId: process.env.JSC_R2_ACCESS_KEY_ID ?? 'dry-run-key',
  secretAccessKey: process.env.JSC_R2_SECRET_ACCESS_KEY ?? 'dry-run-secret',
  bucket,
  dryRun,
});
const immutable = 'public, max-age=31536000, immutable';
const mutable = 'no-cache, no-store, must-revalidate';

const revisionEntries = artifacts.flatMap((artifact) => [{
  key: snapshotKey(artifact.platform),
  body: artifact.body,
  contentType: 'application/gzip',
}, {
  key: `${snapshotKey(artifact.platform)}.sha256`,
  body: Buffer.from(`${artifact.checksum}  jsc.tar.gz\n`),
  contentType: 'text/plain; charset=utf-8',
}]);
revisionEntries.push({
  key: `${rootPrefix}/builds/${revision}/manifest.json`,
  body: manifest,
  contentType: 'application/json; charset=utf-8',
});
const expectedRevisionKeys = revisionObjectKeys(rootPrefix, revision, artifacts.map(({ platform }) => platform));
if (revisionEntries.some(({ key }, index) => key !== expectedRevisionKeys[index])) {
  fail('Internal error: immutable JSC revision object set is inconsistent');
}

await publishImmutableRevision(
  revisionEntries,
  r2.exists,
  async ({ key, body, contentType }, options) =>
    await r2.put(key, body, contentType, immutable, options),
  async () => {
    const icuKey = `${rootPrefix}/icu/70.1/icudt70l.dat`;
    await ensureSharedObject(
      { key: icuKey, body: readFileSync('release/icudt70l-macos-arm64.dat') },
      expectedDataSha256,
      r2.exists,
      r2.get,
      async ({ key, body }, options) =>
        await r2.put(key, body, 'application/octet-stream', immutable, options),
    );
  },
);
await r2.put(`${rootPrefix}/releases/${metadata.webkitRef}/manifest.json`, manifest, 'application/json; charset=utf-8', mutable);
await r2.put(`${rootPrefix}/latest.json`, manifest, 'application/json; charset=utf-8', mutable);

console.log(JSON.stringify({ webkitRef: metadata.webkitRef, revision, platforms: Object.keys(matrix) }, null, 2));
