// Rust coverage: the unit tests and the real app (test/e2e) measured
// together, in a virtual display, failing below 100% of lines, functions or
// branches. Branch coverage needs a nightly toolchain: RUST_NIGHTLY names
// it (default "nightly"). The report is in coverage/rust/html.
//
//   npm run coverage:rust
//
// Needs cargo-llvm-cov and cargo-nextest, and what test/e2e/harness.js needs.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { desktop } from './e2e/harness.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const crate = path.join(repo, 'src-tauri');
const toolchain = `+${process.env.RUST_NIGHTLY ?? 'nightly'}`;
// The tests' own code isn't measured.
const ignore = ['--ignore-filename-regex', '(^|/)tests\\.rs$'];

// An instrumented build of its own, beside the usual ones.
const env = { ...process.env, CARGO_TARGET_DIR: path.join(crate, 'target/coverage') };
const cargo = (args, more = {}) => execFileSync('cargo', [toolchain, ...args], { cwd: crate, env: { ...env, ...more }, stdio: 'inherit' });
const shown = execFileSync('cargo', [toolchain, 'llvm-cov', 'show-env', '--branch', '--sh'], { cwd: crate, env, encoding: 'utf8' });
for (const [, name, quoted, bare] of shown.matchAll(/^export (\w+)=(?:'(.*)'|(.*))$/gm)) env[name] = quoted ?? bare;

cargo(['llvm-cov', 'clean', '--workspace']);
// The print setup's test needs GTK, and GTK a display.
const desk = await desktop();
try {
  cargo(['nextest', 'run'], { DISPLAY: desk.env.DISPLAY });
} finally {
  await desk.stop();
}
// The app as `tauri build` builds it, with its pages inside.
cargo(['build', '--features', 'tauri/custom-protocol']);
execFileSync('node', ['--test', '--test-concurrency=1', 'test/e2e/'], {
  cwd: repo,
  env: { ...env, CSSV_VIEWER: path.join(env.CARGO_TARGET_DIR, 'debug/cssv-viewer') },
  stdio: 'inherit',
});

cargo(['llvm-cov', 'report', '--branch', ...ignore, '--html', '--output-dir', path.join(repo, 'coverage/rust')]);
cargo(['llvm-cov', 'report', '--branch', ...ignore]);
const { totals } = JSON.parse(
  execFileSync('cargo', [toolchain, 'llvm-cov', 'report', '--branch', ...ignore, '--json', '--summary-only'], { cwd: crate, env, encoding: 'utf8' }),
).data[0];
const short = ['lines', 'functions', 'branches'].filter((kind) => totals[kind].count > totals[kind].covered);
if (short.length) {
  console.error(`Rust coverage is below 100% of ${short.join(', ')}.`);
  process.exit(1);
}
