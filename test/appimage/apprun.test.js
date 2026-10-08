// appimage/AppRun, run from a fake AppImage whose viewer records how it was
// started: its arguments, folder and environment. Each case runs under the
// system's sh, which AppRun is written for, and under `bash --posix -x`,
// which must agree and whose trace (PS4 with $LINENO, which dash doesn't
// expand) shows which lines ran; together the cases run every line.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(fileURLToPath(import.meta.url), '../../..');
const APPRUN = path.join(repo, 'appimage/AppRun');
const LIB = 'usr/lib/x86_64-linux-gnu';
const PIXBUF = `${LIB}/gdk-pixbuf-2.0/2.10.0`;
const VARS = [
  'LD_LIBRARY_PATH', 'GIO_MODULE_DIR', 'GSETTINGS_SCHEMA_DIR', 'GDK_PIXBUF_MODULEDIR', 'GDK_PIXBUF_MODULE_FILE', 'XDG_DATA_DIRS',
  'GTK_MODULES', 'GTK3_MODULES', 'GTK_PATH', 'GTK_EXE_PREFIX', 'GTK_IM_MODULE', 'GST_PLUGIN_SYSTEM_PATH_1_0', 'GST_REGISTRY_FORK',
];
const VIEWER = `#!/bin/sh
{
  printf 'cwd=%s\\n' "$(pwd -P)"
  for a; do printf 'arg=%s\\n' "$a"; done
${VARS.map((v) => `  printf '${v}=%s\\n' "\${${v}-(unset)}"`).join('\n')}
} > "$RECORD"
`;

const traced = new Set();
const dirs = [];
test.after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** A fake AppImage's folder, with AppRun and the recording viewer. */
function appdir({ usr = true } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cssv-apprun-')));
  dirs.push(dir);
  const here = path.join(dir, 'AppDir');
  fs.mkdirSync(here);
  fs.copyFileSync(APPRUN, path.join(here, 'AppRun'));
  fs.chmodSync(path.join(here, 'AppRun'), 0o755);
  if (usr) {
    fs.mkdirSync(path.join(here, 'usr/bin'), { recursive: true });
    fs.writeFileSync(path.join(here, 'usr/bin/cssv-viewer'), VIEWER, { mode: 0o755 });
  }
  return { dir, here };
}

/**
 * Runs AppRun (or `apprun`, a link to it) with `args` in `cwd`, under sh and
 * under bash, and returns what the viewer recorded, which must be the same.
 * `env` adds to an environment without the variables AppRun reads.
 */
function run(apprun, args, { cwd, env = {} }) {
  const results = ['sh', 'bash'].map((shell) => {
    const record = path.join(cwd, `record-${shell}`);
    fs.rmSync(record, { force: true });
    const base = { ...process.env };
    for (const v of [...VARS, 'OWD', 'PWD']) delete base[v];
    const r = spawnSync(shell, shell === 'bash' ? ['--posix', '-x', apprun, ...args] : [apprun, ...args], {
      cwd,
      encoding: 'utf8',
      env: { ...base, RECORD: record, PS4: '+${LINENO}: ', ...env },
    });
    if (shell === 'bash') {
      for (const m of r.stderr.matchAll(/^\++(\d+): /gm)) traced.add(Number(m[1]));
    }
    const recorded = fs.existsSync(record) ? fs.readFileSync(record, 'utf8') : null;
    return { status: r.status, recorded, stderr: r.stderr };
  });
  const [sh, bash] = results;
  assert.equal(bash.status, sh.status, bash.stderr);
  assert.equal(bash.recorded, sh.recorded);
  if (sh.recorded === null) return { status: sh.status, stderr: sh.stderr };
  const lines = sh.recorded.trimEnd().split('\n');
  const value = (name) => lines.find((l) => l.startsWith(`${name}=`))?.slice(name.length + 1);
  return {
    status: sh.status,
    cwd: value('cwd'),
    args: lines.filter((l) => l.startsWith('arg=')).map((l) => l.slice(4)),
    env: Object.fromEntries(VARS.map((v) => [v, value(v)])),
  };
}

const touch = (file) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
};

test('makes relative file arguments absolute against the folder the viewer started in', () => {
  const { dir, here } = appdir();
  const cwd = path.join(dir, 'tables');
  for (const f of ['a.cssv', 'sub/b.cssv', 'with space.cssv']) touch(path.join(cwd, f));
  const r = run(path.join(here, 'AppRun'), ['a.cssv', 'sub/b.cssv', '/abs/c.cssv', '--flag', '-x', 'missing.cssv', 'with space.cssv'], { cwd });
  assert.equal(r.status, 0);
  assert.deepEqual(r.args, [
    path.join(cwd, 'a.cssv'),
    path.join(cwd, 'sub/b.cssv'),
    '/abs/c.cssv', // absolute already
    '--flag', // options as they are
    '-x',
    'missing.cssv', // nothing there: left as given
    path.join(cwd, 'with space.cssv'),
  ]);
  // The viewer runs in usr/, where the patched WebKit finds its helpers.
  assert.equal(r.cwd, path.join(here, 'usr'));
});

