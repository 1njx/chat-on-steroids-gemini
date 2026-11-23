import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../extension/setup-panel.js', import.meta.url), 'utf8');
interface Panel {
  start(first?: string): void; step(text: string): void; done(text?: string): void; fail(text: string): void; hide(): void;
  read(): { state: string; title: string; steps: string[]; ending: string | null } | null;
}
let dom: JSDOM | null = null;
afterEach(() => { vi.useRealTimers(); dom?.window.close(); dom = null; });

function load(): { panel: Panel; doc: Document } {
  vi.useFakeTimers();
  dom = new JSDOM('<main><button id="page">page</button></main>', { url: 'https://platform.openai.com/settings/organization/tunnels', runScripts: 'outside-only' });
  dom.window.eval(source);
  return { panel: (dom.window as unknown as { CLF_SETUP_PANEL: Panel }).CLF_SETUP_PANEL, doc: dom.window.document };
}

it('shows each step live, marks the earlier ones done, and takes no clicks', () => {
  const { panel, doc } = load();
  panel.start('Looking for the tunnel');
  panel.step('Creating the tunnel');
  const node = doc.getElementById('cos-setup-panel')!;
  expect(node.style.pointerEvents).toBe('none');
  expect(node.getAttribute('role')).toBe('status');
  expect([...node.querySelectorAll('li')].map(item => [item.textContent, item.dataset.step]))
    .toEqual([['✓ Looking for the tunnel', 'done'], ['… Creating the tunnel', 'current']]);
  expect(panel.read()).toMatchObject({ state: 'working', ending: null,
    title: "Chat On Steroids is setting this up — please don't click or type in this tab until it says done" });
});

it('ends green and leaves after about 8 s', () => {
  const { panel, doc } = load();
  panel.start('Checking your ChatGPT sign-in');
  panel.done('Done: the plugin is created.');
  expect(panel.read()).toMatchObject({ state: 'done', ending: 'Done: the plugin is created.' });
  vi.advanceTimersByTime(7_900);
  expect(doc.getElementById('cos-setup-panel')).not.toBeNull();
  vi.advanceTimersByTime(200);
  expect(doc.getElementById('cos-setup-panel')).toBeNull();
});

it('ends red with the exact error, says the app shows it too, and stays about a minute', () => {
  const { panel, doc } = load();
  panel.start('Opening custom apps');
  panel.fail("Gemini's custom apps page did not look as expected, so nothing was filled in.");
  expect(panel.read()).toMatchObject({ state: 'failed',
    ending: "Gemini's custom apps page did not look as expected, so nothing was filled in. The app shows the same message in Setup." });
  vi.advanceTimersByTime(59_000);
  expect(doc.getElementById('cos-setup-panel')).not.toBeNull();
  vi.advanceTimersByTime(2_000);
  expect(doc.getElementById('cos-setup-panel')).toBeNull();
});

it('never shows an address, a key or markup, even when a caller passes one', () => {
  const { panel, doc } = load();
  panel.start('Adding <b>https://x.trycloudflare.com/mcp/core/secret-token</b>');
  panel.fail('Key sk-proj-abcdefghijklmnopqrstuvwxyz was refused');
  const text = doc.getElementById('cos-setup-panel')!.textContent!;
  expect(text).not.toMatch(/trycloudflare|secret-token|sk-proj/);
  expect(text).toContain('[address]');
  expect(text).toContain('[key]');
  expect(doc.querySelector('#cos-setup-panel b')).toBeNull();
});
