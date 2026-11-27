import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';
import { afterEach, expect, it } from 'vitest';

const domSource = readFileSync(new URL('../extension/gemini-dom.js', import.meta.url), 'utf8');
const contentSource = readFileSync(new URL('../extension/gemini-content.js', import.meta.url), 'utf8');

let dom: JSDOM | null = null;
afterEach(() => { dom?.window.close(); dom = null; });

/** The content script on a Gemini page at `url`, handed one new-chat send; returns what it reported. */
async function sendFrom(url: string, { composerAfterMs = -1 } = {}) {
  dom = new JSDOM('<a aria-label="Google Account: Pat (pat@example.com)" href="#"></a><main id="main"></main>',
    { url, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: new VirtualConsole() });
  const { window } = dom;
  window.document.documentElement.lang = 'en';
  if (composerAfterMs >= 0) {
    setTimeout(() => {
      window.document.getElementById('main')!.innerHTML = '<rich-textarea><div class="ql-editor" contenteditable="true"></div></rich-textarea>';
    }, composerAfterMs);
  }
  const results: Array<Record<string, unknown>> = [];
  let handed = false;
  (window as unknown as { chrome: unknown }).chrome = { runtime: { id: 'test', lastError: undefined, sendMessage(payload: Record<string, unknown>, reply: (value: unknown) => void) {
    if (payload.type === 'gemini_result') results.push(payload);
    const commands = payload.type === 'gemini_state' && !handed ? [{ id: 'send-1', kind: 'send', prompt: 'hi', conversationId: null, connector: null }] : [];
    if (commands.length) handed = true;
    // Withholding the go-ahead keeps the test from pressing Send.
    setTimeout(() => reply(payload.type === 'gemini_result' && payload.stage === 'sending' ? { ok: true, authorized: false } : { ok: true, commands }), 0);
  } } };
  window.eval(domSource);
  window.eval(contentSource);
  for (const end = Date.now() + 5000; Date.now() < end && !results.some(r => ['navigating', 'failed'].includes(String(r.stage))); ) await new Promise(r => setTimeout(r, 50));
  return results;
}

it('opens /app for a new chat when handed a send on a page without a composer (custom apps)', async () => {
  const results = await sendFrom('https://gemini.google.com/customize/connectors');
  expect(results[0]).toMatchObject({ id: 'send-1', stage: 'navigating' });
});

it('waits on /app for a composer drawn late, then fills it and asks the app before sending', async () => {
  const results = await sendFrom('https://gemini.google.com/app', { composerAfterMs: 500 });
  expect(results.map(r => r.stage)).toEqual(['sending', 'failed']);
  expect(results[1]).toMatchObject({ error: 'withdrawn' });
});

it("takes a finished answer whose busy marker a covered tab never cleared, once its text held still", async () => {
  dom = new JSDOM(`<a aria-label="Google Account: Pat (pat@example.com)" href="#"></a>
    <infinite-scroller data-test-id="chat-history-container"></infinite-scroller>
    <rich-textarea><div class="ql-editor" contenteditable="true"></div></rich-textarea><button aria-label="Send message">send</button>`,
  { url: 'https://gemini.google.com/app', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: new VirtualConsole() });
  const { window } = dom;
  const doc = window.document;
  doc.documentElement.lang = 'en';
  Object.defineProperty(window.HTMLElement.prototype, 'getClientRects', { value() { return [{ width: 10, height: 10 }]; } });
  // Gemini takes the message, draws the answer and drops Stop, but leaves aria-busy on (as live in a covered tab).
  doc.querySelector('button[aria-label="Send message"]')!.addEventListener('click', () => {
    doc.querySelector('.ql-editor')!.textContent = '';
    doc.querySelector('infinite-scroller')!.innerHTML = '<div class="conversation-container" id="turn1"><user-query><div class="query-text">hi</div></user-query>' +
      '<model-response><div aria-busy="true"><message-content><div class="markdown"><p>I can see one folder.</p></div></message-content></div></model-response></div>';
  });
  const results: Array<Record<string, unknown>> = [];
  let handed = false;
  (window as unknown as { chrome: unknown }).chrome = { runtime: { id: 'test', lastError: undefined, sendMessage(payload: Record<string, unknown>, reply: (value: unknown) => void) {
    if (payload.type === 'gemini_result') results.push(payload);
    const commands = payload.type === 'gemini_state' && !handed ? [{ id: 'send-1', kind: 'send', prompt: 'hi', conversationId: null, connector: null }] : [];
    if (commands.length) handed = true;
    setTimeout(() => reply(payload.type === 'gemini_result' && payload.stage === 'sending' ? { ok: true, authorized: true } : { ok: true, commands }), 0);
  } } };
  window.eval(domSource);
  window.eval(contentSource);
  for (const end = Date.now() + 20_000; Date.now() < end && !results.some(r => ['completed', 'failed'].includes(String(r.stage))); ) await new Promise(r => setTimeout(r, 100));
  expect(results.map(r => r.stage)).toEqual(['sending', 'sent', 'completed']);
  expect(results[2]).toMatchObject({ answer: 'I can see one folder.' });
}, 30_000);

