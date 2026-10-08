// Runs before the page is first drawn, unlike the viewer.js module: a window
// that opens a file doesn't show the home while the file loads, and the
// window has the chosen theme's colors from the start (viewer.js then asks
// the window for that theme too, which the table's light-dark() follows).
{
  const root = document.documentElement;
  if (new URLSearchParams(location.search).has('file')) root.classList.add('opening');
  try {
    const theme = JSON.parse(localStorage.getItem('cssv-viewer:theme'));
    if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
  } catch {
    // no storage: the system's theme
  }
}
