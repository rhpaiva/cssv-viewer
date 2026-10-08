// appimage/build.mjs, run as it is run, with the outside world faked: the
// programs it calls are scripts first on the PATH (apt-get, dpkg-deb,
// objdump, readelf, which, npx, appimagetool), the packages are tar files
// that the fake dpkg-deb unpacks, and fetch() answers from files
// (fake-net.mjs). Every run writes into a folder of its own.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = path.resolve(fileURLToPath(import.meta.url), '../../..');
const script = path.join(repo, 'appimage/build.mjs');
const source = fs.readFileSync(script, 'utf8');
const ARCH = 'x86_64-linux-gnu';
const HELPERS = `/usr/lib/${ARCH}/webkit2gtk-4.1`;
const PATCHED = `././/lib/${ARCH}/webkit2gtk-4.1`;

// The pins and URLs build.mjs holds, read from it so the tests follow it.
const pin = (name) => {
  const [, url, sha256] = source.match(new RegExp(`const ${name} = \\{\\s*url: '([^']+)',\\s*sha256: '([0-9a-f]+)'`));
  return { url, sha256 };
};
const APPIMAGETOOL = pin('APPIMAGETOOL');
const RUNTIME = pin('RUNTIME');
const EXCLUDELIST = source.match(/const EXCLUDELIST = '([^']+)'/)[1];
const PACKAGES = [...source.match(/const PACKAGES = \[([^\]]+)\]/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const write = (file, content, mode) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, mode ? { mode } : undefined);
};

// The fake programs. Each logs how it was called to $FAKE_LOG.
const LOG = 'log() { printf "%s\\n" "$*" >> "$FAKE_LOG"; }\n';
const TOOL = (name) => `#!/bin/sh
${LOG}log "${name} $* ARCH=$ARCH APPIMAGE_EXTRACT_AND_RUN=$APPIMAGE_EXTRACT_AND_RUN"
for last; do :; done
printf 'AppImage of %s\\n' "$4" > "$last"
`;
const STUBS = {
  npx: `#!/bin/sh\n${LOG}log "npx $* in $PWD"\n`,
  objdump: `#!/bin/sh\n${LOG}log "objdump $*"\n[ -n "$FAKE_OBJDUMP" ] || { echo "objdump: failed" >&2; exit 1; }\ncat "$FAKE_OBJDUMP"\n`,
  'apt-get': `#!/bin/sh
${LOG}log "apt-get $* APT_CONFIG=$APT_CONFIG"
[ -z "$FAKE_APT_FAIL" ] || { echo "apt-get: failed" >&2; exit 100; }
if [ "$1" = install ]; then
  archives=$(sed -n 's/^Dir::Cache::archives "\\(.*\\)";$/\\1/p' "$APT_CONFIG")
  cp "$FAKE_DEBS"/* "$archives"
fi
`,
  'dpkg-deb': `#!/bin/sh\n${LOG}log "dpkg-deb $*"\nmkdir -p "$3" && tar -xf "$2" -C "$3"\n`,
  // The fake libraries list what they load as "NEEDED <name>" lines.
  readelf: `#!/bin/sh\nsed -n 's/^NEEDED \\(.*\\)$/ 0x0000000000000001 (NEEDED)             Shared library: [\\1]/p' "$2"\n`,
  which: `#!/bin/sh\n${LOG}log "which $*"\n[ -n "$FAKE_WHICH" ]\n`,
  appimagetool: TOOL('appimagetool'),
};

