import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadRolesModel, rolesOf } from '../public/js/ai/roles.js';
import { analyzeDeck, buildDeck, proposeChanges, recommendedLands, detectThemes } from '../public/js/ai/brain.js';
import { parseIntent } from '../public/js/ai/assistant.js';
import { features } from '../public/js/ai/features.js';

await loadRolesModel(JSON.parse(fs.readFileSync(new URL('../public/ai/roles-model.json', import.meta.url))));
const fx = JSON.parse(fs.readFileSync(new URL('./fixtures/brain.json', import.meta.url)));
const byName = (n) => fx.cands.find((c) => c.card.name === n)?.card;

test('rasgos: nombre como ~ y sin recordatorios', () => {
  const f = features({ name: 'Foo, the Bar', type_line: 'Creature — Elf', cmc: 2, oracle_text: 'When Foo enters, draw a card. (Reminder text.)' });
  assert.ok(f.includes('~'));
  assert.ok(f.includes('draw'));
  assert.ok(!f.includes('reminder'));
  assert.ok(f.includes('t:elf'));
});

test('modelo: funciones de cartas conocidas', () => {
  const sol = { name: 'Sol Ring', type_line: 'Artifact', cmc: 1, oracle_text: '{T}: Add {C}{C}.' };
  assert.deepEqual(rolesOf(sol), ['ramp']);
  const wrath = { name: 'Wrath of God', type_line: 'Sorcery', cmc: 4, oracle_text: "Destroy all creatures. They can't be regenerated." };
  assert.ok(rolesOf(wrath).includes('wipe'));
  const counter = { name: 'Counterspell', type_line: 'Instant', cmc: 2, oracle_text: 'Counter target spell.' };
  assert.ok(rolesOf(counter).includes('counter'));
  const tower = { name: 'Command Tower', type_line: 'Land', cmc: 0, oracle_text: "{T}: Add one mana of any color in your commander's color identity." };
  assert.ok(!rolesOf(tower).includes('ramp'));
  const cultivate = { name: 'Cultivate', type_line: 'Sorcery', cmc: 3, oracle_text: 'Search your library for up to two basic land cards, reveal those cards, put one onto the battlefield tapped and the other into your hand, then shuffle.' };
  assert.ok(rolesOf(cultivate).includes('ramp'));
  assert.ok(!rolesOf(cultivate).includes('tutor'));
});

test('tierras recomendadas', () => {
  assert.equal(recommendedLands(3, 10), 36);
  assert.ok(recommendedLands(4.2, 12) >= 38);
  assert.ok(recommendedLands(2, 8) <= 35);
});

test('construir: 99 cartas legales con funciones básicas', () => {
  const cards = buildDeck([fx.cmd], fx.cands, { basics: fx.basics });
  assert.equal(cards.reduce((n, e) => n + e.qty, 0), 99);
  const deck = { commanders: [{ card: fx.cmd, qty: 1 }], cards };
  const a = analyzeDeck(deck, { edhrec: fx.ed });
  assert.equal(a.counts.total, 100);
  assert.ok(a.counts.ramp >= 9 && a.counts.draw >= 9 && a.counts.interaction >= 7);
  assert.ok(a.score >= 75, `puntuación ${a.score}`);
  assert.equal(a.checks.find((c) => c.key === 'legal').status, 'good');
  // Bracket 2: sin Game Changers
  const casual = buildDeck([fx.cmd], fx.cands, { basics: fx.basics, bracket: 2 });
  assert.ok(!casual.some((e) => e.card.game_changer));
});

test('analizar y proponer: mazo incompleto recibe tierras y cartas', () => {
  const cards = buildDeck([fx.cmd], fx.cands, { basics: fx.basics });
  const bad = { commanders: [{ card: fx.cmd, qty: 1 }], cards: cards.filter((e, i) => i % 3 !== 0) };
  const a = analyzeDeck(bad, { edhrec: fx.ed });
  assert.ok(a.score < 80);
  const props = proposeChanges(bad, a, fx.cands, { basics: fx.basics, max: 60 });
  assert.ok(props.some((p) => p.tag === 'lands'));
  const added = props.reduce((n, p) => n + (p.kind === 'add' ? p.qty || 1 : 0), 0);
  assert.ok(added > 10);
  assert.ok(props.every((p) => !p.add || !bad.cards.some((e) => e.card.name === p.add.name) || p.add.name === fx.basics.B?.name || p.add.name === fx.basics.G?.name));
});

test('proponer: carta fuera de identidad sale siempre', () => {
  const cards = buildDeck([fx.cmd], fx.cands, { basics: fx.basics });
  const off = { name: 'Lightning Bolt', type_line: 'Instant', cmc: 1, mana_cost: '{R}', color_identity: ['R'], oracle_text: 'Lightning Bolt deals 3 damage to any target.', legal: 'legal' };
  const deck = { commanders: [{ card: fx.cmd, qty: 1 }], cards: [...cards.slice(1), { card: off, qty: 1 }] };
  const a = analyzeDeck(deck, { edhrec: fx.ed });
  assert.equal(a.checks.find((c) => c.key === 'legal').status, 'bad');
  const props = proposeChanges(deck, a, fx.cands, { basics: fx.basics });
  assert.equal(props[0].cut.name, 'Lightning Bolt');
  assert.equal(props[0].reason.code, 'cutIdentity');
});

test('modos: presupuesto y bracket', () => {
  const cards = buildDeck([fx.cmd], fx.cands, { basics: fx.basics });
  const deck = { commanders: [{ card: fx.cmd, qty: 1 }], cards };
  const a = analyzeDeck(deck, { edhrec: fx.ed });
  const cheap = proposeChanges(deck, a, fx.cands, { mode: 'budget', budget: 2 });
  for (const p of cheap) assert.ok((parseFloat(p.add.prices.usd) || 0) <= 2);
  const b2 = proposeChanges(deck, a, fx.cands, { mode: 'bracket', bracket: 2 });
  for (const p of b2) assert.ok(p.cut.game_changer || p.reason.code !== 'swapGameChanger');
  assert.ok(detectThemes(deck).length > 0);
  assert.ok(byName('Sol Ring'));
});

test('asistente: entiende peticiones', () => {
  assert.equal(parseIntent('¿Está bien mi mazo?').type, 'analyze');
  assert.deepEqual(parseIntent('Añade más ramp'), { type: 'role', role: 'ramp', count: null });
  assert.equal(parseIntent('pon 4 cartas de robo').count, 4);
  assert.equal(parseIntent('hazlo más barato').type, 'budget');
  assert.equal(parseIntent('cambia lo que cueste más de 5€').budget, 5);
  assert.equal(parseIntent('bracket 2').bracket, 2);
  assert.equal(parseIntent('¿qué corto?').type, 'cuts');
  assert.equal(parseIntent('constrúyeme un mazo').type, 'build');
  assert.equal(parseIntent('completa el mazo').type, 'complete');
  assert.equal(parseIntent('¿cómo se juega?').type, 'explain');
  assert.equal(parseIntent('¿es buena Sol Ring?').card, 'Sol Ring');
  assert.equal(parseIntent('add more removal').role, 'interaction');
  assert.equal(parseIntent('cuéntame un chiste').type, 'chat');
});
