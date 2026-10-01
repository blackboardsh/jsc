// Run with the JSC shell through scripts/test-jit-tiers.js. The $vm probes
// inspect the executing tier, so a build that silently falls back cannot pass.
const expectedTier = arguments[0];
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function currentTier() {
  if ($vm.ftlTrue()) return 'ftl';
  if ($vm.dfgTrue()) return 'dfg';
  if ($vm.baselineJITTrue()) return 'baseline';
  return 'interpreter';
}
noInline(currentTier);
let observedTier;
for (let iteration = 0; iteration < 100_000; ++iteration) {
  observedTier = currentTier();
  if (observedTier === expectedTier) break;
}
assert(observedTier === expectedTier, `Expected ${expectedTier}, observed ${observedTier}`);

function transform(value) {
  if (value.fail) throw value.reference;
  return {
    sum: value.a + value.b,
    reference: value.reference,
    rounded: Math.floor(Math.sqrt(value.a * value.a)),
    sine: Math.sin((value.a & 3) * Math.PI / 2),
  };
}
noInline(transform);
const reference = { keepAlive: 42 };
for (let iteration = 0; iteration < 20_000; ++iteration) {
  const value = transform({ a: iteration, b: 7, reference, fail: false });
  assert(value.sum === iteration + 7, `Arithmetic failed at ${iteration}`);
  assert(value.reference === reference, `Object identity failed at ${iteration}`);
  assert(value.rounded === iteration, `Native math helper failed at ${iteration}`);
  assert(Math.abs(value.sine - [0, 1, 0, -1][iteration & 3]) < 1e-12, `Native trigonometry helper failed at ${iteration}`);
  if (!(iteration % 1024)) gc();
}

// Change the profiled value types, exercise a different object shape, and
// throw through a previously hot frame after allocating and collecting.
const changed = transform({ extra: true, a: '20', b: 7, reference, fail: false });
assert(changed.sum === '207', 'Type transition lost JavaScript addition semantics');
assert(changed.reference === reference, 'Type transition lost a live reference');
let caught = false;
try {
  transform({ a: 1, b: 2, reference, fail: true });
} catch (error) {
  caught = error === reference;
}
assert(caught, 'Exception did not survive the hot frame');
gc();
assert(transform({ a: 35, b: 7, reference, fail: false }).sum === 42, 'Execution failed after deoptimization');
print(`JIT tier ${expectedTier} passed`);
