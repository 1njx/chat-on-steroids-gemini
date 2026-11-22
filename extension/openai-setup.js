/*
 * "Set it up for me" at platform.openai.com, in the person's own signed-in tab (src/main/setup-tasks.ts).
 * Runs only in a tab the extension opened with a `cos-task` marker. On Tunnels it takes the tunnel
 * the app already uses or one named for this app, or creates one; on API keys it creates a
 * Restricted key with Tunnels: Read and Use and hands it straight to the app, which keeps it only
 * in the system's secret store. Shapes observed on the live pages on 2026-11-22 (English UI).
 * shortcut: English labels for buttons and fields; another language fails with the manual steps.
 * A page that does not look as observed creates nothing. It never signs in or stores a password.
 */
(() => {
  const TUNNEL_ID = /tunnel_[0-9a-f]{32}/;
  const OPENAI_KEY = /^sk-[A-Za-z0-9_-]{20,300}$/;
  const LAYOUT = "platform.openai.com did not look as expected, so nothing was created";
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const shown = node => !!node && node.isConnected && node.getClientRects().length > 0;
  const plain = node => (node?.textContent || '').replace(/\s+/g, ' ').trim();
  /** The pickers open and choose on pointer events; a bare click() leaves them shut (measured). */
  const press = node => {
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'])
      node.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse', isPrimary: true }));
  };
  const fill = (field, value) => {
    const proto = field.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    return field.value === value;
  };
  const waitFor = async (find, ms = 10_000) => {
    for (const end = Date.now() + ms; ; await sleep(250)) {
      const found = find();
      if (found || Date.now() > end) return found || null;
    }
  };
  const button = (root, text) => [...root.querySelectorAll('button')].find(node => plain(node) === text && shown(node)) || null;
  const dialogTitled = title => [...document.querySelectorAll('[role="dialog"]')].find(node => shown(node) && plain(node.querySelector('h1,h2,h3')) === title) || null;
  const options = () => [...document.querySelectorAll('[role="listbox"] [role="option"]')].filter(shown);
  /** Clicks a button that opens a dialog; a click before the page is ready opens nothing, so once more. */
  const openDialog = async (open, form, ms) => {
    open.click();
    const found = await waitFor(form, ms);
    if (found) return found;
    open.click();
    return waitFor(form, ms);
  };
  /** The picker that follows a field's label inside a dialog. */
  const pickerAfter = (dialog, label) => {
    // The label's text sits a few elements deep (label > div > div, observed): climb to its field.
    let node = [...dialog.querySelectorAll('label, div, span')].find(candidate => candidate.children.length === 0 && plain(candidate) === label);
    for (let depth = 0; node && node !== dialog && depth < 6; depth++, node = node.parentElement) {
      const picker = node.querySelector('[role="button"]');
      if (picker) return picker;
    }
    return null;
  };

  /** The Tunnels table: each row's name (its first line) and tunnel ID. */
  function tunnelRows() {
    return [...document.querySelectorAll('table tbody tr')].map(row => ({
      name: plain(row.querySelector('td span')),
      id: (row.textContent.match(TUNNEL_ID) || [])[0] || null
    })).filter(row => row.id);
  }
  /** The tunnel the app already uses, or the one named for this app. */
  function findTunnel(task) {
    const rows = tunnelRows();
    return rows.find(row => row.id === task.knownTunnelId)?.id ||
      rows.find(row => row.name.toLowerCase() === String(task.tunnelName).toLowerCase())?.id || null;
  }
  function tunnelForm() {
    const dialog = dialogTitled('Create tunnel');
    if (!dialog) return null;
    const names = dialog.querySelectorAll('input[type="text"]'), descriptions = dialog.querySelectorAll('textarea');
    const create = button(dialog, 'Create'), workspace = pickerAfter(dialog, 'ChatGPT workspaces');
    if (names.length !== 1 || descriptions.length !== 1 || !create || !workspace) return null;
    return { dialog, name: names[0], description: descriptions[0], workspace, create };
  }
  async function createTunnel(task) {
    const open = await waitFor(() => button(document, 'Create tunnel'), 15_000);
    if (!open) return { error: LAYOUT };
    const form = await openDialog(open, tunnelForm, 5_000);
    if (!form || !fill(form.name, task.tunnelName) || !fill(form.description, task.tunnelDescription)) return { error: LAYOUT };
    // The tunnel belongs in the ChatGPT workspace the person uses; with several, they choose.
    press(form.workspace);
    const offered = await waitFor(() => options().length ? options() : null, 5_000);
    if (!offered) return { error: LAYOUT };
    if (offered.length !== 1) return { error: 'Your account has several ChatGPT workspaces. Create the tunnel by hand in the one you use in ChatGPT' };
    if (offered[0].getAttribute('aria-selected') !== 'true') press(offered[0]);
    const ready = await waitFor(() => offered[0].getAttribute('aria-selected') === 'true' && !form.create.disabled, 3_000);
    if (!ready) return { error: LAYOUT };
    form.create.click();
    const id = await waitFor(() => tunnelRows().find(row => row.name === task.tunnelName)?.id, 15_000);
    return id ? { tunnelId: id } : { error: 'platform.openai.com did not show the new tunnel' };
  }

  function keyForm() {
    const dialog = dialogTitled('Create new secret key');
    if (!dialog) return null;
    const radio = text => [...dialog.querySelectorAll('[role="radio"]')].find(node => plain(node) === text) || null;
    const names = dialog.querySelectorAll('input[type="text"]');
    const tunnels = [...dialog.querySelectorAll('button')].find(node => plain(node) === 'Tunnels');
    const tunnelsPicker = tunnels?.parentElement?.querySelector('[role="button"][data-state]') || null;
    const project = pickerAfter(dialog, 'Project') || [...dialog.querySelectorAll('[role="button"]')].find(node => /^Select project/.test(plain(node))) || null;
    const submit = dialog.querySelector('button[type="submit"]');
    if (!radio('You') || !radio('Restricted') || names.length !== 1 || !project || !submit) return null;
    return { dialog, you: radio('You'), restricted: radio('Restricted'), name: names[0], project, submit, tunnels: () => {
      const label = [...dialog.querySelectorAll('button')].find(node => plain(node) === 'Tunnels');
      return label?.parentElement?.querySelector('[role="button"][data-state]') || tunnelsPicker;
    } };
  }
  /** The new key, shown once after Create: never logged, never put in a URL, sent only to the app. */
  function shownKey() {
    for (const dialog of [...document.querySelectorAll('[role="dialog"]')].filter(shown)) {
      for (const input of dialog.querySelectorAll('input, textarea')) if (OPENAI_KEY.test(input.value.trim())) return input.value.trim();
      for (const node of dialog.querySelectorAll('code, pre, span, div')) if (node.children.length === 0 && OPENAI_KEY.test(plain(node))) return plain(node);
    }
    return null;
  }
  async function createKey(task) {
    const open = await waitFor(() => button(document, 'Create new secret key'), 15_000);
    if (!open) return { error: LAYOUT };
    const form = await openDialog(open, keyForm, 8_000);
    if (!form) return { error: LAYOUT };
    if (form.you.getAttribute('aria-checked') !== 'true') form.you.click();
    if (!fill(form.name, task.keyName)) return { error: LAYOUT };
    press(form.project);
    const projects = await waitFor(() => options().length ? options() : null, 5_000);
    const project = projects && (projects.find(option => plain(option) === 'Default project') || (projects.length === 1 ? projects[0] : null));
    if (!project) return { error: 'Choose a project for the key by hand at platform.openai.com' };
    press(project);
    await sleep(400);
    form.restricted.click();
    const tunnels = await waitFor(() => form.restricted.getAttribute('aria-checked') === 'true' && form.tunnels(), 3_000);
    if (!tunnels) return { error: LAYOUT };
    press(tunnels);
    const scopes = await waitFor(() => { const found = options().filter(option => ['Read', 'Use'].includes(plain(option))); return found.length === 2 ? found : null; }, 3_000);
    if (!scopes) return { error: LAYOUT };
    for (const scope of scopes) if (scope.getAttribute('aria-selected') !== 'true') { press(scope); await sleep(300); }
    const ready = await waitFor(() => scopes.every(scope => scope.getAttribute('aria-selected') === 'true') && !form.submit.disabled, 3_000);
    if (!ready) return { error: LAYOUT };
    form.submit.click();
    const key = await waitFor(shownKey, 15_000);
    return key ? { key } : { error: 'OpenAI created the key but it could not be read here: copy it from the open page into Setup' };
  }

  const taskId = (() => {
    try { const id = new URL(location.href).searchParams.get('cos-task'); return /^[a-f0-9-]{36}$/i.test(id || '') ? id : null; }
    catch { return null; }
  })();
  const report = (action, extra = {}) => chrome.runtime.sendMessage({ type: 'setup_task', action, id: taskId, ...extra }).catch(() => null);
  async function run() {
    const task = (await report('get'))?.task;
    if (!task || task.kind !== 'openai-setup') return;
    const tunnelsPage = location.pathname === '/settings/organization/tunnels', keysPage = location.pathname === '/settings/organization/api-keys';
    if (task.state === 'requested' && tunnelsPage) {
      if ((await report('claim'))?.ok !== true) return;
      // The table loads after the Create button: an existing tunnel must be seen before creating one.
      await waitFor(() => tunnelRows().length ? true : null, 20_000);
      const found = findTunnel(task);
      const made = found ? { tunnelId: found } : await createTunnel(task);
      if (!made.tunnelId) return report('fail', { error: made.error });
      if ((await report('progress', { progress: 'tunnel', tunnelId: made.tunnelId }))?.ok !== true) return;
      location.assign(`/settings/organization/api-keys?cos-task=${taskId}`);
      return;
    }
    if (task.progress === 'tunnel' && keysPage) {
      // A claim that lapsed on the way here is taken again by this same helper tab.
      if (task.state === 'requested' && (await report('claim'))?.ok !== true) return;
      const made = await createKey(task);
      if (!made.key) return report('fail', { error: made.error });
      if ((await report('progress', { progress: 'key', key: made.key }))?.ok !== true) return report('fail', { error: 'The app did not take the key' });
      const done = [...document.querySelectorAll('[role="dialog"] button')].find(node => plain(node) === 'Done');
      if (done) done.click();
      await report('done', { outcome: 'done' });
    }
  }

  globalThis.CLF_OPENAI = { tunnelRows, findTunnel, tunnelForm, keyForm, shownKey, createTunnel, createKey };
  if (taskId && typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) setTimeout(() => void run().catch(() => undefined), 1500);
})();
