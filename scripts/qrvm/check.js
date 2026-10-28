const fs = require('fs');
const path = require('path');

/// Fails if a public mapping keyed by `address`, `intN`, `bytesN` or a
/// contract type appears under contracts/: hypc's generated getter reads the
/// wrong slot for those keys (OC-V3-02, docs/QRVM.md Q2). Same rule as
/// pauli-swap's scripts/qrvm/check.js.

const ROOT = path.resolve(__dirname, '..', '..');
const bad = /mapping\s*\(\s*(address|int\d*|bytes\d+|I?[A-Z]\w*)\s+(?:\w+\s+)?=>[^;]*?\)\s*public\b/g;

const walk = (dir, acc = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) walk(f, acc);
    else if (f.endsWith('.hyp')) acc.push(f);
  }
  return acc;
};

const errors = [];
for (const file of walk(path.join(ROOT, 'contracts'))) {
  const src = fs.readFileSync(file, 'utf8').replace(/\/\/.*$/gm, '');
  for (const m of src.matchAll(bad)) errors.push(`${path.relative(ROOT, file)}: public mapping keyed by ${m[1]} (OC-V3-02)`);
}
for (const e of errors) console.error(`  ${e}`);
console.log(errors.length ? `${errors.length} problem(s)` : 'getter check passed');
process.exitCode = errors.length ? 1 : 0;
