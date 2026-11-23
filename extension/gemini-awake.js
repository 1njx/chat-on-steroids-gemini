/**
 * Keeps a Gemini tab working while its window is covered or in the background.
 *
 * Measured 2026-11-22 in Chrome: Gemini draws its model picker in an "on idle" deferred block. In
 * a tab whose window is not on screen a plain requestIdleCallback never ran (still pending after
 * 6 s, so the picker never appeared), while one given a timeout ran when it expired. Every idle
 * callback the page asks for therefore gets a 1 s timeout unless it set its own: work Gemini
 * defers to idle time still happens, at most a second late.
 *
 * Like the Focusly extension, the page is also told it is visible and focused, and
 * `visibilitychange` and window `blur` are held back, so Gemini does not pause in a background
 * tab. The extension's own isolated-world scripts still see the real values.
 *
 * Runs in the page (MAIN world) from document_start. No network, no DOM reads, no messages.
 */
(() => {
  'use strict';
  if (window.__cosGeminiAwake) return;
  window.__cosGeminiAwake = true;

  const IDLE_TIMEOUT_MS = 1000;
  const nativeIdle = window.requestIdleCallback;
  if (typeof nativeIdle === 'function') {
    window.requestIdleCallback = function requestIdleCallback(callback, options) {
      const timed = options && options.timeout > 0 ? options : { ...options, timeout: IDLE_TIMEOUT_MS };
      return nativeIdle.call(window, callback, timed);
    };
  }

  const pretend = (name, value) => {
    try { Object.defineProperty(document, name, { configurable: true, get: () => value }); } catch { /* keep the real one */ }
  };
  pretend('hidden', false);
  pretend('webkitHidden', false);
  pretend('visibilityState', 'visible');
  pretend('webkitVisibilityState', 'visible');
  try { Document.prototype.hasFocus = new Proxy(Document.prototype.hasFocus, { apply: () => true }); } catch { /* keep it */ }

  const hold = event => { event.stopImmediatePropagation(); };
  for (const type of ['visibilitychange', 'webkitvisibilitychange']) {
    document.addEventListener(type, hold, true);
    window.addEventListener(type, hold, true);
  }
  // Only the window's own blur: an element's blur (the composer losing focus) must still reach Gemini.
  window.addEventListener('blur', event => { if (event.target === window) hold(event); }, true);
})();
