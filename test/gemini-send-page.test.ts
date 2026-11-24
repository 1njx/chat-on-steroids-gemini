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
