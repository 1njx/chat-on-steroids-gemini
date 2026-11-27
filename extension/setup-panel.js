/**
 * The status panel a setup page shows while the extension works in it (Gemini custom apps,
 * ChatGPT's plugin pages, platform.openai.com): what it is doing, step by step, then done or the
 * exact error. It takes no clicks (pointer-events: none) and shows text only, never markup.
 * Addresses and keys are blanked out even if a caller passed one: the Core address ends in a
 * secret token.
 */
var CLF_SETUP_PANEL = (() => {
  const ID = 'cos-setup-panel';
  const TITLE = "Gem Web Code is setting this up — please don't click or type in this tab until it says done";
  const DONE_MS = 8_000;
  const FAILED_MS = 60_000;
  const COLORS = { working: '#f5a524', done: '#2e9d57', failed: '#d93025' };
  let steps = [];
  let hideTimer = null;

  /** Text safe to show: no web address and nothing shaped like a key or token. */
  const clean = value => String(value ?? '')
    .replace(/https?:\/\/\S+/gi, '[address]')
    .replace(/\b(?:sk|sess)-[A-Za-z0-9_-]{8,}/g, '[key]')
    .replace(/\s+/g, ' ').trim().slice(0, 300);

  function node() {
    let panel = document.getElementById(ID);
    if (panel) return panel;
    panel = document.createElement('div');
    panel.id = ID;
    panel.setAttribute('role', 'status');
    panel.setAttribute('aria-live', 'polite');
    Object.assign(panel.style, {
      position: 'fixed', top: '16px', right: '16px', zIndex: '2147483647', width: '340px', maxWidth: 'calc(100vw - 32px)',
      padding: '12px 14px', borderRadius: '10px', background: '#1f1f1f', color: '#fff', pointerEvents: 'none',
      font: '13px/1.45 system-ui, sans-serif', boxShadow: '0 6px 24px rgba(0,0,0,.4)', borderLeft: '4px solid'
    });
    (document.body || document.documentElement).append(panel);
    return panel;
  }

  function paint(state, ending = null) {
    const panel = node();
    panel.dataset.state = state;
    panel.style.borderLeftColor = COLORS[state];
    const line = (text, tag = 'div') => { const element = document.createElement(tag); element.textContent = text; return element; };
    const title = line(TITLE);
    title.style.fontWeight = '600';
    const list = document.createElement('ol');
    Object.assign(list.style, { margin: '8px 0 0', padding: '0 0 0 18px' });
    steps.forEach((step, index) => {
      const current = state === 'working' && index === steps.length - 1;
      const item = line(`${current ? '… ' : '✓ '}${step}`, 'li');
      item.dataset.step = current ? 'current' : 'done';
      list.append(item);
    });
    panel.replaceChildren(title, list);
    if (ending) {
      const end = line(ending);
      end.dataset.end = state;
      Object.assign(end.style, { marginTop: '8px', fontWeight: '600', color: COLORS[state] });
      panel.append(end);
    }
  }

  function later(ms) {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => document.getElementById(ID)?.remove(), ms);
  }

  return {
    /** Starts over, e.g. on a page the work moved to. */
    start(first) { steps = []; clearTimeout(hideTimer); if (first) this.step(first); else paint('working'); },
    /** The step being done now; the ones before it are done. */
    step(text) { clearTimeout(hideTimer); steps.push(clean(text)); paint('working'); },
    /** Green, then gone after about 8 s. */
    done(text = 'Done.') { paint('done', clean(text)); later(DONE_MS); },
    /** Red with the exact error; stays about a minute. */
    fail(text) {
      paint('failed', `${clean(text) || 'Something went wrong.'} The app shows the same message in Setup.`);
      later(FAILED_MS);
    },
    hide() { clearTimeout(hideTimer); steps = []; document.getElementById(ID)?.remove(); },
    /** What the panel says now, for tests: its state, steps and ending. */
    read() {
      const panel = document.getElementById(ID);
      return panel ? { state: panel.dataset.state, title: panel.firstChild?.textContent ?? '', steps: [...steps],
        ending: panel.querySelector('[data-end]')?.textContent ?? null } : null;
    },
  };
})();