test("takes the folder from OWD, which the AppImage's runtime sets, over the current one", () => {
  const { dir, here } = appdir();
  const owd = path.join(dir, 'started-here');
  const cwd = path.join(dir, 'current');
  touch(path.join(owd, 'a.cssv'));
  touch(path.join(cwd, 'b.cssv'));
  const r = run(path.join(here, 'AppRun'), ['a.cssv', 'b.cssv'], { cwd, env: { OWD: owd } });
  assert.deepEqual(r.args, [path.join(owd, 'a.cssv'), 'b.cssv']);
});

test("points the libraries, modules and data at the AppImage's own, and starts the viewer without arguments", () => {
  const { dir, here } = appdir();
  const r = run(path.join(here, 'AppRun'), [], { cwd: dir, env: { GTK_MODULES: 'gail', GTK3_MODULES: 'atk-bridge' } });
  assert.equal(r.status, 0);
  assert.deepEqual(r.args, []);
  assert.deepEqual(r.env, {
    LD_LIBRARY_PATH: `${here}/${LIB}:${here}/${PIXBUF}/loaders`,
    GIO_MODULE_DIR: `${here}/${LIB}/gio/modules`,
    GSETTINGS_SCHEMA_DIR: `${here}/usr/share/glib-2.0/schemas`,
    GDK_PIXBUF_MODULEDIR: `${here}/${PIXBUF}/loaders`,
    GDK_PIXBUF_MODULE_FILE: `${here}/${PIXBUF}/loaders.cache`,
    XDG_DATA_DIRS: `${here}/usr/share:/usr/local/share:/usr/share`,
    GTK_MODULES: '(unset)',
    GTK3_MODULES: '(unset)',
    GTK_PATH: `${here}/${LIB}/gtk-3.0`,
    GTK_EXE_PREFIX: `${here}/usr`,
    GTK_IM_MODULE: 'gtk-im-context-simple',
    GST_PLUGIN_SYSTEM_PATH_1_0: '',
    GST_REGISTRY_FORK: 'no',
  });
});

test("keeps the system's library path and data folders after the AppImage's", () => {
  const { dir, here } = appdir();
  const r = run(path.join(here, 'AppRun'), [], { cwd: dir, env: { LD_LIBRARY_PATH: '/opt/x/lib', XDG_DATA_DIRS: '/opt/x/share:/usr/share' } });
  assert.equal(r.env.LD_LIBRARY_PATH, `${here}/${LIB}:${here}/${PIXBUF}/loaders:/opt/x/lib`);
  assert.equal(r.env.XDG_DATA_DIRS, `${here}/usr/share:/opt/x/share:/usr/share`);
});

test('finds its folder through a link to it', () => {
  const { dir, here } = appdir();
  const link = path.join(dir, 'cssv-viewer');
  fs.symlinkSync(path.join(here, 'AppRun'), link);
  const r = run(link, [], { cwd: dir });
  assert.equal(r.status, 0);
  assert.equal(r.cwd, path.join(here, 'usr'));
  assert.equal(r.env.GTK_EXE_PREFIX, `${here}/usr`);
});

test('stops when usr/ is missing', () => {
  const { dir, here } = appdir({ usr: false });
  const r = run(path.join(here, 'AppRun'), ['x.cssv'], { cwd: dir });
  assert.equal(r.status, 1);
  assert.equal(r.args, undefined); // the viewer never started
});

test('every line of AppRun ran', () => {
  // The lines with commands: not comments or blank lines, not the words
  // that only close a block, and not a case pattern without commands
  // (`/*|-*) ;;`), which leaves the argument as it is (tested above).
  const lines = fs.readFileSync(APPRUN, 'utf8').split('\n');
  const commands = lines
    .map((line, i) => [i + 1, line.trim()])
    .filter(([, line]) => line && !line.startsWith('#') && !/^(done|esac|fi|;;)$/.test(line) && !/^[^\s()]+\)\s*;;$/.test(line))
    .map(([n]) => n);
  assert.ok(commands.length > 20, `${commands.length} lines with commands`);
  assert.deepEqual(commands.filter((n) => !traced.has(n)).map((n) => `${n}: ${lines[n - 1]}`), []);
});

test('shellcheck finds nothing in AppRun', (t) => {
  const version = spawnSync('shellcheck', ['--version'], { encoding: 'utf8' });
  if (version.error) {
    t.skip('shellcheck is not installed (https://github.com/koalaman/shellcheck/releases)');
    return;
  }
  const r = spawnSync('shellcheck', ['--shell=sh', APPRUN], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout);
});
