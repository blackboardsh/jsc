#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

let webkitRef = process.env.WEBKIT_REF?.trim();
if (!webkitRef) {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) {
    throw new Error(
      'GITHUB_TOKEN is required to select the newest WebKit tag by commit date. ' +
        'Set WEBKIT_REF to build an exact tag without a GitHub token.'
    );
  }
  let cursor = null;
  while (!webkitRef) {
    const response = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'user-agent': 'cottontail-jsc-builder',
      },
      body: JSON.stringify({
        query: `query LatestWebKitTag($cursor: String) {
          repository(owner: "WebKit", name: "WebKit") {
            refs(
              refPrefix: "refs/tags/"
              first: 100
              after: $cursor
              orderBy: { field: TAG_COMMIT_DATE, direction: DESC }
            ) {
              nodes { name }
              pageInfo { hasNextPage endCursor }
            }
          }
        }`,
        variables: { cursor },
      }),
    });
    if (!response.ok) throw new Error(`GitHub GraphQL request failed: ${response.status}`);
    const payload = await response.json();
    if (payload.errors?.length) throw new Error(`GitHub GraphQL request failed: ${payload.errors[0].message}`);
    const refs = payload.data.repository.refs;
    webkitRef = refs.nodes.find((tag) => /^WebKit-[A-Za-z0-9._-]+$/.test(tag.name))?.name;
    if (!refs.pageInfo.hasNextPage) break;
    cursor = refs.pageInfo.endCursor;
  }
}
if (!webkitRef || !/^WebKit-[A-Za-z0-9._-]+$/.test(webkitRef)) {
  throw new Error(`Unable to resolve a valid WebKit-* tag: ${webkitRef ?? '(empty)'}`);
}

const remote = execFileSync(
  'git',
  ['ls-remote', '--tags', 'https://github.com/WebKit/WebKit.git', `refs/tags/${webkitRef}`, `refs/tags/${webkitRef}^{}`],
  { encoding: 'utf8' }
).trim().split('\n').filter(Boolean);
if (remote.length === 0) throw new Error(`Upstream WebKit tag does not exist: ${webkitRef}`);
const peeled = remote.find((line) => line.endsWith(`refs/tags/${webkitRef}^{}`));
const webkitSha = (peeled ?? remote[0]).split(/\s+/)[0];

const metadata = {
  schema: 1,
  webkitRef,
  webkitSha,
  buildRevision: process.env.CIRCLE_SHA1 || execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
};
mkdirSync('build-metadata', { recursive: true });
writeFileSync('build-metadata/webkit.json', `${JSON.stringify(metadata, null, 2)}\n`);
console.log(`Building WebKit/WebKit ${webkitRef} at ${webkitSha}`);
