// Exercise the GC-safe copy/move helpers on both sides of their small-copy
// cutoff, including overlap and the large argument buffer used by replace().
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

for (const length of [1, 29, 30, 31, 64, 511, 512, 513, 4096]) {
  const input = Array.from({ length }, (_, index) => ({ index }));
  const copy = input.slice();
  for (let index = 0; index < length; ++index) {
    assert(copy[index] === input[index], `slice ${length}:${index}`);
  }
  const joined = input.concat(input);
  for (let index = 0; index < joined.length; ++index) {
    assert(joined[index] === input[index % length], `concat ${length}:${index}`);
  }
  const backwards = input.slice();
  backwards.copyWithin(1, 0);
  for (let index = 1; index < length; ++index) {
    assert(backwards[index] === input[index - 1], `backward move ${length}:${index}`);
  }
  const forwards = input.slice();
  forwards.copyWithin(0, 1);
  for (let index = 0; index + 1 < length; ++index) {
    assert(forwards[index] === input[index + 1], `forward move ${length}:${index}`);
  }
}

const source = "abc123def456".repeat(10000);
for (let iteration = 0; iteration < 3; ++iteration) {
  const captures = source.replace(/([a-z]+)([0-9]+)/g, (_, letters, digits) => letters + digits);
  assert(captures === source, "cached replacement with captures");
  const plain = source.replace(/[a-z]+/g, match => match.toUpperCase());
  assert(plain === source.toUpperCase(), "cached replacement without captures");
}
print("GC memory regression passed");