// Ubuntu's packages, in two tar files, as dpkg-deb -x would unpack them.
// `needs` lists what the viewer loads; `webkit` is libwebkit2gtk's text.
function packages(dir, { webkit = `NEEDED libgtk-3.so.0\nNEEDED libGLESv2.so.2\nhelpers at ${HELPERS}/WebKitWebProcess\nand ${HELPERS}/injected-bundle\n` } = {}) {
  const lib = (p) => `usr/lib/${ARCH}/${p}`;
  const trees = {
    'libwebkit2gtk-4.1-0_2.48_amd64.deb': {
      [lib('libwebkit2gtk-4.1.so.0')]: webkit,
      [lib('webkit2gtk-4.1/WebKitNetworkProcess')]: ['NEEDED libwebkit2gtk-4.1.so.0\n', 0o755],
      [lib('webkit2gtk-4.1/WebKitWebProcess')]: ['NEEDED libwebkit2gtk-4.1.so.0\n', 0o755],
      [lib('webkit2gtk-4.1/injected-bundle/libwebkit2gtkinjectedbundle.so')]: 'NEEDED libwebkit2gtk-4.1.so.0\n',
      [lib('libGLESv2.so.2')]: 'GL\n',
    },
    'libgtk-3-0_3.24_amd64.deb': {
      [lib('libgtk-3.so.0.2404.29')]: 'NEEDED libz.so.1\nNEEDED libdrm.so.2\n',
      [lib('libgtk-3.so.0')]: { link: 'libgtk-3.so.0.2404.29' },
      [lib('libdrm.so.2')]: 'drm\n',
      [lib('gio/modules/libdconfsettings.so')]: 'NEEDED libz.so.1\n',
      [lib('gio/modules/libgioenvironmentproxy.so')]: '',
      [lib('gio/modules/libgiognutls.so')]: '',
      [lib('gtk-3.0/3.0.0/printbackends/libprintbackend-file.so')]: 'NEEDED libgtk-3.so.0\n',
      [lib('gtk-3.0/3.0.0/printbackends/libprintbackend-cups.so')]: 'NEEDED libgtk-3.so.0\n',
      [lib('gdk-pixbuf-2.0/2.10.0/loaders/libpixbufloader-png.so')]: '',
      [lib('gdk-pixbuf-2.0/2.10.0/loaders/libpixbufloader-svg.so')]: '',
      [lib('gdk-pixbuf-2.0/gdk-pixbuf-query-loaders')]: [
        '#!/bin/sh\necho "# LD_LIBRARY_PATH=$LD_LIBRARY_PATH"\nfor f; do printf \'"%s"\\n\' "$f"; done\n', 0o755],
      'usr/share/glib-2.0/schemas/org.gtk.Settings.FileChooser.gschema.xml': '<schemalist/>\n',
      'usr/share/glib-2.0/schemas/10_ubuntu.gschema.override': '[org.gtk.Settings]\n',
      'usr/share/glib-2.0/schemas/README': 'not a schema\n',
      'usr/bin/glib-compile-schemas': [
        '#!/bin/sh\nfiles=$(ls "$1")\nprintf "%s\\nLD_LIBRARY_PATH=%s\\n" "$files" "$LD_LIBRARY_PATH" > "$1/gschemas.compiled"\n', 0o755],
    },
    'zlib1g_1.2_amd64.deb': {
      [`lib/${ARCH}/libz.so.1`]: 'zlib\n',
      [`lib/${ARCH}/libc.so.6`]: 'libc\n',
    },
  };
  fs.mkdirSync(dir, { recursive: true });
  for (const [deb, files] of Object.entries(trees)) {
    const tree = path.join(dir, `${deb}.tree`);
    for (const [file, content] of Object.entries(files)) {
      const at = path.join(tree, file);
      fs.mkdirSync(path.dirname(at), { recursive: true });
      if (Array.isArray(content)) write(at, content[0], content[1]);
      else if (typeof content === 'object') fs.symlinkSync(content.link, at);
      else write(at, content);
    }
    const tar = spawnSync('tar', ['-cf', path.join(dir, deb), '-C', tree, '.']);
    assert.equal(tar.status, 0, String(tar.stderr));
    fs.rmSync(tree, { recursive: true });
  }
  write(path.join(dir, 'lock'), ''); // apt's, beside the packages
}

const OBJDUMP = `
/x/cssv-viewer:     file format elf64-x86-64

DYNAMIC SYMBOL TABLE:
0000000000000000      DF *UND*\t0000000000000000 (GLIBC_2.2.5) free
0000000000000000      DF *UND*\t0000000000000000 (GLIBC_2.17) clock_gettime
0000000000000000      DF *UND*\t0000000000000000 (GLIBC_2.3) __ctype_b_loc
0000000000000000      DF *UND*\t0000000000000000 (GLIBC_2.34) pthread_create
0000000000000000  w   D  *UND*\t0000000000000000 (GLIBC_2.99) __cxa_finalize
`;

/**
 * A folder with everything one run needs, and a function that runs build.mjs
 * in it. Options: the viewer's `needs`, `objdump` output, `which` finding
 * appimagetool, `fetch` answers beyond the excludelist, `webkit` text.
 */
