import { test } from 'node:test';
import assert from 'node:assert/strict';
import { protectSymbols, restoreSymbols, cacheKey, createTranslator } from '../server/lib/translate.js';
import { TranslationMemory, mask, unmask } from '../server/lib/memory.js';
import { applyFixes } from '../server/lib/machine.js';
import { Cache } from '../server/lib/cache.js';
import { createApp } from '../server/index.js';

const official = (name, printed_name, type_line, printed_type_line, oracle_text, printed_text) => ({
  name, printed_name, type_line, printed_type_line, oracle_text, printed_text,
});

function sampleMemory() {
  const mem = new TranslationMemory('es');
  mem.addCard(official('Llanowar Elves', 'Elfos de Llanowar', 'Creature — Elf Druid', 'Criatura — Elfo druida', '{T}: Add {G}.', '{T}: Agrega {G}.'));
  mem.addCard(official('Goblin Guide', 'Guía trasgo', 'Creature — Goblin', 'Criatura — Trasgo', 'Haste\nWhenever Goblin Guide attacks, defending player reveals the top card of their library.', 'Prisa.\nSiempre que la Guía trasgo ataque, el jugador defensor revela la primera carta de su biblioteca.'));
  mem.addCard(official('Serra Angel', 'Ángel de Serra', 'Creature — Angel', 'Criatura — Ángel', 'Flying, vigilance', 'Vuela, vigilancia.'));
  mem.addCard(official('Wind Drake', 'Dragón del viento', 'Creature — Drake', 'Criatura — Dragón', 'Flying', 'Vuela.'));
  mem.addCard(official('Raging Goblin', 'Trasgo enfurecido', 'Creature — Goblin Berserker', 'Criatura — Trasgo berserker', 'Haste', 'Prisa.'));
  mem.addCard(official('Divination', 'Adivinación', 'Sorcery', 'Conjuro', 'Draw two cards.', 'Roba dos cartas.'));
  mem.addCard(official('Shock', 'Electrochoque', 'Instant', 'Instantáneo', 'Shock deals 2 damage to any target.', 'El Electrochoque hace 2 puntos de daño a cualquier objetivo.'));
  return mem;
}

test('protege y restaura símbolos de maná', () => {
  const { masked, symbols } = protectSymbols('{T}: Add {G}{G}.');
  assert.equal(masked, '⟨0⟩: Add ⟨1⟩⟨2⟩.');
  assert.equal(restoreSymbols('⟨0⟩: Añade ⟨ 1 ⟩⟨2⟩.', symbols), '{T}: Añade {G}{G}.');
});

test('mask generaliza nombre, símbolos y números en una sola pasada', () => {
  const m = mask('Shock deals 2 damage. {2}{R}: Draw.', ['Shock']);
  assert.equal(m.key, '~ deals ⟦0⟧ damage. ⟨0⟩⟨1⟩: Draw.');
  assert.equal(unmask('~ hace ⟦0⟧. ⟨0⟩⟨1⟩', m, 'Choque'), 'Choque hace 2. {2}{R}');
});

test('la memoria reutiliza plantillas oficiales con otros símbolos, números y nombres', () => {
  const mem = sampleMemory();
  assert.equal(mem.translateLine('{T}: Add {R}.', ['Mountain Elf'], '~').text, '{T}: Agrega {R}.');
  assert.equal(mem.translateLine('Lightning Bolt deals 3 damage to any target.', ['Lightning Bolt'], '~').text, 'El ~ hace 3 puntos de daño a cualquier objetivo.');
  assert.equal(mem.translateLine('Flying, haste', [], '~').text, 'Vuela, prisa.');
  const partial = mem.translateLine('Draw two cards. Untap target land.', [], '~');
  assert.equal(partial.text, 'Roba dos cartas. ⟪0⟫');
  assert.deepEqual(partial.pending, ['Untap target land.']);
});

test('la memoria traduce líneas de tipo y elige la traducción más repetida', () => {
  const mem = sampleMemory();
  assert.deepEqual(mem.translateType('Creature — Goblin'), { text: 'Criatura — Trasgo', pending: [] });
  const r = mem.translateType('Creature — Elf Wizard');
  assert.equal(r.text, 'Criatura — Elfo hechicero');
  const copy = TranslationMemory.fromJSON(JSON.parse(JSON.stringify(mem.toJSON())));
  assert.equal(copy.translateLine('Draw two cards.', [], '~').text, 'Roba dos cartas.');
});

