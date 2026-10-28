const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

/// QRVM build of contracts/, the same pipeline as pauli-swap's
/// `npm run compile:qrvm`: hyperion main as `hypc:local` (or HYPC_BIN), output
/// key `qrvm`, artifacts in build/qrvm/<unit>/<Name>.json plus index.json, the
/// layout the interface's sync-contracts script reads.

const ROOT = path.resolve(__dirname, '..');
const SOURCES = path.join(ROOT, 'contracts');
const ARTIFACTS = path.join(ROOT, 'build', 'qrvm');
const OPTIMIZER_RUNS = 200;

// go-zond params.MaxCodeSize / MaxInitCodeSize
const MAX_CODE_SIZE = 24576;
const MAX_INIT_CODE_SIZE = 2 * MAX_CODE_SIZE;

function hypc(extra, input) {
  const [cmd, args] = process.env.HYPC_BIN
    ? [process.env.HYPC_BIN, []]
    : ['docker', ['run', '--rm', '-i', process.env.HYPC_DOCKER_IMAGE || 'hypc:local']];
  const result = spawnSync(cmd, [...args, ...extra], { input, encoding: 'utf8', maxBuffer: 1 << 28 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`hypc exited ${result.status}: ${result.stderr}`);
  return result.stdout;
}

function listSources(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listSources(full, acc);
    else if (entry.name.endsWith('.hyp')) acc.push(full);
  }
  return acc;
}

const toUnit = (file) => path.relative(ROOT, file).split(path.sep).join('/');

// hypc's import callback does not say which unit issued an import, so every
// source is pre-loaded and its relative imports are rewritten to unit names.
function collectSources(files) {
  const sources = {};
  function load(unit) {
    if (sources[unit]) return;
    sources[unit] = { content: '' };
    const raw = fs.readFileSync(path.join(ROOT, unit), 'utf8');
    sources[unit].content = raw.replace(
      /(import\s+(?:[\w*\s{},]+\s+from\s+)?)(["'])([^"']+)\2/g,
      (match, head, quote, spec) => {
        if (!spec.startsWith('.')) throw new Error(`Unsupported import "${spec}" in ${unit}`);
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(unit), spec));
        if (!fs.existsSync(path.join(ROOT, target))) throw new Error(`Cannot resolve "${spec}" from ${unit}`);
        load(target);
        return `${head}${quote}${target}${quote}`;
      }
    );
  }
  for (const file of files) load(toUnit(file));
  return sources;
}

function main() {
  const files = listSources(SOURCES);
  const output = JSON.parse(
    hypc(
      ['--standard-json'],
      JSON.stringify({
        language: 'Hyperion',
        sources: collectSources(files),
        settings: {
          optimizer: { enabled: true, runs: OPTIMIZER_RUNS },
          metadata: { bytecodeHash: 'none' },
          outputSelection: {
            '*': {
              '*': [
                'abi',
                'qrvm.bytecode.object',
                'qrvm.bytecode.linkReferences',
                'qrvm.deployedBytecode.object',
                'qrvm.deployedBytecode.immutableReferences',
                'qrvm.methodIdentifiers',
              ],
            },
          },
        },
      })
    )
  );

  let failed = false;
  for (const err of output.errors || []) {
    // The hyperion main line flags itself as a pre-release on every build.
    if (err.errorCode === '3805') continue;
    if (err.severity === 'error') {
      failed = true;
      console.error(err.formattedMessage);
    } else if (process.env.HYP_WARNINGS === '1') {
      console.warn(err.formattedMessage);
    }
  }
  if (failed) process.exit(1);

  fs.rmSync(ARTIFACTS, { recursive: true, force: true });
  const index = {};
  for (const [unit, contracts] of Object.entries(output.contracts || {})) {
    for (const [name, contract] of Object.entries(contracts)) {
      const out = contract.qrvm;
      const artifact = {
        _format: 'hh-hyp-artifact-1',
        contractName: name,
        sourceName: unit,
        abi: contract.abi,
        bytecode: '0x' + (out.bytecode.object || ''),
        deployedBytecode: '0x' + (out.deployedBytecode.object || ''),
        methodIdentifiers: out.methodIdentifiers || {},
        linkReferences: out.bytecode.linkReferences || {},
        immutableReferences: out.deployedBytecode.immutableReferences || {},
      };
      const dir = path.join(ARTIFACTS, unit);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(artifact, null, 2));

      const runtime = (artifact.deployedBytecode.length - 2) / 2;
      const init = (artifact.bytecode.length - 2) / 2;
      if (runtime > MAX_CODE_SIZE || init > MAX_INIT_CODE_SIZE) {
        console.error(`${name}: runtime ${runtime} / init ${init} bytes, over ${MAX_CODE_SIZE} / ${MAX_INIT_CODE_SIZE}`);
        failed = true;
      }
      if (runtime > 0) console.log(`  ${name.padEnd(16)} runtime ${String(runtime).padStart(6)}  init ${String(init).padStart(6)}`);
      (index[name] ||= []).push(unit);
    }
  }
  if (failed) process.exit(1);

  fs.writeFileSync(path.join(ARTIFACTS, 'index.json'), JSON.stringify(index, null, 2));
  console.log(`hypc ${(hypc(['--version']).match(/Version:\s*(\S+)/) || [])[1]}, ${files.length} sources`);
}

main();