/** Gemini's tool approval card as drawn inside an answer (live markup 2026-11-25, trimmed). */
const CARD = '<div class="attachment-container action-card"><response-element class="no-md"><action-card><div class="container"><remy-confirmation-card-v2>' +
  '<h3 class="header-text"> Gem Web Code Core </h3><div class="body-text"><div class="v2-body-content"><div class="body-row"><div class="body-text body-text--collapsed">' +
  '<p>Let Gemini use <strong>exec command</strong>?</p></div></div><div class="disclaimer-text"><p>Choose to let Gemini take action on this app without asking again.</p></div>' +
  '<div class="button-row"><button>Don\'t allow</button><button>Allow once</button><button aria-disabled="false"><span>Always allow</span></button></div></div></div>' +
  '</remy-confirmation-card-v2></div></action-card></response-element></div>';

/** One authorized send on a page whose answer first asks for approval; `answer()` draws the real answer. */
async function sendWithApproval(alwaysAllow: string | null, until: (results: Array<Record<string, unknown>>) => boolean,
  { connector = null as string | null, cardApp = 'Gem Web Code Core', offered = [] as string[] } = {}) {
  dom = new JSDOM(`<a aria-label="Google Account: Pat (pat@example.com)" href="#"></a>
    <infinite-scroller data-test-id="chat-history-container"></infinite-scroller>
    <rich-textarea><div class="ql-editor" contenteditable="true"></div></rich-textarea><button aria-label="Send message">send</button>`,
  { url: 'https://gemini.google.com/app', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: new VirtualConsole() });
  const { window } = dom;
  const doc = window.document;
  doc.documentElement.lang = 'en';
  Object.defineProperty(window.HTMLElement.prototype, 'getClientRects', { value() { return [{ width: 10, height: 10 }]; } });
  const answer = () => { doc.querySelector('.markdown')!.innerHTML = '<p>Your folder has 3 files.</p>'; };
  doc.querySelector('button[aria-label="Send message"]')!.addEventListener('click', () => {
    doc.querySelector('.ql-editor')!.textContent = '';
    doc.querySelector('infinite-scroller')!.innerHTML = '<div class="conversation-container" id="turn1"><user-query><div class="query-text">list my files</div></user-query>' +
      `<model-response><message-content><div class="markdown">${CARD.replace('Gem Web Code Core', cardApp)}</div></message-content></model-response></div>`;
    [...doc.querySelectorAll('remy-confirmation-card-v2 button')].find(b => b.textContent === 'Always allow')!.addEventListener('click', answer);
  });
  const results: Array<Record<string, unknown>> = [];
  const focused: unknown[] = [];
  let handed = false;
  (window as unknown as { chrome: unknown }).chrome = { runtime: { id: 'test', lastError: undefined, sendMessage(payload: Record<string, unknown>, reply: (value: unknown) => void) {
    if (payload.type === 'gemini_result') results.push(payload);
    if (payload.type === 'gemini_focus') focused.push(payload);
    const commands = payload.type === 'gemini_state' && !handed ? [{ id: 'send-1', kind: 'send', prompt: 'list my files', conversationId: null, connector, alwaysAllow }] : [];
    if (commands.length) handed = true;
    setTimeout(() => reply(payload.type === 'gemini_result' && payload.stage === 'sending' ? { ok: true, authorized: true } : { ok: true, commands }), 0);
  } } };
  window.eval(domSource);
  // Gemini's @ menu offers only these app names; the chip itself is not drawn here.
  const mentioned: string[] = [];
  const api = (window as unknown as { CLF_GEMINI_DOM: { mentionConnector: (name: string) => Promise<boolean>; appendPrompt: (text: string) => boolean } }).CLF_GEMINI_DOM;
  api.mentionConnector = async name => { mentioned.push(name); return offered.includes(name); };
  // jsdom has no execCommand; the prompt after a mention is typed into the box directly.
  api.appendPrompt = text => { doc.querySelector('.ql-editor')!.textContent += text; return true; };
  window.eval(contentSource);
  for (const end = Date.now() + 20_000; Date.now() < end && !until(results); ) await new Promise(r => setTimeout(r, 100));
  return { results, focused, answer, mentioned };
}