test('correcciones de terminología tras la traducción automática', () => {
  assert.equal(applyFixes('Paga 3 vidas: Suma {R}.', 'es'), 'Paga 3 vidas: Agrega {R}.');
});

test('la clave de caché cambia si cambia el texto', () => {
  const a = cacheKey('es', { key: 'x:0', name: 'A', type_line: 'T', oracle_text: 'old' });
  const b = cacheKey('es', { key: 'x:0', name: 'A', type_line: 'T', oracle_text: 'new' });
  assert.notEqual(a, b);
});

function withFetch(impl, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = impl;
  return fn().finally(() => {
    globalThis.fetch = orig;
  });
}

const noMtgio = async () => ({ ok: true, json: async () => ({ cards: [] }) });

test('traductor propio: memoria + traducción automática solo para lo que falta', () =>
  withFetch(noMtgio, async () => {
    const asked = [];
    const machine = async (texts) => {
      asked.push(...texts);
      return texts.map((x) => `[es] ${x}`);
    };
    const tr = createTranslator({ cache: new Cache(), memories: { get: async () => sampleMemory() }, machine });
    const [r] = await tr.translate('es', [
      { key: 'k:0', name: 'Fire Elf', type_line: 'Creature — Elf Druid', oracle_text: '{T}: Add {R}.\nFlying, haste', flavor_text: 'Hot.' },
    ]);
    assert.equal(r.oracle_text, '{T}: Agrega {R}.\nVuela, prisa.');
    assert.equal(r.type_line, 'Criatura — Elfo druida');
    assert.equal(r.source, 'memory');
    assert.equal(r.name, '[es] Fire Elf');
    assert.equal(r.flavor_text, '[es] Hot.');
    assert.deepEqual(asked, ['Fire Elf', 'Hot.']);
  }));

test('traductor propio: el nombre propio viaja como ~ y se sustituye por el traducido', () =>
  withFetch(noMtgio, async () => {
    const machine = async (texts) => texts.map((x) => (x === 'Grim Bot' ? 'Robot Sombrío' : x.replace('~ explodes.', '~ explota.')));
    const tr = createTranslator({ cache: new Cache(), memories: { get: async () => sampleMemory() }, machine });
    const [r] = await tr.translate('es', [{ key: 'g:0', name: 'Grim Bot', type_line: 'Artifact', oracle_text: 'Grim Bot explodes.' }]);
    assert.equal(r.oracle_text, 'Robot Sombrío explota.');
    assert.equal(r.source, 'auto'); // el tipo "Artifact" sí sale de la memoria
  }));

test('si hay clave, Claude traduce primero con salida estructurada', () =>
  withFetch(noMtgio, async () => {
    const calls = [];
    const anthropic = {
      beta: {
        messages: {
          create: async (params) => {
            calls.push(params);
            const input = JSON.parse(params.messages[0].content.replace(/^[^[]*/, ''));
            const cards = input.map((c) => ({ key: c.key, name: `ES ${c.name}`, type_line: 'Artefacto', oracle_text: '{T}: Agrega {C}{C}.', flavor_text: '' }));
            return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ cards }) }] };
          },
        },
      },
    };
    const tr = createTranslator({ anthropic, model: 'claude-opus-5-5', cache: new Cache(), memories: { get: async () => null }, machine: async (x) => x });
    const cards = [{ key: 'sol:0', name: 'Sol Ring', type_line: 'Artifact', oracle_text: '{T}: Add {C}{C}.' }];
    const [r] = await tr.translate('es', cards);
    assert.equal(r.source, 'ai');
    assert.equal(calls[0].output_config.format.type, 'json_schema');
    assert.equal(calls[0].fallbacks, 'default');
    const [again] = await tr.translate('es', cards);
    assert.equal(again.cached, true);
    assert.equal(calls.length, 1);
  }));

test('API: valida peticiones y el proxy de imágenes', async () => {
  const app = createApp({ memories: { get: async () => null, info: async () => ({}) }, machine: async (x) => x });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const status = await (await fetch(`${base}/api/status`)).json();
    assert.equal(status.ai, false);
    assert.equal(status.translator, 'memory+machine');
    const bad = await fetch(`${base}/api/translate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lang: 'xx', cards: [] }) });
    assert.equal(bad.status, 400);
    const img = await fetch(`${base}/api/image?url=${encodeURIComponent('https://evil.example.com/a.png')}`);
    assert.equal(img.status, 400);
    assert.equal((await fetch(`${base}/`)).status, 200);
    assert.equal((await fetch(`${base}/js/editor.js`)).status, 200);
  } finally {
    server.close();
  }
});
