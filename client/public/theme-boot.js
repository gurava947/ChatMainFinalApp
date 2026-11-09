// Runs before the stylesheet paints. Without it the first frame is always the
// default theme and the app visibly flashes when React settles the stored
// choice a tick later. The browser chrome colour is written from the same
// decision, because a media-query theme-colour would follow the OS while the
// page follows the user's own toggle.
//
// This lives in public/ rather than inline in index.html because the server
// sends `script-src 'self'`, which blocks inline scripts.
(function () {
  var dark;
  try {
    var stored = localStorage.getItem('inchat-theme');
    dark = stored ? stored === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch (err) {
    dark = true;
  }
  window.__inchatSetTheme = function (isDark) {
    document.documentElement.dataset.theme = isDark ? 'dark' : 'light';
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', isDark ? '#0b0d0c' : '#f4f7f5');
  };
  window.__inchatSetTheme(dark);

  // Accent and motion are page-level too: applying them after React mounts
  // would repaint the whole shell once, which is exactly the flash this file
  // exists to prevent.
  try {
    var accent = localStorage.getItem('inchat-accent');
    document.documentElement.dataset.accent = ['teal', 'indigo', 'rose', 'amber'].indexOf(accent) === -1 ? 'teal' : accent;
    document.documentElement.dataset.motion = localStorage.getItem('inchat-motion') === 'reduced' ? 'reduced' : 'full';
  } catch (err) {
    document.documentElement.dataset.accent = 'teal';
    document.documentElement.dataset.motion = 'full';
  }
})();
