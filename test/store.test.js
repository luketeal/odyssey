import test from 'node:test';
import assert from 'node:assert/strict';

// Minimal localStorage stand-in, installed before the store module loads.
class MemoryStorage {
  #m = new Map();
  get length() { return this.#m.size; }
  key(i) { return [...this.#m.keys()][i] ?? null; }
  getItem(k) { return this.#m.has(k) ? this.#m.get(k) : null; }
  setItem(k, v) { this.#m.set(k, String(v)); }
  removeItem(k) { this.#m.delete(k); }
}

async function freshStore(seed = {}) {
  globalThis.localStorage = new MemoryStorage();
  for (const [k, v] of Object.entries(seed)) localStorage.setItem(k, v);
  const mod = await import(`../site/js/store.js?${Math.random()}`);
  return mod.store;
}

test('nothing is written to the browser by default', async () => {
  const store = await freshStore();
  assert.equal(store.mode(), 'none');
  store.setProgress('aio-1', { pos: { u: 10 } });
  store.setUi({ lastId: 'aio-1' });
  assert.equal(localStorage.length, 0);
  assert.equal(store.hasUnsaved(), true);
  assert.equal(store.progress('aio-1').pos.u, 10);
});

test('UI-only changes do not light up the unsaved indicator', async () => {
  const store = await freshStore();
  store.setUi({ lastId: 'aio-1' });
  store.markBroken('x');
  assert.equal(store.hasUnsaved(), false);
});

test('save once, then later changes are unsaved until saved again', async () => {
  const store = await freshStore();
  store.setProgress('aio-1', { pos: { u: 10 } });
  store.saveOnce();
  assert.equal(store.mode(), 'manual');
  assert.equal(store.hasUnsaved(), false);
  store.setProgress('aio-1', { pos: { u: 99 } });
  assert.equal(store.hasUnsaved(), true);
  assert.equal(JSON.parse(localStorage.getItem('aio:v1:progress'))['aio-1'].pos.u, 10);
});

test('a saved snapshot loads on the next visit', async () => {
  const store = await freshStore({ 'aio:v1:progress': JSON.stringify({ 'aio-2': { pos: { u: 5 } } }) });
  assert.equal(store.mode(), 'manual');
  assert.equal(store.progress('aio-2').pos.u, 5);
  assert.equal(store.hasUnsaved(), false);
});

test('autosave writes every change; delete removes everything', async () => {
  const store = await freshStore();
  store.setAutosave(true);
  assert.equal(store.mode(), 'auto');
  store.setProgress('aio-3', { pos: { u: 42 } });
  assert.equal(JSON.parse(localStorage.getItem('aio:v1:progress'))['aio-3'].pos.u, 42);
  assert.equal(store.hasUnsaved(), false);
  store.deleteSaved();
  assert.equal(localStorage.length, 0);
  assert.equal(store.mode(), 'none');
  assert.equal(store.progress('aio-3').pos.u, 42, 'this visit keeps its data in memory');
  assert.equal(store.hasUnsaved(), true);
});

test('autosave survives a reload', async () => {
  const store = await freshStore({ 'aio:v1:autosave': 'true', 'aio:v1:prefs': '{"rate":1.5}' });
  assert.equal(store.mode(), 'auto');
  assert.equal(store.prefs().rate, 1.5);
});

test('re-saving the same data does not count as unsaved', async () => {
  const store = await freshStore();
  store.setProgress('aio-1', { pos: { u: 10 } });
  store.saveOnce();
  store.setProgress('aio-1', { pos: { u: 10 } });
  assert.equal(store.hasUnsaved(), false);
  store.setProgress('aio-1', { pos: { u: 11 } });
  assert.equal(store.hasUnsaved(), true);
  store.setProgress('aio-1', { pos: { u: 10 } });
  assert.equal(store.hasUnsaved(), false, 'back to the saved value');
});

test('a reloaded snapshot is not unsaved until something changes', async () => {
  const store = await freshStore({ 'aio:v1:progress': JSON.stringify({ 'aio-2': { pos: { u: 5 } } }) });
  store.setProgress('aio-2', { pos: { u: 5 } });
  assert.equal(store.hasUnsaved(), false);
});
