# CSSV Viewer

[![CI](https://img.shields.io/github/actions/workflow/status/rhpaiva/cssv-viewer/test.yml?branch=main&label=CI)](https://github.com/rhpaiva/cssv-viewer/actions/workflows/test.yml) [![Coverage](https://img.shields.io/badge/coverage-100%25-brightgreen)](https://github.com/rhpaiva/cssv-viewer/actions/workflows/test.yml) [![Mutation score](https://img.shields.io/badge/mutation%20score-99%25-brightgreen)](https://github.com/rhpaiva/cssv-viewer/actions/workflows/test.yml) [![Release](https://img.shields.io/github/v/release/rhpaiva/cssv-viewer)](https://github.com/rhpaiva/cssv-viewer/releases/latest)

A desktop app that opens `.cssv` files. It is a [Tauri](https://tauri.app/) shell around `<cssv-table>`: the window is a web view, and the table in it is rendered by `src/cssv-table.js` from the [`@rhpaiva/cssv`](https://www.npmjs.com/package/@rhpaiva/cssv) package, the same renderer [cssv.dev](https://cssv.dev) uses, loaded unchanged. Section numbers (§) refer to the [CSSV specification](https://cssv.dev/spec.html).

- One window, with a tab for each file, named after the file's title (§4.6) or, without one, the file's name. A file opened from the file manager or the command line while the viewer runs opens in a tab of the running viewer. From the viewer (**Open…**, a recent file, a drop), a file opens in the current tab when that's the home, and otherwise in a new tab after it. A file that's open already shows its tab.
- Started without a file, the viewer opens its home: open a file, or pick one of the 8 latest from its card, which shows the table's first rows rendered from its own styles, held still, with the file's title and description (§4.6) and the table's size. **+** opens the home in a new tab.
- Saving the file updates its tab in place, in the background too: unchanged rows and the scroll position stay.
- Drop files on the window to open them in tabs.
- Problems the renderer reports (a bad `--cssv-format`, an import that failed, a malformed file) are listed under the toolbar, with the section of the spec they come from and, where the file says it, a link to the line.
- The window opens at the size and place it had (Wayland doesn't let apps place windows, so there only the size).

## The toolbar

| | |
|---|---|
| **Open…** and **▾** | Opens files (<kbd>Ctrl</kbd> <kbd>O</kbd>). The arrow lists recent files and, in the Linux AppImage, sets the viewer up to open `.cssv` files. |
| Find | Searches the values as the file has them, column names included, and marks the matched text in the cells that hold them (<kbd>Ctrl</kbd> <kbd>F</kbd>; <kbd>Enter</kbd> and <kbd>Shift</kbd> <kbd>Enter</kbd> move between matches; the button or <kbd>Esc</kbd> closes it). `1234.5` finds the cell that shows `1,234.50`, and marks all of its text. |
| Plain view | The data without its style block, in the renderer's default styles: what the file holds when its styles hide or rearrange it. |
| Source | The file's text beside the table, with line numbers (<kbd>Ctrl</kbd> <kbd>U</kbd>). Drag the divider to resize it. |
| Light or dark | Follows the system, or makes the window light or dark. The table's `light-dark()` values and `prefers-color-scheme` queries follow it, in every tab. |
| Language for numbers | The language numbers display in (§10.1): the system's, or another one, to see a file as readers elsewhere will. |
| Copy | The selected cells (also <kbd>Ctrl</kbd> <kbd>C</kbd> on a selection that spans cells), the whole table for spreadsheets (tab-separated), the table as Markdown (Appendix B), or the data section as CSV. Copies carry the values as the file has them, not their formatted display, except Markdown. |
| Save as | The data as CSV, or a picture of the table as it shows: PNG, or SVG, which keeps its animations. |
| Print | A preview first (<kbd>Ctrl</kbd> <kbd>P</kbd>): the table on paper as it will print, with the file's own `@media print` rules, and the paper (A4 or Letter), orientation, scale (fit to the page width, or actual size), margins and background colors. **Print…** (or <kbd>Ctrl</kbd> <kbd>P</kbd> again) prints the table alone. Print to a PDF from the print dialog; on Linux it's named after the file, goes next to it, and is on the preview's paper. The paper is white in either theme. |

<kbd>Ctrl</kbd> <kbd>K</kbd> opens a palette that finds a command, the toolbar's or the tabs', with its shortcut, or a recent file: type part of its name (`md` finds *Copy the table as Markdown*, `num ger` the German numbers), then <kbd>Enter</kbd>.

<kbd>Ctrl</kbd> <kbd>T</kbd> opens the home in a new tab. <kbd>Ctrl</kbd> <kbd>W</kbd>, or a middle click on a tab, closes it (the last one closes the window), and <kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>T</kbd> brings closed tabs back. <kbd>Ctrl</kbd> <kbd>Tab</kbd> and <kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>Tab</kbd>, or <kbd>Ctrl</kbd> <kbd>PgDn</kbd> and <kbd>Ctrl</kbd> <kbd>PgUp</kbd>, move between tabs; <kbd>Ctrl</kbd> <kbd>1</kbd> to <kbd>8</kbd> show a tab by its place, and <kbd>Ctrl</kbd> <kbd>9</kbd> the last. Drag a tab to move it along the strip, or use <kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>PgUp</kbd> and <kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>PgDn</kbd>. <kbd>Ctrl</kbd> <kbd>R</kbd> reloads the tab, <kbd>Ctrl</kbd> <kbd>+</kbd> and <kbd>Ctrl</kbd> <kbd>-</kbd> zoom and <kbd>Ctrl</kbd> <kbd>Q</kbd> quits. On macOS, <kbd>⌘</kbd> takes the place of <kbd>Ctrl</kbd>, except with <kbd>Tab</kbd>, <kbd>PgDn</kbd> and <kbd>PgUp</kbd>.

The window is a WebKit web view on Linux and macOS and a Chromium one (WebView2) on Windows, so CSS that only Chromium supports so far, such as typed `attr()`, shows only on Windows. Some limits of WebKit show up when saving and printing: a table drawn with 3D transforms comes out flat in a PNG (the SVG keeps it, in programs that draw 3D in SVG, as browsers do when they open it), and a printed table shows its header row on the first page only. WebKit also can't stack the preview's pages, so they run side by side.

## What a file may load

[§11.2](https://cssv.dev/spec.html#11-2-remote-resources) asks renderers to say what a file's stylesheet may fetch. In the viewer:

- **Files in the opened file's folder and the folders below it**, through `@import` and `url()`, except hidden ones (a name that starts with `.`, or a file in such a folder). Relative URLs resolve against the file, as §4.3 requires. Nothing else on disk is reachable: `../brand.css` fails and is reported. A file in your home folder, or in a folder that holds it, may load only the files beside it, not the folders below. That holds for each tab on its own: a file can't reach the folder of a file open in another tab, because a tab's URLs carry a random id that only that tab's page knows.
- **Nothing remote** until you allow it. Loading a remote stylesheet, font or image tells its server that the file was opened, and a stylesheet can send table values along (§11.3). When a file asks for remote resources, a bar under the toolbar lists each URL it asked for and what it is (a stylesheet, a font, an image). **Allow** reloads the tab with remote loads allowed until it opens another file; **Always allow for this file** remembers the choice; **Don't allow** keeps them blocked and hides the bar. Either choice holds for the file's style block as it was: when the style block changes, the viewer asks again. While remote content is allowed, a **Remote** button in the toolbar says so, and blocks it again.

## Run it

You need [Rust](https://rustup.rs/), Node.js and the [system libraries Tauri needs](https://v2.tauri.app/start/prerequisites/) (on Linux, WebKitGTK 4.1 and its development files). Then, from this folder:

```
npm install
npm run dev                                  # the viewer, built in debug mode
npm run dev -- -- -- /home/ana/budget.cssv  # the same, opening a file (the path must be absolute)
npm run build                                # installers for this platform, in src-tauri/target/release/bundle/
npm run appimage                             # dist/CSSV-Viewer-x86_64.AppImage (Linux; see below)
```

The installers register the viewer for `.cssv` files: the `.deb` and the `.rpm` add the `text/x-cssv` media type (CSSV has none registered yet, §3.3), and the macOS and Windows installers add the file extension. Each also gives `.cssv` files their own icon in the file manager, a page with the CSSV mark and label, apart from the app's. Its two drawings are in `src-tauri/icons/file/`, one for 32 px and below, where the label can't be read, and one above; `node tools/file-icon.mjs` makes the PNGs, the `.ico` and the `.icns` from them.

### The AppImage

`npm run appimage` builds the viewer and packs it with the WebKitGTK, GTK and GLib of Ubuntu 22.04, so the one file runs on 22.04 and later without installing anything. [`appimage/build.mjs`](appimage/build.mjs) does it: it downloads 22.04's packages with apt (no root, nothing installed), copies every library the viewer loads, leaving out what the [AppImage excludelist](https://github.com/AppImageCommunity/pkg2appimage/blob/master/excludelist) leaves to the system, and adds what those libraries look for at run time. It needs apt, binutils and the network. [`appimage/AppRun`](appimage/AppRun) starts the viewer with those libraries:

- GTK's image loaders are on the library path, because their cache names them without a folder. Without the SVG loader GTK draws no icons: no window buttons, no folders in the Open dialog.
- GTK's print backends come from inside the AppImage, so the print dialog lists the printers and Print to File.
- WebKit's helper processes are found through a relative path that the build patches into `libwebkit2gtk`, so the viewer starts from inside the AppImage.

An AppImage registers nothing by itself. The home offers to set it up: that adds a menu entry that runs this AppImage, the `text/x-cssv` media type for `*.cssv` files, the app's icon and that of `.cssv` files, all in your home folder, and makes the viewer the app for `.cssv` files. The menu entry's name matches the window's class, `cssv-viewer`, which is how the dock finds the icon. If the AppImage moves, the next start from its new place updates the entry, and an AppImage of a newer version puts in its icons; **▾ → Stop opening .cssv files with CSSV Viewer** removes it all.

## Tests

```
npm test                 # the UI's and the AppImage build's tests, then the Rust tests
npm run lint             # shellcheck, rustfmt, clippy, cargo-deny and cargo-shear
npm run coverage         # every test, failing below 100% of lines, functions and branches
npm run mutate           # mutation tests of appimage/build.mjs and the Rust side; reports in reports/
```

- `test/ui/` runs the pages of `ui/` in headless Chromium (Playwright) with a stand-in for the Tauri API, which answers each command and records the calls. Set `CHROME_PATH` to use a Chrome of your own instead of Playwright's (`npx playwright install chromium` downloads that).
- `test/appimage/` runs `appimage/build.mjs` with stand-ins for apt, the binutils, `appimagetool` and the network, writing into a folder of its own (`--out`), and runs `AppRun` with a stand-in viewer.
- `src-tauri/src/tests.rs` and `src-tauri/src/linux/tests.rs` test the Rust side without a window: the protocol's rules, the commands' work, the file watcher, the AppImage's setup and the print dialog's paper (that one needs a display; without one it says so and passes). [cargo-nextest](https://nexte.st/) runs each test in a process of its own; `cargo test` works too.
- `test/e2e/` drives the real viewer through [WebKitWebDriver](https://webkitgtk.org/) in a virtual display, Linux only: opening, live reload, saving, a second start, the home, the AppImage setup, and, without WebDriver (WebKit doesn't print under it), printing to a PDF through GTK's dialog with `xdotool`. It runs the build `npm run coverage:rust` makes, or the one `CSSV_VIEWER` names.

`npm run coverage:js` measures the JavaScript with [c8](https://github.com/bcoe/c8) (the report is in `coverage/js/`). `npm run coverage:rust` builds the Rust tests and the viewer with [cargo-llvm-cov](https://github.com/taiki-e/cargo-llvm-cov), runs both, and measures them together (`coverage/rust/html/`); counting branches needs a nightly toolchain (`RUST_NIGHTLY` names one; `nightly` by default). Tauri's code for reading the commands' arguments is left out, as the rest of Tauri is. The end-to-end tests need Xvfb, `dbus-daemon`, `xdotool` and WebKitWebDriver (Ubuntu's `webkit2gtk-driver` or `webkitgtk-webdriver` package).

`npm run mutate` changes the code one small edit at a time (a `<` for a `<=`, a removed line) and checks that the tests fail for each change: a change they miss is a gap in the tests. [Stryker](https://stryker-mutator.io/) mutates `appimage/build.mjs` against its tests and fails below the score in `stryker.config.json`; the 5 mutants left are equivalent ones, which no input tells apart. [cargo-mutants](https://mutants.rs/) mutates the Rust side against the unit tests, in a virtual display for the print dialog's test, and fails when one survives; `src-tauri/.cargo/mutants.toml` leaves out the window's glue, which only the real viewer runs. The pages in `ui/` aren't mutated, because each mutant would need a full browser run.

[`.github/workflows/test.yml`](.github/workflows/test.yml) runs the lints, the Rust tests on Linux, macOS and Windows, the coverage and the mutation tests on Linux, for every pull request and every push to `main`.

## How it fits together

- `src-tauri/tauri.conf.json` lists `ui/` and the package's `src/cssv-table.js` and `src/core.js` as the app's files, and `package.json` takes the package from npm. To try a renderer that isn't published yet, put a checkout of [cssv](https://github.com/rhpaiva/cssv) beside this one and run `npm install --no-save ../cssv`, which links it in place of the published package without changing `package.json` or the lock file; `npm install` brings the published one back.
- `src-tauri/src/lib.rs` creates the window and serves each tab's file over a `cssv:` protocol whose URLs are the tab's id followed by the file's path (`cssv://localhost/<tab>/home/ana/budget.cssv`; `http://cssv.localhost/<tab>/C:/…` on Windows). It only serves a tab its own file's folder (What a file may load), reading off the window's thread and only regular files up to 256 MiB, and it watches the file to tell the tab when it changes. A home tab may also read the folders of its recent files, for their previews, by the same rules. Files the viewer is asked to open from outside wait in a queue until the window's page takes them. It saves what the page makes through a save dialog it opens itself, so the page can only write where you chose. What the viewer decides (which file a tab may read, what a window opens, how it prints) is in `Viewer` and plain functions there; the Tauri commands only hand the window's requests to them. `main.rs` just starts it. `linux.rs` sets up the AppImage and the print dialog: the PDF's name, and the preview's paper, orientation and margins, since WebKitGTK takes those from GTK rather than from `@page` (and prints a landscape page blank, so landscape is a portrait page wider than it is tall).
- Tauri's file associations take no icon, so each installer gets the icon of `.cssv` files its own way. The `.deb` and the `.rpm` install the PNGs into hicolor's `mimetypes` folders (`tauri.conf.json`). On macOS, `src-tauri/Info.plist` restates the document type Tauri makes of the association, with the `.icns` as its icon; a key there replaces Tauri's, so a change to the association goes in both. On Windows, `tauri.windows.conf.json` installs the `.ico` next to the program, and the NSIS installer's hook (`src-tauri/windows/hooks.nsh`) and the MSI's fragment (`file-icon.wxs`) point the file class's `DefaultIcon` at it: `CSSV table` for NSIS, `CSSV Viewer.cssv` for the MSI, the names Tauri gives them.
- `ui/index.html` and `tabs.js` are the window: the strip of tabs, each a frame showing `viewer.html` with one file or the home, and the command palette (`palette.js`), which lists the window's commands and those the current tab's page offers. A tab's page loads the first time the tab is shown, so files opened together don't all render at once. The frames reach the Rust side through the window's Tauri API, naming their tab.
- `ui/viewer.js` sets `src` on a `<cssv-table>` to that URL, blocks remote loads with a Content Security Policy until they are allowed, lists the `cssv-error` events, and calls `update()` with the new text when the file changes. `find.js`, `source.js` (with `highlight.js`, a copy of the website's CSSV colors), `export.js` and `print.js` (the print preview, adapted from the web editor's) are the toolbar's tools, `menu.js` its menus (adapted from the web editor's), and `prefs.js` what it remembers in `localStorage`. `boot.js` runs before a page is first drawn, so a tab that opens a file doesn't show the home while it loads, and the window and its tabs have the chosen theme's colors from the start.

Changing an imported stylesheet doesn't update the tab by itself; reload it.

## Releases

[`.github/workflows/build.yml`](.github/workflows/build.yml) builds the AppImage, the Linux packages and the macOS and Windows installers for each pull request, and attaches them to a GitHub release for each `v*` tag. The release names them without the version (`CSSV-Viewer-x86_64.AppImage`, `-amd64.deb`, `-x86_64.rpm`, `-macOS.dmg`, `-Windows-setup.exe`, `-Windows.msi`), so `https://github.com/rhpaiva/cssv-viewer/releases/latest/download/<name>` always gives the newest one, which is where [cssv.dev](https://cssv.dev/viewer.html#download) links. A tag with a hyphen, such as `v0.2.0-rc.1`, makes a pre-release, which that link skips.
