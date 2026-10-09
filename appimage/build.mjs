// Builds dist/CSSV-Viewer-x86_64.AppImage: the viewer with the WebKitGTK,
// GTK and GLib of Ubuntu 22.04, so it runs on 22.04 and later without
// installing anything.
//
//   npm run appimage                       builds the viewer, then the AppImage
//   npm run appimage -- --binary <path>    packs an already built viewer
//   npm run appimage -- --out <path>       writes the AppImage there instead of in dist/,
//                                          with its work folder (.appimage) beside it
//   npm run appimage -- --keyring <path>   checks the packages against that keyring
//                                          instead of the ubuntu-keyring package's
//
// It needs a Debian or Ubuntu system with apt (packages are only downloaded,
// never installed, so no root) and Ubuntu's archive key (the ubuntu-keyring
// package), readelf and objdump (binutils), and the network. appimagetool
// is downloaded when it isn't on the PATH.
//
// Everything downloaded is checked: apt checks the packages against the
// signature of Ubuntu's archive, and appimagetool and the AppImage runtime
// (the program at the start of the AppImage, which runs first when it
// starts) are pinned releases with a SHA-256.
//
// The steps: download 22.04's packages for the libraries the viewer needs,
// with everything they depend on; copy the viewer and every library it
// loads, directly or through WebKit's helper processes and GTK's and GLib's
// modules, leaving out what the AppImage excludelist expects every system
// to have; then add the pieces those libraries look for at run time (image
// loaders, print backends, settings schemas), AppRun and the icon.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.dirname(here);
const ARCH = 'x86_64-linux-gnu';

// What the build downloads (downloads.json): the packages to start from,
// which apt completes with their dependencies; the AppImage excludelist, a
// commit's, so the same build bundles the same libraries; and appimagetool
// and the AppImage runtime, pinned releases with their SHA-256.
const { packages: PACKAGES, excludelist: EXCLUDELIST, appimagetool: APPIMAGETOOL, runtime: RUNTIME } = JSON.parse(
  fs.readFileSync(path.join(here, 'downloads.json')),
);
// Left to the system besides the excludelist's: libGLESv2, which has to
// match the system's graphics driver like the rest of GL.
const ALSO_EXCLUDED = ['libGLESv2.so.2'];
const KEYRING = '/usr/share/keyrings/ubuntu-archive-keyring.gpg';
// 22.04's glibc: a viewer that needs a newer one won't start there.
const GLIBC = [2, 35];

const run = (cmd, args, options = {}) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 28, ...options });
const say = (text) => console.log(`appimage: ${text}`);
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? null : process.argv[i + 1];
};
const sha256 = (data) => createHash('sha256').update(data).digest('hex');

// The AppImage, and the folder the build works in beside it.
const out = path.resolve(arg('--out') ?? path.join(desktop, 'dist', 'CSSV-Viewer-x86_64.AppImage'));
const work = path.join(path.dirname(out), '.appimage');
const keyring = arg('--keyring') ?? KEYRING;

