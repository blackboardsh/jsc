import assert from "node:assert/strict";
import test from "node:test";

import {
  findStaticImportMismatches,
  parseNmSymbols,
} from "./verify-windows-static-link-contract.js";

test("parses decorated COFF symbols from llvm-nm posix output", () => {
  const output = [
    "__imp_?evaluate@JSC@@YAXXZ U 0 0",
    "?evaluate@JSC@@YAXXZ T 0 0",
    "archive-member.obj:",
  ].join("\n");

  assert.deepEqual(
    [...parseNmSymbols(output, "U")],
    ["__imp_?evaluate@JSC@@YAXXZ"],
  );
});

test("rejects an import thunk when its static target is only defined directly", () => {
  const undefinedSymbols = new Set([
    "__imp_?evaluate@JSC@@YAXXZ",
    "__imp_GetCurrentProcessId",
  ]);
  const definedSymbols = new Set(["?evaluate@JSC@@YAXXZ"]);

  assert.deepEqual(
    findStaticImportMismatches(undefinedSymbols, definedSymbols),
    ["__imp_?evaluate@JSC@@YAXXZ"],
  );
});

test("accepts direct static references and import thunks supplied by the closure", () => {
  assert.deepEqual(
    findStaticImportMismatches(
      new Set(["?evaluate@JSC@@YAXXZ", "__imp_CreateFileW"]),
      new Set(["?evaluate@JSC@@YAXXZ"]),
    ),
    [],
  );
  assert.deepEqual(
    findStaticImportMismatches(
      new Set(["__imp_?evaluate@JSC@@YAXXZ"]),
      new Set(["?evaluate@JSC@@YAXXZ", "__imp_?evaluate@JSC@@YAXXZ"]),
    ),
    [],
  );
});
