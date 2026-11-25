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
 * It also holds a Web Lock so a covered tab is not frozen (below).
 *
 * Runs in the page (MAIN world) from document_start. No network, no DOM reads, no messages.
 */
(() => {
  'use strict';
  // Measured 2026-11-25 in Edge: about 30 s after its window was covered the whole tab froze (no
  // timer, message or extension script ran until it was shown again), so sends stalled and answers
  // reached the app only when the person looked at the tab. A page holding a Web Lock is not frozen
  // (the same covered tab then ran for 70 s and on). Each tab holds its own, for the page's life;
  // its own guard, so a tab that ran an older copy of this script takes it when the extension updates.
  if (!window.__cosGeminiLock) {
    window.__cosGeminiLock = true;
    try {
      const name = `cos-gemini-awake-${Math.random().toString(36).slice(2)}`;
      navigator.locks?.request(name, () => new Promise(() => {})).catch(() => undefined);
    } catch { /* no Web Locks: the tab may freeze while covered, as before */ }
  }

  // Its own guard too, so a tab that ran an older copy of this script gets it when the extension updates.
  if (!window.__cosGeminiFrames) {
    window.__cosGeminiFrames = true;
    // Measured 2026-11-25 in Edge: in a covered tab Gemini finished an answer but never drew it (0
    // characters on the page, still busy) until the tab was shown: it draws in animation frames, which
    // a covered window never runs. Each frame request also gets a timer; whichever comes first runs
    // it, once. The timer is set from a message task, so a chain of frames is not a chain of nested
    // timers (which Chrome runs once a minute in a tab hidden for 5 minutes).
    const FRAME_FALLBACK_MS = 100;
    const nativeFrame = window.requestAnimationFrame;
    const nativeCancelFrame = window.cancelAnimationFrame;
    if (typeof nativeFrame === 'function' && typeof nativeCancelFrame === 'function') {
      const frames = new Map();
      let nextFrame = 1;
      const run = (id, time) => {
        const frame = frames.get(id);
        if (!frame) return;
        frames.delete(id);
        nativeCancelFrame.call(window, frame.native);
        clearTimeout(frame.timer);
        frame.callback(time);
      };
      window.requestAnimationFrame = function requestAnimationFrame(callback) {
        const id = nextFrame++;
        const frame = { callback, native: 0, timer: 0 };
        frames.set(id, frame);
        frame.native = nativeFrame.call(window, time => run(id, time));
        const arm = () => { if (frames.get(id) === frame) frame.timer = setTimeout(() => run(id, performance.now()), FRAME_FALLBACK_MS); };
        if (typeof MessageChannel !== 'function') arm();
        else {
          const hop = new MessageChannel();
          hop.port1.onmessage = () => { hop.port1.close(); arm(); };
          hop.port2.postMessage(null);
        }
        return id;
      };
      window.cancelAnimationFrame = function cancelAnimationFrame(id) {
        const frame = frames.get(id);
        if (!frame) return;
        frames.delete(id);
        nativeCancelFrame.call(window, frame.native);
        clearTimeout(frame.timer);
      };
    }
  }

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
