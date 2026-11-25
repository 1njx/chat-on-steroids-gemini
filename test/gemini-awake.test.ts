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

it('holds one Web Lock of its own for the page, also in a tab that ran an older copy, so a covered tab is not frozen', () => {
  const { window } = hiddenPage();
  const held: string[] = [];
  Object.defineProperty(window.navigator, 'locks', { configurable: true, value: { request(name: string, hold: () => Promise<void>) { held.push(name); void hold(); return Promise.resolve(); } } });
  // An older copy (before 2.2.20) already ran here: it set only the awake flag.
  (window as unknown as { __cosGeminiAwake: boolean }).__cosGeminiAwake = true;
  window.eval(source);
  window.eval(source); // a second injection takes no second lock
  expect(held).toHaveLength(1);
  expect(held[0]).toMatch(/^cos-gemini-awake-[a-z0-9]+$/);
});

it('runs an animation frame a covered window never draws on a timer instead, once, and cancels both', async () => {
  const { window } = hiddenPage();
  const native: Array<(time: number) => void> = [];
  const cancelled: number[] = [];
  Object.assign(window, {
    requestAnimationFrame: (callback: (time: number) => void) => native.push(callback),
    cancelAnimationFrame: (id: number) => cancelled.push(id),
  });
  // An older copy (before 2.2.20) already ran here, and the update injects this one twice: one wrapper.
  (window as unknown as { __cosGeminiAwake: boolean }).__cosGeminiAwake = true;
  window.eval(source);
  window.eval(source);
  const page = window as unknown as { requestAnimationFrame(cb: (t: number) => void): number; cancelAnimationFrame(id: number): void };
  const ran: string[] = [];
  page.requestAnimationFrame(() => ran.push('covered'));
  const drawn = page.requestAnimationFrame(() => ran.push('drawn'));
  const dropped = page.requestAnimationFrame(() => ran.push('dropped'));
  native[1]!(16); // a window on screen draws this one at once
  page.cancelAnimationFrame(dropped);
  await new Promise(resolve => setTimeout(resolve, 250));
  native[1]!(32); // a late native frame after the timer ran it changes nothing
  expect(ran).toEqual(['drawn', 'covered']);
  expect(cancelled).toEqual([2, 3, 1]);
  expect(drawn).toBe(2);
});
