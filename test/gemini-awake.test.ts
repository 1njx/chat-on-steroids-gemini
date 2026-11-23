import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, expect, it } from 'vitest';

const source = readFileSync(new URL('../extension/gemini-awake.js', import.meta.url), 'utf8');
let dom: JSDOM;
afterEach(() => dom?.window.close());

/** A page in a covered window: hidden, unfocused, idle callbacks only run when given a timeout. */
function hiddenPage() {
  dom = new JSDOM('<input id="box">', { url: 'https://gemini.google.com/app', runScripts: 'outside-only' });
  const { window } = dom;
  const asked: Array<{ timeout?: number } | undefined> = [];
  (window as unknown as { requestIdleCallback: unknown }).requestIdleCallback =
    (callback: () => void, options?: { timeout?: number }) => { asked.push(options); if (options?.timeout) setTimeout(callback, 0); return asked.length; };
  Object.defineProperty(window.document, 'hidden', { configurable: true, get: () => true });
  Object.defineProperty(window.document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  window.Document.prototype.hasFocus = () => false;
  return { window, asked };
}

it('gives every untimed idle callback a 1 s timeout so it runs in a covered window, and keeps a set one', async () => {
  const { window, asked } = hiddenPage();
  window.eval(source);
  const ran = await new Promise<boolean>(resolve => {
    (window as unknown as { requestIdleCallback(cb: () => void): void }).requestIdleCallback(() => resolve(true));
    setTimeout(() => resolve(false), 200);
  });
  expect(ran).toBe(true);
  (window as unknown as { requestIdleCallback(cb: () => void, o: object): void }).requestIdleCallback(() => undefined, { timeout: 50 });
  expect(asked).toEqual([{ timeout: 1000 }, { timeout: 50 }]);
});

it('tells the page it is visible and focused, holds back visibilitychange and window blur only', () => {
  const { window } = hiddenPage();
  window.eval(source);
  window.eval(source); // a second injection changes nothing
  const doc = window.document;
  expect([doc.hidden, doc.visibilityState, doc.hasFocus()]).toEqual([false, 'visible', true]);
  const seen: string[] = [];
  doc.addEventListener('visibilitychange', () => seen.push('visibilitychange'));
  window.addEventListener('blur', event => seen.push(event.target === window ? 'window blur' : 'box blur'), true);
  doc.dispatchEvent(new window.Event('visibilitychange'));
  window.dispatchEvent(new window.FocusEvent('blur'));
  doc.getElementById('box')!.dispatchEvent(new window.FocusEvent('blur'));
  expect(seen).toEqual(['box blur']);
});
