import { test } from 'node:test';
import assert from 'node:assert/strict';
import { protectSymbols, restoreSymbols, cacheKey, createTranslator } from '../server/lib/translate.js';
import { Cache } from '../server/lib/cache.js';
import { createApp } from '../server/index.js';

test('protege y restaura símbolos de maná', () => {
  const { masked, symbols } = protectSymbols('{T}: Add {G}{G}.');
  assert.equal(masked, '⟨0⟩: Add ⟨1⟩⟨2⟩.');
  assert.equal(restoreSymbols('⟨0⟩: Añade ⟨ 1 ⟩⟨2⟩.', symbols), '{T}: Añade {G}{G}.');
});

test('la clave de caché cambia si cambia el texto oracle', () => {
  const a = cacheKey('es', { key: 'x:0', name: 'A', type_line: 'T', oracle_text: 'old' });
  const b = cacheKey('es', { key: 'x:0', name: 'A', type_line: 'T', oracle_text: 'new' });
  assert.notEqual(a, b);
});

test('traduce con la IA usando salida estructurada y guarda en caché', async () => {
  const calls = [];
  const fakeAnthropic = {
    beta: {
      messages: {
        create: async (params) => {
          calls.push(params);
          const input = JSON.parse(params.messages[0].content.replace(/^[^[]*/, ''));
          return {
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: JSON.stringify({ cards: input.map((c) => ({ key: c.key, name: `ES ${c.name}`, type_line: 'Artefacto', oracle_text: '{T}: Agrega {C}{C}.' })) }) }],
          };
        },
      },
    },
  };
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: [], cards: [] }) });
  try {
    const t = createTranslator({ anthropic: fakeAnthropic, model: 'claude-opus-5-5', cache: new Cache(), scryfall: (fn) => fn() });
    const cards = [{ key: 'sol:0', name: 'Sol Ring', type_line: 'Artifact', oracle_text: '{T}: Add {C}{C}.' }];
    const [r] = await t.translate('es', cards);
    assert.equal(r.source, 'ai');
    assert.equal(r.name, 'ES Sol Ring');
    assert.equal(calls[0].output_config.format.type, 'json_schema');
    assert.equal(calls[0].fallbacks, 'default');
    const [again] = await t.translate('es', cards);
    assert.equal(again.cached, true);
    assert.equal(calls.length, 1);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('sin IA usa la traducción automática como respaldo', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('mymemory')) {
      const q = new URL(u).searchParams.get('q');
      return { ok: true, json: async () => ({ responseStatus: 200, responseData: { translatedText: `[es] ${q}` } }) };
    }
    return { ok: true, json: async () => ({ cards: [] }) };
  };
  try {
    const t = createTranslator({ cache: new Cache(), scryfall: (fn) => fn() });
    const [r] = await t.translate('es', [{ key: 'k', name: 'Sol Ring', type_line: 'Artifact', oracle_text: '{T}: Add {C}{C}.' }]);
    assert.equal(r.source, 'machine');
    assert.equal(r.oracle_text, '[es] {T}: Add {C}{C}.');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('API: valida peticiones de traducción y el proxy de imágenes', async () => {
  const app = createApp({});
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const status = await (await fetch(`${base}/api/status`)).json();
    assert.equal(status.ai, false);
    const bad = await fetch(`${base}/api/translate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lang: 'xx', cards: [] }) });
    assert.equal(bad.status, 400);
    const img = await fetch(`${base}/api/image?url=${encodeURIComponent('https://evil.example.com/a.png')}`);
    assert.equal(img.status, 400);
    const index = await fetch(`${base}/`);
    assert.equal(index.status, 200);
  } finally {
    server.close();
  }
});
