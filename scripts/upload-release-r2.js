#!/usr/bin/env node

import { createHash, createHmac } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const dryRun = process.argv.includes('--dry-run') || process.env.JSC_R2_DRY_RUN === '1';
const bucket = 'electrobun-artifacts';
const rootPrefix = 'jsc';
const publicBaseUrl = (process.env.JSC_R2_PUBLIC_BASE_URL ?? 'https://preview.invalid').replace(/\/+$/, '');
const metadata = JSON.parse(readFileSync('build-metadata/webkit.json', 'utf8'));
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
function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
function hmac(key, value) {
  return createHmac('sha256', key).update(value).digest();
}
function awsEncode(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
}
function signingHeaders({ accountId, accessKeyId, secretAccessKey, key, body, contentType, cacheControl }) {
  const endpoint = new URL(`https://${accountId}.r2.cloudflarestorage.com`);
  const canonicalUri = `/${[bucket, ...key.split('/')].map(awsEncode).join('/')}`;
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const payloadHash = sha256(body);
  const canonicalHeaders = `cache-control:${cacheControl}\ncontent-type:${contentType}\nhost:${endpoint.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'cache-control;content-type;host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = ['PUT', canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${date}/auto/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  const dateKey = hmac(Buffer.from(`AWS4${secretAccessKey}`), date);
  const signingKey = hmac(hmac(hmac(dateKey, 'auto'), 's3'), 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  return {
    url: new URL(canonicalUri, endpoint).href,
    headers: {
      Authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      'Cache-Control': cacheControl,
      'Content-Type': contentType,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    },
  };
}

async function put(config, key, body, contentType, cacheControl) {
  if (dryRun) {
    console.log(`dry-run PUT ${key} (${body.length} bytes)`);
    return;
  }
  const request = signingHeaders({ ...config, key, body, contentType, cacheControl });
  const response = await fetch(request.url, { method: 'PUT', headers: request.headers, body });
  if (!response.ok) throw new Error(`R2 upload failed for ${key}: ${response.status} ${await response.text()}`);
  console.log(`uploaded ${key}`);
}

if (process.env.CIRCLECI === 'true' && process.env.CIRCLE_BRANCH !== 'main') {
  console.log(`Skipping R2 upload from ${process.env.CIRCLE_BRANCH ?? '(unknown branch)'}`);
  process.exit(0);
}
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
    archive: {
      url: `${publicBaseUrl}/${snapshotKey(artifact.platform)}`,
      sha256: artifact.checksum,
      size: artifact.size,
    },
  }])),
};
const manifest = Buffer.from(`${JSON.stringify(manifestObject, null, 2)}\n`);
const config = {
  accountId: process.env.JSC_R2_ACCOUNT_ID ?? 'dry-run-account',
  accessKeyId: process.env.JSC_R2_ACCESS_KEY_ID ?? 'dry-run-key',
  secretAccessKey: process.env.JSC_R2_SECRET_ACCESS_KEY ?? 'dry-run-secret',
};
const immutable = 'public, max-age=31536000, immutable';
const mutable = 'no-cache, no-store, must-revalidate';

await put(config, `${rootPrefix}/icu/70.1/icudt70l.dat`, readFileSync('release/icudt70l-macos-arm64.dat'), 'application/octet-stream', immutable);
for (const artifact of artifacts) {
  await put(config, snapshotKey(artifact.platform), artifact.body, 'application/gzip', immutable);
  await put(config, `${snapshotKey(artifact.platform)}.sha256`, Buffer.from(`${artifact.checksum}  jsc.tar.gz\n`), 'text/plain; charset=utf-8', immutable);
}
await put(config, `${rootPrefix}/builds/${revision}/manifest.json`, manifest, 'application/json; charset=utf-8', immutable);
await put(config, `${rootPrefix}/releases/${metadata.webkitRef}/manifest.json`, manifest, 'application/json; charset=utf-8', mutable);
await put(config, `${rootPrefix}/latest.json`, manifest, 'application/json; charset=utf-8', mutable);

console.log(JSON.stringify({ webkitRef: metadata.webkitRef, revision, platforms: Object.keys(matrix) }, null, 2));
