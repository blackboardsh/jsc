#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const [llvmNm, jscLibrary, ...icuLibraries] = process.argv.slice(2);
if (!llvmNm || !jscLibrary || icuLibraries.length === 0) {
  throw new Error(
    'usage: verify-windows-icu-contract.js <llvm-nm> <JavaScriptCore.lib> <ICU libraries...>'
  );
}

function inspect(args) {
  return execFileSync(llvmNm, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

function undefinedSymbols(output) {
  return new Set(
    [...output.matchAll(/^\s*U\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/gm)].map((match) => match[1])
  );
}

function fallbackSymbols(output) {
  return new Set(
    [...output.matchAll(/^\s*[0-9A-Fa-f]+\s+[A-Za-z]\s+([A-Za-z_][A-Za-z0-9_]*)_70\s*$/gm)]
      .map((match) => match[1])
  );
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const declarations = new Set(
  [...readFileSync(resolve(root, 'bridge/icu-symbols.inc'), 'utf8')
    .matchAll(/^ICU_SYMBOL\(([A-Za-z_][A-Za-z0-9_]*)\)\s*$/gm)]
    .map((match) => match[1])
);
const undefinedInJsc = undefinedSymbols(inspect(['--undefined-only', jscLibrary]));
const definedByFallback = fallbackSymbols(inspect(['--defined-only', ...icuLibraries]));
const required = [...undefinedInJsc]
  .filter((symbol) => definedByFallback.has(symbol))
  .sort();
const missing = required.filter((symbol) => !declarations.has(symbol));

if (missing.length > 0) {
  throw new Error(
    `ICU bridge is missing ${missing.length} symbol(s) required by JavaScriptCore.lib:\n` +
      missing.map((symbol) => `  ICU_SYMBOL(${symbol})`).join('\n')
  );
}

console.log(`Verified ${required.length} ICU symbols required by JavaScriptCore.lib.`);