function setup(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cssv-appimage-'));
  const bin = path.join(dir, 'bin');
  for (const [name, text] of Object.entries(STUBS)) write(path.join(bin, name), text, 0o755);
  const debs = path.join(dir, 'debs');
  packages(debs, options);
  const keyring = path.join(dir, 'ubuntu-archive-keyring.gpg');
  write(keyring, 'key');
  const viewer = path.join(dir, 'build', 'cssv-viewer');
  write(viewer, options.needs ?? 'NEEDED libwebkit2gtk-4.1.so.0\nNEEDED libgtk-3.so.0\nNEEDED libc.so.6\nNEEDED libmissing.so.9\n', 0o755);
  const objdump = path.join(dir, 'objdump.txt');
  write(objdump, options.objdump ?? OBJDUMP);
  const out = path.join(dir, 'dist', 'CSSV-Viewer-x86_64.AppImage');
  const work = path.join(dir, 'dist', '.appimage');
  const log = path.join(dir, 'log');
  write(log, '');
  // The fake downloads, and the pinned SHA-256s they stand in for.
  const fakeTool = path.join(dir, 'appimagetool.download');
  write(fakeTool, TOOL('downloaded-appimagetool'));
  const fakeRuntime = path.join(dir, 'runtime.download');
  write(fakeRuntime, 'the AppImage runtime\n');
  const pins = { [sha256(fs.readFileSync(fakeTool))]: APPIMAGETOOL.sha256, [sha256(fs.readFileSync(fakeRuntime))]: RUNTIME.sha256 };
  const fetch = {
    [EXCLUDELIST]: { text: '# What every system has\nlibc.so.6\n\nlibdrm.so.2 # the graphics driver\n  \n' },
    ...options.fetch?.({ fakeTool, fakeRuntime }),
  };

  const run = (args = ['--binary', viewer, '--out', out, '--keyring', keyring], env = {}) => {
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(path.join(repo, 'test/appimage/fake-net.mjs')).href, script, ...args], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        FAKE_LOG: log,
        FAKE_DEBS: debs,
        FAKE_OBJDUMP: objdump,
        FAKE_FETCH: JSON.stringify(fetch),
        FAKE_PINS: JSON.stringify(pins),
        ...(options.which && { FAKE_WHICH: '1' }),
        ...env,
      },
    });
    return { ...result, log: fs.readFileSync(log, 'utf8') };
  };
  return { dir, run, viewer, keyring, out, work, fakeTool, fakeRuntime, appdir: path.join(work, 'AppDir') };
}

const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');
const mode = (file) => fs.statSync(file).mode & 0o777;
const files = (dir) => fs.readdirSync(dir, { recursive: true }).map(String).sort();

