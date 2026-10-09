// Rust mutation tests: cargo-mutants (src-tauri/.cargo/mutants.toml) builds
// each mutant in a copy of src-tauri and runs the unit tests against it, in
// a virtual display for the print dialog's test. A copy has no ../ui, so
// TAURI_CONFIG points the app's files at this checkout. The results are in
// reports/mutants.out (missed.txt lists the mutants no test caught).
//
//   npm run mutate:rust [-- cargo-mutants options, such as -F may_read]
//
// Needs cargo-mutants and cargo-nextest, Xvfb and dbus-daemon.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { desktop } from './e2e/harness.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const renderer = path.join(repo, 'node_modules/@rhpaiva/cssv/src');
const frontendDist = [path.join(repo, 'ui'), path.join(renderer, 'cssv-table.js'), path.join(renderer, 'core.js')];

const desk = await desktop();
try {
  execFileSync('cargo', ['mutants', '--output', path.join(repo, 'reports'), ...process.argv.slice(2)], {
    cwd: path.join(repo, 'src-tauri'),
    env: { ...process.env, DISPLAY: desk.env.DISPLAY, TAURI_CONFIG: JSON.stringify({ build: { frontendDist } }) },
    stdio: 'inherit',
  });
} finally {
  await desk.stop();
}
