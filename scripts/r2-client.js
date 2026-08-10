import { createHash, createHmac } from 'node:crypto';

export function sha256(value) {
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

export function signedRequest({
  accountId,
  accessKeyId,
  secretAccessKey,
  bucket,
  method,
  key,
  body = Buffer.alloc(0),
  contentType,
  cacheControl,
  ifNoneMatch,
  now = new Date(),
}) {
  const endpoint = new URL(`https://${accountId}.r2.cloudflarestorage.com`);
  const canonicalUri = `/${[bucket, ...key.split('/')].map(awsEncode).join('/')}`;
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const payloadHash = sha256(body);
  const headers = {
    ...(cacheControl ? { 'cache-control': cacheControl } : {}),
    ...(contentType ? { 'content-type': contentType } : {}),
    host: endpoint.host,
    ...(ifNoneMatch ? { 'if-none-match': ifNoneMatch } : {}),
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  const signedHeaderNames = Object.keys(headers).sort();
  const signedHeaders = signedHeaderNames.join(';');
  const canonicalHeaders = signedHeaderNames
    .map((name) => `${name}:${headers[name]}\n`)
    .join('');
  const canonicalRequest = [method, canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${date}/auto/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  const dateKey = hmac(Buffer.from(`AWS4${secretAccessKey}`), date);
  const signingKey = hmac(hmac(hmac(dateKey, 'auto'), 's3'), 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  return {
    url: new URL(canonicalUri, endpoint).href,
    headers: {
      authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      ...Object.fromEntries(Object.entries(headers).filter(([name]) => name !== 'host')),
    },
  };
}

export function createR2Client({
  accountId,
  accessKeyId,
  secretAccessKey,
  bucket,
  dryRun = false,
  fetchImpl = fetch,
  log = console.log,
}) {
  const config = { accountId, accessKeyId, secretAccessKey, bucket };

  async function exists(key) {
    if (dryRun) {
      log(`dry-run HEAD ${key}`);
      return false;
    }
    const request = signedRequest({ ...config, method: 'HEAD', key });
    const response = await fetchImpl(request.url, { method: 'HEAD', headers: request.headers });
    if (response.status === 200) return true;
    if (response.status === 404) return false;
    throw new Error(`R2 preflight failed for ${key}: ${response.status} ${await response.text()}`);
  }

  async function get(key) {
    const request = signedRequest({ ...config, method: 'GET', key });
    const response = await fetchImpl(request.url, { method: 'GET', headers: request.headers });
    if (response.status !== 200) {
      throw new Error(`R2 read failed for ${key}: ${response.status} ${await response.text()}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  async function put(key, body, contentType, cacheControl, { ifNoneMatch } = {}) {
    if (dryRun) {
      log(`dry-run PUT ${key} (${body.length} bytes)${ifNoneMatch ? ` If-None-Match: ${ifNoneMatch}` : ''}`);
      return;
    }
    const request = signedRequest({
      ...config,
      method: 'PUT',
      key,
      body,
      contentType,
      cacheControl,
      ifNoneMatch,
    });
    const response = await fetchImpl(request.url, { method: 'PUT', headers: request.headers, body });
    if (!response.ok) {
      const detail = await response.text();
      if (ifNoneMatch && response.status === 412) {
        throw new Error(`Immutable R2 object already exists; refusing to replace ${key}`);
      }
      throw new Error(`R2 upload failed for ${key}: ${response.status} ${detail}`);
    }
    log(`uploaded ${key}`);
  }

  return { exists, get, put };
}
