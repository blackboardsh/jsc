import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

test('Windows autocrlf checkouts preserve valid WebKit patches', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const fixture = mkdtempSync(join(tmpdir(), 'jsc-patch-checkout-'));
  const git = (...args) => execFileSync('git', args, { cwd: fixture, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    git('init', '--quiet');
    git('config', 'core.autocrlf', 'true');
    writeFileSync(join(fixture, '.gitattributes'), readFileSync(join(root, '.gitattributes')));
    const patches = readdirSync(join(root, 'patches')).filter(name => name.endsWith('.patch'));
    assert(patches.length > 0);
    for (const name of patches) writeFileSync(join(fixture, name), readFileSync(join(root, 'patches', name)));
    git('add', '.');
    for (const name of patches) rmSync(join(fixture, name));
    git('checkout-index', '--all');
    for (const name of patches) {
      assert(!readFileSync(join(fixture, name), 'utf8').includes('\r'), `${name} must retain LF line endings`);
      assert(git('apply', '--numstat', name).trim(), `${name} must parse as a unified diff`);
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
