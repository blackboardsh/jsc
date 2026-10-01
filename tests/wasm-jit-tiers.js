const expectedTier = arguments[0];
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// (module (import "env" "tier" (func $tier (result i32)))
//   (func (export "run") (result i32) (call $tier)))
const probeBytes = new Uint8Array([
  0,97,115,109,1,0,0,0,
  1,5,1,96,0,1,127,
  2,12,1,3,101,110,118,4,116,105,101,114,0,0,
  3,2,1,0,
  7,7,1,3,114,117,110,0,1,
  10,6,1,4,0,16,0,11,
]);
// Import the native probe directly: it inspects the calling Wasm frame.
const probe = expectedTier === 'omg' ? $vm.omgTrue : callerIsBBQOrOMGCompiled;
const instance = new WebAssembly.Instance(new WebAssembly.Module(probeBytes), { env: { tier: probe } });
let compiled = false;
for (let iteration = 0; iteration < 100_000; ++iteration) {
  if (instance.exports.run() === 1) { compiled = true; break; }
}
assert(compiled, `Wasm did not reach ${expectedTier}`);

// A separate module exercises compiled memory access and its out-of-bounds
// trap, including the Windows ARM64 fault-context handling.
const memoryBytes = new Uint8Array([
  0,97,115,109,1,0,0,0,
  1,6,1,96,1,127,1,127,
  3,2,1,0,
  5,3,1,0,1,
  7,17,2,4,114,101,97,100,0,0,6,109,101,109,111,114,121,2,0,
  10,9,1,7,0,32,0,40,2,0,11,
]);
const memoryInstance = new WebAssembly.Instance(new WebAssembly.Module(memoryBytes));
new Uint32Array(memoryInstance.exports.memory.buffer)[0] = 42;
for (let iteration = 0; iteration < 5000; ++iteration)
  assert(memoryInstance.exports.read(0) === 42, 'Wasm memory load returned the wrong value');
let trapped = false;
try { memoryInstance.exports.read(65536); }
catch (error) { trapped = error instanceof WebAssembly.RuntimeError; }
assert(trapped, 'Wasm out-of-bounds access did not produce a RuntimeError');
assert(memoryInstance.exports.read(0) === 42, 'Wasm execution failed after a memory trap');
print(`Wasm tier ${expectedTier} passed`);
