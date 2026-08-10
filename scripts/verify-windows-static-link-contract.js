#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export function parseNmSymbols(output, wantedType = null) {
  const symbols = new Set();
  for (const line of output.split(/\r?\n/)) {
    const match = line.trim().match(/^(\S+)\s+(\S)(?:\s|$)/);
    if (!match || (wantedType && match[2].toUpperCase() !== wantedType)) continue;
    symbols.add(match[1]);
  }
  return symbols;
}

export function findStaticImportMismatches(undefinedSymbols, definedSymbols) {
  return [...undefinedSymbols]
    .filter(symbol => symbol.startsWith("__imp_"))
    .filter(symbol => {
      const directSymbol = symbol.slice("__imp_".length);
      return definedSymbols.has(directSymbol) && !definedSymbols.has(symbol);
    })
    .sort();
}

function inspect(nm, args) {
  return execFileSync(nm, args, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
}

function main() {
  const [nm, embedderLibrary, ...packagedLibraries] = process.argv.slice(2);
  if (!nm || !embedderLibrary || packagedLibraries.length === 0) {
    throw new Error(
      "usage: verify-windows-static-link-contract.js <llvm-nm> " +
      "<CottontailJSCEmbedder.lib> <packaged libraries...>",
    );
  }

  const undefinedSymbols = parseNmSymbols(inspect(nm, [
    "--format=posix",
    "--undefined-only",
    embedderLibrary,
  ]), "U");
  const definedSymbols = new Set();
  for (const library of packagedLibraries) {
    const symbols = parseNmSymbols(inspect(nm, [
      "--format=posix",
      "--defined-only",
      library,
    ]));
    for (const symbol of symbols) definedSymbols.add(symbol);
  }

  const mismatches = findStaticImportMismatches(undefinedSymbols, definedSymbols);
  if (mismatches.length > 0) {
    throw new Error(
      `CottontailJSCEmbedder.lib has ${mismatches.length} import thunk(s) whose ` +
      "targets are only defined directly by the packaged static libraries:\n" +
      mismatches.map(symbol => `  ${symbol}`).join("\n"),
    );
  }

  const imported = [...undefinedSymbols].filter(symbol => symbol.startsWith("__imp_")).length;
  console.log(
    `Verified Windows static embedder import-thunk closure ` +
    `(${imported} imported reference(s), ${definedSymbols.size} packaged definition(s)).`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
