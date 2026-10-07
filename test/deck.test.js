import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDeckText, exportDeckText, validateDeck, deckStats, validPair, canBeCommander,
  edhrecSlug, encodeShare, decodeShare, maxCopiesAllowed, cardRoles, estimateBracket, shuffle,
} from '../public/js/deck.js';

const card = (o) => ({
  id: o.name, name: o.name, type_line: 'Artifact', oracle_text: '', mana_cost: '', cmc: 0,
  color_identity: [], produced_mana: [], legal: 'legal', prices: {}, set: 'tst', collector_number: '1', ...o,
});

test('parsea formatos habituales de listas', () => {
  const r = parseDeckText(`Commander
1 Atraxa, Praetors' Voice (2XM) 190
Deck
1x Sol Ring
1 Arcane Signet [CMR]
10 Forest
Command Tower
1 Fire / Ice
1 Lightning Greaves (CMM) 393 *F*
1 Rhystic Study #Draw
SB: 1 Counterspell
Sideboard
1 Swords to Plowshares`);
  assert.deepEqual(r.commanders, [{ qty: 1, name: "Atraxa, Praetors' Voice", set: '2xm', cn: '190' }]);
  assert.deepEqual(r.cards.map((c) => [c.qty, c.name, c.set]), [
    [1, 'Sol Ring', null], [1, 'Arcane Signet', 'cmr'], [10, 'Forest', null], [1, 'Command Tower', null],
    [1, 'Fire // Ice', null], [1, 'Lightning Greaves', 'cmm'], [1, 'Rhystic Study', null],
  ]);
});

test('reconoce *CMDR* de TappedOut y la sección About de Arena', () => {
  const r = parseDeckText('About\nName Mi mazo\n\nDeck\n1 Krenko, Mob Boss *CMDR*\n1 Goblin Bombardment');
  assert.equal(r.name, 'Mi mazo');
  assert.equal(r.commanders[0].name, 'Krenko, Mob Boss');
  assert.equal(r.cards.length, 1);
});

test('exporta en formato MTGO con comandante', () => {
  const deck = {
    name: 'X', commanders: [{ qty: 1, card: card({ name: 'Krenko, Mob Boss', set: 'm13', collector_number: '139' }) }],
    cards: [{ qty: 1, card: card({ name: 'Sol Ring', set: 'c21', collector_number: '263' }) }],
  };
  assert.equal(exportDeckText(deck), 'Commander\n1 Krenko, Mob Boss (M13) 139\n\nDeck\n1 Sol Ring (C21) 263');
  assert.equal(exportDeckText(deck, 'plain'), 'Commander\n1 Krenko, Mob Boss\n\nDeck\n1 Sol Ring');
});

test('valida comandante, identidad de color, singleton y prohibidas', () => {
  const krenko = card({ name: 'Krenko, Mob Boss', type_line: 'Legendary Creature — Goblin Warrior', color_identity: ['R'] });
  const deck = {
    commanders: [{ qty: 1, card: krenko }],
    cards: [
      { qty: 2, card: card({ name: 'Sol Ring' }) },
      { qty: 1, card: card({ name: 'Counterspell', color_identity: ['U'] }) },
      { qty: 1, card: card({ name: 'Mana Crypt', legal: 'banned' }) },
      { qty: 30, card: card({ name: 'Mountain', type_line: 'Basic Land — Mountain' }) },
      { qty: 20, card: card({ name: 'Relentless Rats', oracle_text: 'A deck can have any number of cards named Relentless Rats.' }) },
    ],
  };
  const codes = validateDeck(deck).map((i) => `${i.code}:${i.params?.name ?? ''}`);
  assert.ok(codes.includes('singleton:Sol Ring'));
  assert.ok(codes.includes('identity:Counterspell'));
  assert.ok(codes.includes('banned:Mana Crypt'));
  assert.ok(codes.includes('count:'));
  assert.ok(codes.includes('fewLands:'));
  assert.ok(!codes.some((c) => c.startsWith('singleton:Mountain') || c.startsWith('singleton:Relentless')));
});

test('detecta comandante no válido y sin comandante', () => {
  assert.ok(validateDeck({ commanders: [], cards: [] }).some((i) => i.code === 'noCommander'));
  const issues = validateDeck({ commanders: [{ qty: 1, card: card({ name: 'Sol Ring' }) }], cards: [] });
  assert.ok(issues.some((i) => i.code === 'invalidCommander'));
  assert.ok(canBeCommander(card({ name: 'Teferi', type_line: 'Legendary Planeswalker — Teferi', oracle_text: 'Teferi can be your commander.' })));
});