test('packs the viewer, the libraries it loads and their run-time pieces into an AppImage', (t) => {
  const s = setup({ which: true });
  t.after(() => fs.rmSync(s.dir, { recursive: true, force: true }));
  // What an earlier build left: the runtime (kept, it has the pinned
  // SHA-256), an unpacked tree and an AppDir (both made anew), the AppImage
  // (replaced).
  write(path.join(s.work, 'runtime-x86_64'), fs.readFileSync(s.fakeRuntime), 0o755);
  write(path.join(s.work, 'root', 'stale'), 'old');
  write(path.join(s.appdir, 'stale'), 'old');
  write(s.out, 'the old AppImage');

  const r = s.run();
  assert.equal(r.status, 0, r.stderr);
  const lib = path.join(s.appdir, 'usr/lib', ARCH);

  // apt: a private setup for 22.04, checked against the keyring.
  const apt = path.join(s.work, 'apt');
  assert.equal(read(apt, 'etc/apt/sources.list'), [
    `deb [signed-by=${s.keyring}] http://archive.ubuntu.com/ubuntu jammy main universe`,
    `deb [signed-by=${s.keyring}] http://archive.ubuntu.com/ubuntu jammy-updates main universe`,
    `deb [signed-by=${s.keyring}] http://security.ubuntu.com/ubuntu jammy-security main universe`,
    '',
  ].join('\n'));
  const conf = read(apt, 'apt.conf');
  assert.match(conf, new RegExp(`^Dir::Cache::archives "${path.join(s.work, 'debs')}/";$`, 'm'));
  assert.match(conf, /^APT::Architecture "amd64";$/m);
  assert.match(conf, /^Debug::NoLocking "true";$/m);
  assert.equal(read(apt, 'var/lib/dpkg/status'), '');
  for (const dir of ['etc/apt/apt.conf.d', 'etc/apt/preferences.d', 'etc/apt/sources.list.d', 'var/lib/apt/lists/partial', 'var/cache/apt/archives/partial']) {
    assert.ok(fs.statSync(path.join(apt, dir)).isDirectory(), dir);
  }
  const calls = r.log.trim().split('\n');
  assert.deepEqual(calls.filter((c) => c.startsWith('apt-get')), [
    `apt-get update -q APT_CONFIG=${path.join(apt, 'apt.conf')}`,
    `apt-get install -y -q --download-only --no-install-recommends ${PACKAGES.join(' ')} APT_CONFIG=${path.join(apt, 'apt.conf')}`,
  ]);
  // Only the packages are unpacked, not apt's lock beside them.
  assert.deepEqual(calls.filter((c) => c.startsWith('dpkg-deb')).map((c) => path.basename(c.split(' ')[2])).sort(),
    ['libgtk-3-0_3.24_amd64.deb', 'libwebkit2gtk-4.1-0_2.48_amd64.deb', 'zlib1g_1.2_amd64.deb']);
  assert.ok(!fs.existsSync(path.join(s.work, 'root', 'stale')));
  assert.ok(!fs.existsSync(path.join(s.appdir, 'stale')));

  // The viewer, the modules, and the libraries they load, but not the ones
  // the excludelist leaves to the system, nor libGLESv2.
  assert.equal(read(s.appdir, 'usr/bin/cssv-viewer'), read(s.viewer));
  assert.equal(mode(path.join(s.appdir, 'usr/bin/cssv-viewer')), 0o755);
  assert.deepEqual(files(lib).filter((f) => !fs.statSync(path.join(lib, f)).isDirectory()), [
    'gdk-pixbuf-2.0/2.10.0/loaders.cache',
    'gdk-pixbuf-2.0/2.10.0/loaders/libpixbufloader-png.so',
    'gdk-pixbuf-2.0/2.10.0/loaders/libpixbufloader-svg.so',
    'gio/modules/libdconfsettings.so',
    'gio/modules/libgioenvironmentproxy.so',
    'gio/modules/libgiognutls.so',
    'gtk-3.0/3.0.0/printbackends/libprintbackend-cups.so',
    'gtk-3.0/3.0.0/printbackends/libprintbackend-file.so',
    'libgtk-3.so.0',
    'libwebkit2gtk-4.1.so.0',
    'libz.so.1',
    'webkit2gtk-4.1/WebKitNetworkProcess',
    'webkit2gtk-4.1/WebKitWebProcess',
    'webkit2gtk-4.1/injected-bundle/libwebkit2gtkinjectedbundle.so',
  ]);
  // A library behind a link is copied as the file, with its mode.
  assert.ok(!fs.lstatSync(path.join(lib, 'libgtk-3.so.0')).isSymbolicLink());
  assert.equal(read(lib, 'libgtk-3.so.0'), 'NEEDED libz.so.1\nNEEDED libdrm.so.2\n');
  assert.equal(mode(path.join(lib, 'webkit2gtk-4.1/WebKitWebProcess')), 0o755);
  assert.match(r.stdout, /^appimage: 3 libraries$/m);
  assert.match(r.stderr, /^appimage: left to the system, not in the excludelist: libmissing\.so\.9$/m);
  assert.doesNotMatch(r.stderr, /glibc/);

  // The helper processes' path, patched in place to the same length.
  const webkit = read(lib, 'libwebkit2gtk-4.1.so.0');
  assert.equal(webkit, `NEEDED libgtk-3.so.0\nNEEDED libGLESv2.so.2\nhelpers at ${PATCHED}/WebKitWebProcess\nand ${PATCHED}/injected-bundle\n`);
  assert.equal(HELPERS.length, PATCHED.length);

  // The loaders' cache names them without their folder, and was made with
  // 22.04's libraries; so were the schemas, of which only .xml and
  // .override are copied.
  assert.equal(read(lib, 'gdk-pixbuf-2.0/2.10.0/loaders.cache'),
    `# LD_LIBRARY_PATH=${lib}\n"libpixbufloader-png.so"\n"libpixbufloader-svg.so"\n`);
  assert.equal(read(s.appdir, 'usr/share/glib-2.0/schemas/gschemas.compiled'),
    `10_ubuntu.gschema.override\norg.gtk.Settings.FileChooser.gschema.xml\nLD_LIBRARY_PATH=${lib}\n`);

  // AppRun, the menu entry and the icon.
  assert.equal(read(s.appdir, 'AppRun'), read(repo, 'appimage/AppRun'));
  assert.equal(mode(path.join(s.appdir, 'AppRun')), mode(path.join(repo, 'appimage/AppRun')));
  assert.equal(read(s.appdir, 'cssv-viewer.desktop'), read(repo, 'appimage/cssv-viewer.desktop'));
  assert.deepEqual(fs.readFileSync(path.join(s.appdir, 'cssv-viewer.png')), fs.readFileSync(path.join(repo, 'src-tauri/icons/128x128@2x.png')));
  assert.equal(fs.readlinkSync(path.join(s.appdir, '.DirIcon')), 'cssv-viewer.png');

  // appimagetool from the PATH, given the pinned runtime, writes next to
  // the old AppImage, which the new one then replaces.
  assert.deepEqual(calls.filter((c) => /appimagetool/.test(c)), [
    'which appimagetool',
    `appimagetool --no-appstream --runtime-file ${path.join(s.work, 'runtime-x86_64')} ${s.appdir} ${s.out}.next ARCH=x86_64 APPIMAGE_EXTRACT_AND_RUN=1`,
  ]);
  assert.equal(read(s.out), `AppImage of ${s.appdir}\n`);
  assert.ok(!fs.existsSync(`${s.out}.next`));
  assert.match(r.stdout, /^appimage: dist\/CSSV-Viewer-x86_64\.AppImage, 0 MB$/m);
  // Nothing downloaded but the excludelist.
  assert.deepEqual(calls.filter((c) => c.startsWith('fetch')), [`fetch ${EXCLUDELIST}`]);
});