it("never reports Gemini's tool approval card as the answer; Full access presses Always allow on this app's card", async () => {
  const { results, focused } = await sendWithApproval('Gem Web Code Core', r => r.some(x => ['completed', 'failed'].includes(String(x.stage))));
  expect(results.map(r => r.stage)).toEqual(['sending', 'sent', 'completed']);
  expect(results[2]).toMatchObject({ answer: 'Your folder has 3 files.' });
  expect(focused).toEqual([]);
}, 30_000);

it('mentions the app under its pre-2.3.0 name when Gemini offers only that one, and Full access answers its card', async () => {
  const done = (r: Array<Record<string, unknown>>) => r.some(x => ['completed', 'failed'].includes(String(x.stage)));
  const { results, mentioned } = await sendWithApproval('Gem Web Code Core', done,
    { connector: 'Gem Web Code Core', cardApp: 'Chat On Steroids Core', offered: ['Chat On Steroids Core'] });
  expect(mentioned).toEqual(['Gem Web Code Core', 'Chat On Steroids Core']);
  expect(results.map(r => r.stage)).toEqual(['sending', 'sent', 'completed']);
  dom!.window.close(); dom = null;
  const missing = await sendWithApproval(null, done, { connector: 'Gem Web Code Core', offered: [] });
  expect(missing.results.at(-1)).toMatchObject({ stage: 'failed', error: 'connector-not-offered', connector: 'Gem Web Code Core' });
}, 60_000);

it("without Full access it waits on the card, tells the app once and shows the tab, then takes the real answer", async () => {
  let answered = false;
  const run = await sendWithApproval(null, r => {
    if (!answered && r.some(x => x.stage === 'approval')) { answered = true; setTimeout(() => drawAnswer(), 1500); }
    return r.some(x => ['completed', 'failed'].includes(String(x.stage)));
  });
  function drawAnswer() { (dom!.window.document.querySelector('.markdown') as HTMLElement).innerHTML = '<p>Your folder has 3 files.</p>'; }
  expect(run.results.map(r => r.stage)).toEqual(['sending', 'sent', 'approval', 'approval', 'completed']);
  expect(run.results[2]).toMatchObject({ approval: 'Gem Web Code Core: Let Gemini use exec command?' });
  expect(run.results[3]).toMatchObject({ approval: '' });
  expect(run.results[4]).toMatchObject({ answer: 'Your folder has 3 files.' });
  expect(run.focused).toHaveLength(1);
}, 30_000);

it("Full access leaves another app's approval card to the person", async () => {
  const { results } = await sendWithApproval('Some Other App', r => r.some(x => x.stage === 'approval'));
  expect(results.map(r => r.stage)).toEqual(['sending', 'sent', 'approval']);
  expect(dom!.window.document.querySelector('remy-confirmation-card-v2')).not.toBeNull();
}, 30_000);