test('parejas de comandantes: Partner, Background y Partner with', () => {
  const lc = 'Legendary Creature — Human';
  const a = card({ name: 'Thrasios, Triton Hero', type_line: lc, oracle_text: '{4}: Scry 1.\nPartner (You can have two commanders if both have partner.)' });
  const b = card({ name: 'Tymna the Weaver', type_line: lc, oracle_text: 'Lifelink\nPartner (You can have two commanders if both have partner.)' });
  const c = card({ name: 'Wilson, Refined Grizzly', type_line: lc, oracle_text: 'Choose a Background (You can have a Background as a second commander.)' });
  const bg = card({ name: 'Raised by Giants', type_line: 'Legendary Enchantment — Background' });
  const k = card({ name: 'Krenko', type_line: lc });
  assert.ok(validPair(a, b));
  assert.ok(validPair(c, bg));
  assert.ok(!validPair(a, k));
  assert.ok(!validateDeck({ commanders: [{ qty: 1, card: c }, { qty: 1, card: bg }], cards: [] }).some((i) => i.code.startsWith('invalid')));
});

test('estadísticas: curva, pips, roles y precio', () => {
  const deck = {
    commanders: [],
    cards: [
      { qty: 1, card: card({ name: 'Cultivate', type_line: 'Sorcery', cmc: 3, mana_cost: '{2}{G}', oracle_text: 'Search your library for up to two basic land cards, reveal those cards, put one onto the battlefield tapped and the other into your hand, then shuffle.', prices: { usd: '0.50' } }) },
      { qty: 1, card: card({ name: 'Sol Ring', cmc: 1, mana_cost: '{1}', oracle_text: '{T}: Add {C}{C}.', prices: { usd: '1.50' }, game_changer: false }) },
      { qty: 1, card: card({ name: 'Forest', type_line: 'Basic Land — Forest', produced_mana: ['G'] }) },
    ],
  };
  const s = deckStats(deck);
  assert.equal(s.curve[3], 1);
  assert.equal(s.curve[1], 1);
  assert.equal(s.pips.G, 1);
  assert.equal(s.sources.G, 1);
  assert.equal(s.roles.ramp, 2);
  assert.equal(s.usd, 2);
  assert.equal(s.avgCmc, 2);
  assert.equal(estimateBracket(s), 2);
});

test('roles por texto', () => {
  assert.deepEqual(cardRoles(card({ name: 'Swords', type_line: 'Instant', oracle_text: 'Exile target creature. Its controller gains life equal to its power.' })), ['removal']);
  assert.ok(cardRoles(card({ name: 'Wrath', type_line: 'Sorcery', oracle_text: 'Destroy all creatures. They can\'t be regenerated.' })).includes('wipe'));
});

test('copias permitidas', () => {
  assert.equal(maxCopiesAllowed(card({ name: 'Seven Dwarves', oracle_text: 'A deck can have up to seven cards named Seven Dwarves.' })), 7);
  assert.equal(maxCopiesAllowed(card({ name: 'Island', type_line: 'Basic Land — Island' })), Infinity);
});

test('slug de EDHREC', () => {
  assert.equal(edhrecSlug(["Atraxa, Praetors' Voice"]), 'atraxa-praetors-voice');
  assert.equal(edhrecSlug(['Tymna the Weaver', 'Thrasios, Triton Hero']), 'thrasios-triton-hero-tymna-the-weaver');
  assert.equal(edhrecSlug(['Lim-Dûl the Necromancer']), 'lim-dul-the-necromancer');
});

test('compartir por URL ida y vuelta', () => {
  const deck = { name: 'Mazo ñ', lang: 'es', commanders: [{ qty: 1, card: { id: 'a' } }], cards: [{ qty: 3, card: { id: 'b' } }] };
  assert.deepEqual(decodeShare(encodeShare(deck)), { name: 'Mazo ñ', lang: 'es', commanders: [['a', 1]], cards: [['b', 3]] });
});

test('barajar conserva elementos', () => {
  let seed = 1;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  assert.deepEqual(shuffle([1, 2, 3, 4, 5], rnd).sort(), [1, 2, 3, 4, 5]);
});