test('downloads appimagetool and the runtime when they are missing or not the pinned ones', (t) => {
  const s = setup({
    needs: 'NEEDED libwebkit2gtk-4.1.so.0\n',
    fetch: ({ fakeTool, fakeRuntime }) => ({ [APPIMAGETOOL.url]: { file: fakeTool }, [RUNTIME.url]: { file: fakeRuntime } }),
  });
  t.after(() => fs.rmSync(s.dir, { recursive: true, force: true }));
  write(path.join(s.work, 'runtime-x86_64'), 'an older runtime', 0o755); // as an older download left it

  const r = s.run();
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /left to the system/);
  assert.match(r.stdout, /^appimage: downloading appimagetool-x86_64\.AppImage$/m);
  assert.match(r.stdout, /^appimage: downloading runtime-x86_64$/m);
  for (const [file, fake] of [['appimagetool', s.fakeTool], ['runtime-x86_64', s.fakeRuntime]]) {
    assert.equal(read(s.work, file), read(fake));
    assert.equal(mode(path.join(s.work, file)), 0o755);
  }
  assert.match(r.log, new RegExp(`^downloaded-appimagetool --no-appstream --runtime-file ${path.join(s.work, 'runtime-x86_64')} `, 'm'));
  assert.equal(read(s.out), `AppImage of ${s.appdir}\n`);
});

test('refuses a download whose SHA-256 is not the pinned one', (t) => {
  const s = setup({ fetch: () => ({ [APPIMAGETOOL.url]: { text: 'something else' } }) });
  t.after(() => fs.rmSync(s.dir, { recursive: true, force: true }));
  const r = s.run();
  assert.notEqual(r.status, 0);
  assert.ok(r.stderr.includes(`${APPIMAGETOOL.url} has SHA-256 ${sha256('something else')}, not the pinned ${APPIMAGETOOL.sha256}`), r.stderr);
  assert.ok(!fs.existsSync(path.join(s.work, 'appimagetool')));
  assert.ok(!fs.existsSync(s.out));
});

test('stops when a download fails', (t) => {
  const s = setup({ which: true, fetch: () => ({ [RUNTIME.url]: { status: 404 } }) });
  t.after(() => fs.rmSync(s.dir, { recursive: true, force: true }));
  const r = s.run();
  assert.notEqual(r.status, 0);
  assert.ok(r.stderr.includes(`${RUNTIME.url}: HTTP 404`), r.stderr);
  assert.ok(!fs.existsSync(s.out));
});