// A pinned download at `file`, downloaded again unless it has the SHA-256.
async function pinned(file, { url, sha256: want }) {
  if (fs.existsSync(file) && sha256(fs.readFileSync(file)) === want) return file;
  say(`downloading ${path.basename(url)}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const body = Buffer.from(await res.arrayBuffer());
  const got = sha256(body);
  if (got !== want) throw new Error(`${url} has SHA-256 ${got}, not the pinned ${want}`);
  fs.writeFileSync(file, body, { mode: 0o755 });
  return file;
}

if (!fs.existsSync(keyring)) {
  console.error(`appimage: ${keyring} is missing; install the ubuntu-keyring package, which apt needs to check Ubuntu's packages`);
  process.exit(1);
}

// --- The viewer ---------------------------------------------------------------

let binary = arg('--binary');
if (!binary) {
  say('building the viewer');
  run('npx', ['tauri', 'build', '--no-bundle'], { cwd: desktop, stdio: 'inherit' });
  binary = path.join(desktop, 'src-tauri', 'target', 'release', 'cssv-viewer');
}
binary = path.resolve(binary);

const needsGlibc = run('objdump', ['-T', binary]).split('\n')
  .filter((line) => !/\bw\b/.test(line.slice(0, 25))) // weak symbols are optional
  .flatMap((line) => [...line.matchAll(/GLIBC_(\d+)\.(\d+)/g)].map((m) => [Number(m[1]), Number(m[2])]))
  .reduce((max, v) => (v[0] > max[0] || (v[0] === max[0] && v[1] > max[1]) ? v : max), [2, 0]);
if (needsGlibc[0] > GLIBC[0] || needsGlibc[1] > GLIBC[1]) {
  console.warn(`appimage: the viewer needs glibc ${needsGlibc.join('.')}, so it won't run on Ubuntu 22.04; build it on an older system`);
}

// --- 22.04's packages ---------------------------------------------------------

// A private apt setup: jammy's lists and an empty package database, so apt
// downloads every dependency, whatever this system has installed.
const apt = path.join(work, 'apt');
const debs = path.join(work, 'debs');
const root = path.join(work, 'root');
for (const dir of ['etc/apt/apt.conf.d', 'etc/apt/preferences.d', 'etc/apt/sources.list.d', 'var/lib/apt/lists/partial', 'var/cache/apt/archives/partial', 'var/lib/dpkg']) {
  fs.mkdirSync(path.join(apt, dir), { recursive: true });
}
fs.mkdirSync(debs, { recursive: true });
fs.writeFileSync(path.join(apt, 'var/lib/dpkg/status'), '');
fs.writeFileSync(path.join(apt, 'etc/apt/sources.list'), ['jammy', 'jammy-updates', 'jammy-security']
  .map((suite) => `deb [signed-by=${keyring}] http://${suite.endsWith('security') ? 'security' : 'archive'}.ubuntu.com/ubuntu ${suite} main universe\n`).join(''));
fs.writeFileSync(path.join(apt, 'apt.conf'), `Dir "${apt}/";
Dir::State "${apt}/var/lib/apt";
Dir::State::status "${apt}/var/lib/dpkg/status";
Dir::Cache "${apt}/var/cache/apt";
Dir::Cache::archives "${debs}/";
Dir::Etc "${apt}/etc/apt";
APT::Architecture "amd64";
Debug::NoLocking "true";
`);
const aptEnv = { ...process.env, APT_CONFIG: path.join(apt, 'apt.conf') };
say('downloading Ubuntu 22.04 packages');
run('apt-get', ['update', '-q'], { env: aptEnv, stdio: ['ignore', 'ignore', 'inherit'] });
run('apt-get', ['install', '-y', '-q', '--download-only', '--no-install-recommends', ...PACKAGES], { env: aptEnv, stdio: ['ignore', 'ignore', 'inherit'] });
fs.rmSync(root, { recursive: true, force: true });
for (const deb of fs.readdirSync(debs).filter((f) => f.endsWith('.deb'))) run('dpkg-deb', ['-x', path.join(debs, deb), root]);

const lib = (...p) => path.join(root, 'usr/lib', ARCH, ...p);
const LIB_DIRS = [lib(), path.join(root, 'lib', ARCH)];

// --- The AppDir ---------------------------------------------------------------

const appdir = path.join(work, 'AppDir');
fs.rmSync(appdir, { recursive: true, force: true });
const into = (...p) => path.join(appdir, 'usr/lib', ARCH, ...p);
const copy = (from, to) => {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(fs.realpathSync(from), to); // with its mode
};

copy(binary, path.join(appdir, 'usr/bin/cssv-viewer'));
// The pieces libraries load by path at run time.
const MODULES = [
  'webkit2gtk-4.1/WebKitNetworkProcess', 'webkit2gtk-4.1/WebKitWebProcess',
  'webkit2gtk-4.1/injected-bundle/libwebkit2gtkinjectedbundle.so',
  ...['libdconfsettings.so', 'libgioenvironmentproxy.so', 'libgiognutls.so'].map((m) => `gio/modules/${m}`),
  ...['file', 'cups'].map((b) => `gtk-3.0/3.0.0/printbackends/libprintbackend-${b}.so`),
  ...fs.readdirSync(lib('gdk-pixbuf-2.0/2.10.0/loaders')).map((m) => `gdk-pixbuf-2.0/2.10.0/loaders/${m}`),
];
for (const module of MODULES) copy(lib(module), into(module));

// Every library those load, and the libraries those load, from the packages.
const excluded = new Set(ALSO_EXCLUDED);
const excludelist = await fetch(EXCLUDELIST);
if (!excludelist.ok) throw new Error(`${EXCLUDELIST}: HTTP ${excludelist.status}`);
for (const line of (await excludelist.text()).split('\n')) {
  const name = line.replace(/#.*/, '').trim();
  if (name) excluded.add(name);
}
const needed = (file) => [...run('readelf', ['-d', file]).matchAll(/\(NEEDED\)\s+Shared library: \[(.+?)\]/g)].map((m) => m[1]);
const queue = [path.join(appdir, 'usr/bin/cssv-viewer'), ...MODULES.map((m) => into(m))];
const bundled = new Set();
const missing = new Set();
while (queue.length) {
  for (const name of needed(queue.pop())) {
    if (excluded.has(name) || bundled.has(name)) continue;
    const found = LIB_DIRS.map((dir) => path.join(dir, name)).find((p) => fs.existsSync(p));
    if (!found) {
      missing.add(name);
      continue;
    }
    bundled.add(name);
    copy(found, into(name));
    queue.push(into(name));
  }
}
if (missing.size) console.warn(`appimage: left to the system, not in the excludelist: ${[...missing].join(' ')}`);
say(`${bundled.size} libraries`);

// libwebkit2gtk starts its helper processes from a path fixed at build time.
// The same number of bytes, relative, points it into the AppImage; AppRun
// starts the viewer from usr/.
const webkit = into('libwebkit2gtk-4.1.so.0');
const from = Buffer.from(`/usr/lib/${ARCH}/webkit2gtk-4.1`);
const to = Buffer.from(`././/lib/${ARCH}/webkit2gtk-4.1`);
const bytes = fs.readFileSync(webkit);
let patched = 0;
for (let i = bytes.indexOf(from); i !== -1; i = bytes.indexOf(from, i + to.length)) {
  to.copy(bytes, i);
  patched++;
}
if (!patched) throw new Error(`${from} isn't in libwebkit2gtk-4.1.so.0; the helper processes won't be found`);
fs.writeFileSync(webkit, bytes);

// The image loaders' cache, with bare file names: AppRun puts their folder
// on the library path, wherever the AppImage is mounted.
const loaders = into('gdk-pixbuf-2.0/2.10.0/loaders');
const cache = run(lib('gdk-pixbuf-2.0/gdk-pixbuf-query-loaders'), fs.readdirSync(loaders).map((m) => path.join(loaders, m)), {
  env: { ...process.env, LD_LIBRARY_PATH: into() }, // 22.04's libraries, without its libc
});
fs.writeFileSync(into('gdk-pixbuf-2.0/2.10.0/loaders.cache'), cache.replaceAll(`${loaders}/`, ''));

// GTK's and the desktop's settings schemas, compiled.
const schemas = path.join(appdir, 'usr/share/glib-2.0/schemas');
fs.mkdirSync(schemas, { recursive: true });
for (const f of fs.readdirSync(path.join(root, 'usr/share/glib-2.0/schemas'))) {
  if (/\.(xml|override)$/.test(f)) fs.copyFileSync(path.join(root, 'usr/share/glib-2.0/schemas', f), path.join(schemas, f));
}
run(path.join(root, 'usr/bin/glib-compile-schemas'), [schemas], { env: { ...process.env, LD_LIBRARY_PATH: into() } });

copy(path.join(here, 'AppRun'), path.join(appdir, 'AppRun'));
copy(path.join(here, 'cssv-viewer.desktop'), path.join(appdir, 'cssv-viewer.desktop'));
copy(path.join(desktop, 'src-tauri/icons/128x128@2x.png'), path.join(appdir, 'cssv-viewer.png'));
fs.symlinkSync('cssv-viewer.png', path.join(appdir, '.DirIcon'));

// --- Pack ---------------------------------------------------------------------

let tool = 'appimagetool';
try {
  run('which', [tool]);
} catch {
  tool = await pinned(path.join(work, 'appimagetool'), APPIMAGETOOL);
}
// Given to appimagetool, which would otherwise download the latest runtime unchecked.
const runtime = await pinned(path.join(work, 'runtime-x86_64'), RUNTIME);
// Written next to the old one and renamed over it, which works while the old
// one is running.
const next = `${out}.next`;
run(tool, ['--no-appstream', '--runtime-file', runtime, appdir, next], {
  env: { ...process.env, ARCH: 'x86_64', APPIMAGE_EXTRACT_AND_RUN: '1' },
  stdio: ['ignore', 'ignore', 'inherit'],
});
fs.renameSync(next, out);
say(`${path.relative(process.cwd(), out)}, ${(fs.statSync(out).size / 1e6).toFixed(0)} MB`);