test('stops when the excludelist cannot be fetched', (t) => {
  const s = setup({ fetch: () => ({ [EXCLUDELIST]: { status: 500 } }) });
  t.after(() => fs.rmSync(s.dir, { recursive: true, force: true }));
  const r = s.run();
  assert.notEqual(r.status, 0);
  assert.ok(r.stderr.includes(`${EXCLUDELIST}: HTTP 500`), r.stderr);
});

test('stops when libwebkit2gtk does not hold the helpers path', (t) => {
  const s = setup({ webkit: 'NEEDED libgtk-3.so.0\n' });
  t.after(() => fs.rmSync(s.dir, { recursive: true, force: true }));
  const r = s.run();
  assert.notEqual(r.status, 0);
  assert.ok(r.stderr.includes(`${HELPERS} isn't in libwebkit2gtk-4.1.so.0; the helper processes won't be found`), r.stderr);
  assert.ok(!fs.existsSync(s.out));
});

test('warns when the viewer needs a glibc newer than 22.04 has, ignoring weak symbols', async (t) => {
  // apt fails right after the check, so these runs stop there.
  const cases = [
    [OBJDUMP, null],
    [`${OBJDUMP}0000000000000000      DF *UND*\t0000000000000000 (GLIBC_2.36) getrandom\n`, '2.36'],
    // A 2.x after the 3.0, to compare a smaller major version too.
    [`${OBJDUMP}0000000000000000      DF *UND*\t0000000000000000 (GLIBC_3.0) future\n0000000000000000      DF *UND*\t0000000000000000 (GLIBC_2.10) after\n`, '3.0'],
  ];
  for (const [objdump, needs] of cases) {
    await t.test(needs ?? 'none', (t) => {
      const s = setup({ objdump });
      t.after(() => fs.rmSync(s.dir, { recursive: true, force: true }));
      const r = s.run(undefined, { FAKE_APT_FAIL: '1' });
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /apt-get: failed/);
      if (needs) assert.match(r.stderr, new RegExp(`^appimage: the viewer needs glibc ${needs.replace('.', '\\.')}, so it won't run on Ubuntu 22\\.04; build it on an older system$`, 'm'));
      else assert.doesNotMatch(r.stderr, /glibc/);
      assert.match(r.log, new RegExp(`^objdump -T ${s.viewer}$`, 'm'));
    });
  }
});

test('builds the viewer first without --binary', (t) => {
  const s = setup();
  t.after(() => fs.rmSync(s.dir, { recursive: true, force: true }));
  // objdump fails, so the run stops before anything is written.
  const r = s.run(['--out', s.out, '--keyring', s.keyring], { FAKE_OBJDUMP: '' });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /^appimage: building the viewer$/m);
  assert.deepEqual(r.log.trim().split('\n'), [
    `npx tauri build --no-bundle in ${repo}`,
    `objdump -T ${path.join(repo, 'src-tauri/target/release/cssv-viewer')}`,
  ]);
  assert.ok(!fs.existsSync(s.work));
});

test('stops at once without the keyring that checks the packages', (t) => {
  const s = setup();
  t.after(() => fs.rmSync(s.dir, { recursive: true, force: true }));
  // Without --out too: the default output in dist/ is never reached.
  const missing = path.join(s.dir, 'no-keyring.gpg');
  const r = s.run(['--binary', s.viewer, '--keyring', missing]);
  assert.equal(r.status, 1);
  assert.equal(r.stderr, `appimage: ${missing} is missing; install the ubuntu-keyring package, which apt needs to check Ubuntu's packages\n`);
  assert.equal(r.log, '');
});

test("uses the ubuntu-keyring package's keyring by default", (t) => {
  const s = setup();
  t.after(() => fs.rmSync(s.dir, { recursive: true, force: true }));
  // objdump fails, so whether or not this system has the keyring, the run
  // stops before writing anything.
  const r = s.run(['--binary', s.viewer, '--out', s.out], { FAKE_OBJDUMP: '' });
  assert.notEqual(r.status, 0);
  const KEYRING = '/usr/share/keyrings/ubuntu-archive-keyring.gpg';
  if (fs.existsSync(KEYRING)) assert.match(r.log, /^objdump -T /m);
  else assert.match(r.stderr, new RegExp(`${KEYRING} is missing`));
  assert.ok(!fs.existsSync(s.work));
});
