/**
 * "Cerebro" de mazos de Commander: analiza un mazo, lo puntúa, propone cambios
 * (que el usuario acepta o rechaza) y construye mazos a partir de un comandante.
 *
 * Es lógica pura (sin DOM ni red): recibe el mazo, las cartas candidatas (de EDHREC y de
 * Scryfall) y las preferencias. Los textos los pone la interfaz a partir de { code, params }.
 */
import { validateDeck, deckIdentity, countCards, isBasicLand, maxCopiesAllowed, mainType } from '../deck.js';
import { roleScores } from './roles.js';

export const COLORS = ['W', 'U', 'B', 'R', 'G'];
export const BASIC_BY_COLOR = { W: 'Plains', U: 'Island', B: 'Swamp', R: 'Mountain', G: 'Forest', C: 'Wastes' };

/** Funciones que se cuentan en el análisis (las del modelo + reglas). */
export const TRACKED = ['ramp', 'draw', 'removal', 'wipe', 'counter', 'tutor', 'protection', 'recursion', 'tokens', 'wincon', 'extraTurn', 'massLand'];

/** Objetivos habituales en Commander (plantilla clásica de 100 cartas). */
export const TARGETS = { ramp: 10, draw: 10, interaction: 8, wipe: 3, protection: 2 };

const frontType = (card) => card?.type_line || card?.faces?.[0]?.type_line || '';
const isLand = (card) => /\bLand\b/.test(frontType(card).split(' // ')[0]) && !/\bCreature\b/.test(frontType(card));
const textOf = (card) => (card?.faces?.length ? card.faces.map((f) => f.oracle_text).join('\n') : card?.oracle_text) || '';
const has = (card, role, min = 0.5) => (roleScores(card)[role] || 0) >= min;
const price = (card) => parseFloat(card?.prices?.usd) || parseFloat(card?.prices?.eur) || 0;
const nameKey = (n) => String(n || '').split(' // ')[0].toLowerCase();

// ---------------------------------------------------------------- temas / arquetipos

export const THEMES = {
  tokens: (c) => /\bcreate[^.]*\btokens?\b|tokens? you control/i.test(textOf(c)),
  counters: (c) => /\+1\/\+1 counters?|proliferate/i.test(textOf(c)),
  spells: (c) => /\b(?:Instant|Sorcery)\b/.test(frontType(c)) || /instant or sorcery spell|noncreature spell/i.test(textOf(c)),
  artifacts: (c) => (/\bArtifact\b/.test(frontType(c)) && !isLand(c)) || /artifacts? you control|whenever an artifact/i.test(textOf(c)),
  enchantments: (c) => /\bEnchantment\b/.test(frontType(c)) || /enchantment spell|enchantments? you control/i.test(textOf(c)),
  graveyard: (c) => /from (?:your|a) graveyard|mill|into your graveyard|dredge|flashback|escape/i.test(textOf(c)),
  sacrifice: (c) => /sacrifice (?:a|another|an)\b|whenever [^.]*\bdies\b/i.test(textOf(c)),
  landfall: (c) => /landfall|whenever a land (?:you control )?enters|play an additional land|additional land/i.test(textOf(c)),
  voltron: (c) => /\b(?:Equipment|Aura)\b/.test(frontType(c)) || /equipped creature|enchanted creature gets|double strike/i.test(textOf(c)),
  lifegain: (c) => /gain(?:s)? \w+ life|whenever you gain life|lifelink/i.test(textOf(c)),
  blink: (c) => /exile [^.]*then return (?:it|that card|them) to the battlefield|flicker/i.test(textOf(c)),
  draw: (c) => /whenever you draw|draw your second card/i.test(textOf(c)),
};

function creatureTypes(card) {
  const t = frontType(card);
  if (!/\bCreature\b/.test(t) || !t.includes('—')) return [];
  return t.split('—')[1].split('//')[0].trim().split(/\s+/);
}

/** Temas del mazo, de más a menos fuerte (el comandante pesa por 6). */
export function detectThemes(deck) {
  const cmds = deck.commanders.map((e) => e.card).filter(Boolean);
  const cards = deck.cards.map((e) => e.card).filter(Boolean);
  const out = [];
  for (const [key, test] of Object.entries(THEMES)) {
    const n = cards.filter(test).length;
    const fromCmd = cmds.some(test);
    const score = n + (fromCmd ? 6 : 0);
    if (n >= 8 || (fromCmd && n >= 3)) out.push({ key, n, fromCmd, score });
  }
  // Tribal: el tipo de criatura más repetido.
  const tribes = new Map();
  for (const c of [...cmds, ...cards]) for (const t of creatureTypes(c)) tribes.set(t, (tribes.get(t) || 0) + 1);
  const [tribe, tn] = [...tribes].sort((a, b) => b[1] - a[1])[0] || [];
  const cmdTribal = cmds.some((c) => tribe && new RegExp(`\\b${tribe}s?\\b`).test(textOf(c)));
  if (tribe && (tn >= 15 || (cmdTribal && tn >= 8))) out.push({ key: 'tribal', tribe, n: tn, fromCmd: cmdTribal, score: tn + (cmdTribal ? 6 : 0) });
  return out.sort((a, b) => b.score - a.score);
}

const themeTest = (theme) => (theme.key === 'tribal' ? (c) => creatureTypes(c).includes(theme.tribe) || new RegExp(`\\b${theme.tribe}s?\\b`).test(textOf(c)) : THEMES[theme.key]);

// ---------------------------------------------------------------- valor de cada carta

/** Popularidad (0-1) según el puesto en EDHREC de Scryfall. */
export function popularity(card) {
  const r = card?.edhrec_rank;
  if (!r) return 0.15;
  return Math.max(0, Math.min(1, 1 - Math.log10(r) / Math.log10(30000)));
}

/** Mapa nombre → { inclusion, synergy } a partir de EDHREC simplificado. */
export function edhrecMap(edhrec) {
  const map = new Map();
  for (const l of edhrec?.lists || []) {
    for (const c of l.cards) {
      const prev = map.get(nameKey(c.name));
      if (!prev || (c.inclusion || 0) > (prev.inclusion || 0)) map.set(nameKey(c.name), { inclusion: c.inclusion || 0, synergy: c.synergy || 0, list: l.tag || l.header });
    }
  }
  return map;
}

/**
 * Valor estimado de una carta para este mazo: popularidad, datos de EDHREC con este comandante,
 * funciones útiles, encaje con los temas y coste.
 */
export function cardValue(card, ctx = {}) {
  const ed = ctx.edhrec?.get(nameKey(card.name));
  let v = 0;
  const reasons = [];
  if (ed) {
    v += 0.3 + (ed.inclusion || 0) * 2 + (ed.synergy || 0) * 1.5;
    if ((ed.synergy || 0) > 0.2) reasons.push('synergy');
    if ((ed.inclusion || 0) > 0.4) reasons.push('popularWithCommander');
  } else if (ctx.edhrec?.size) v -= 0.15;
  v += popularity(card) * 0.9;
  const sc = roleScores(card);
  for (const r of ['ramp', 'draw', 'removal', 'wipe']) if ((sc[r] || 0) >= 0.5) v += 0.35;
  for (const r of ['counter', 'tutor', 'protection', 'recursion', 'wincon']) if ((sc[r] || 0) >= 0.5) v += 0.15;
  if (ctx.themes?.length && ctx.themes.slice(0, 2).some((t) => themeTest(t)(card))) {
    v += 0.3;
    reasons.push('theme');
  }
  if (!isLand(card)) {
    const cmc = card.cmc || 0;
    if (cmc > 4) v -= (cmc - 4) * 0.18;
    if (cmc <= 2 && ((sc.ramp || 0) >= 0.5 || (sc.removal || 0) >= 0.5)) v += 0.1;
  }
  if (card.game_changer) v += 0.25;
  return { value: Math.round(v * 100) / 100, reasons };
}

// ---------------------------------------------------------------- análisis

/** Tierras recomendadas según la curva y el ramp. */
export function recommendedLands(avgCmc, ramp) {
  return Math.max(32, Math.min(40, Math.round(35 + (avgCmc - 2.5) * 3 - (Math.min(ramp, 14) - 8) * 0.3)));
}

function grade(score) {
  return score >= 85 ? 'A' : score >= 72 ? 'B' : score >= 58 ? 'C' : score >= 45 ? 'D' : 'F';
}

/** Bracket oficial de Commander (1-5) estimado. */
export function estimateBracketFull({ gameChangers, combos = 0, massLand = 0, extraTurns = 0, tutors = 0 }) {
  if (massLand > 0 || gameChangers > 3 || combos > 0) return 4;
  if (gameChangers > 0 || extraTurns > 1 || tutors > 3) return 3;
  return 2;
}

/**
 * Analiza el mazo. ctx: { edhrec (simplificado), combos ({ included }) }.
 */
export function analyzeDeck(deck, ctx = {}) {
  const entries = [...deck.commanders, ...deck.cards].filter((e) => e.card);
  const main = deck.cards.filter((e) => e.card);
  const ed = edhrecMap(ctx.edhrec);
  const themes = detectThemes(deck);
  const vctx = { edhrec: ed, themes };
  const counts = Object.fromEntries(TRACKED.map((r) => [r, 0]));
  const curve = Array(8).fill(0);
  let lands = 0;
  let nonland = 0;
  let cmcSum = 0;
  let usd = 0;
  const pips = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  const sources = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  const values = new Map();
  for (const e of entries) {
    const c = e.card;
    const land = isLand(c);
    usd += price(c) * e.qty;
    if (land) lands += e.qty;
    else {
      nonland += e.qty;
      cmcSum += (c.cmc || 0) * e.qty;
      curve[Math.min(7, Math.floor(c.cmc || 0))] += e.qty;
    }
    for (const r of TRACKED) if (has(c, r)) counts[r] += e.qty;
    for (const m of (c.mana_cost || '').matchAll(/\{([^}]+)\}/g)) for (const col of m[1].split('/')) if (col in pips) pips[col] += e.qty;
    for (const col of c.produced_mana || []) if (col in sources && (land || has(c, 'ramp'))) sources[col] += e.qty;
    values.set(c.name, cardValue(c, vctx));
  }
  const total = countCards(deck);
  const avgCmc = nonland ? cmcSum / nonland : 0;
  const recLands = recommendedLands(avgCmc, counts.ramp);
  const interaction = counts.removal + counts.counter;
  const identity = deckIdentity(deck);
  const checks = [];
  const add = (key, status, params = {}, weight = 1) => checks.push({ key, status, params, weight });

  // Reglas del formato
  const issues = validateDeck(deck).filter((i) => i.level === 'error' && i.code !== 'count');
  add('legal', issues.length ? 'bad' : 'good', { n: issues.length, issues }, 7);
  add('count', total === 100 ? 'good' : Math.abs(total - 100) <= 5 ? 'warn' : 'bad', { total }, 7);
  // Tierras
  const dl = lands - recLands;
  add('lands', Math.abs(dl) <= 1 ? 'good' : Math.abs(dl) <= 3 ? 'warn' : 'bad', { n: lands, target: recLands, diff: dl }, 15);
  // Funciones básicas
  const level = (n, target, warnAt) => (n >= target - 1 ? 'good' : n >= warnAt ? 'warn' : 'bad');
  add('ramp', level(counts.ramp, TARGETS.ramp, 6), { n: counts.ramp, target: TARGETS.ramp }, 12);
  add('draw', level(counts.draw, TARGETS.draw, 6), { n: counts.draw, target: TARGETS.draw }, 12);
  add('interaction', level(interaction, TARGETS.interaction, 4), { n: interaction, removal: counts.removal, counter: counts.counter, target: TARGETS.interaction }, 12);
  add('wipe', counts.wipe >= 2 && counts.wipe <= 5 ? 'good' : counts.wipe === 1 || counts.wipe <= 7 ? 'warn' : 'bad', { n: counts.wipe, target: TARGETS.wipe }, 5);
  // Curva
  add('curve', avgCmc <= 3.3 ? 'good' : avgCmc <= 3.9 ? 'warn' : 'bad', { avg: Math.round(avgCmc * 100) / 100 }, 10);
  // Colores: proporción de fuentes frente a la de símbolos de maná
  const pipTotal = identity.reduce((s, c) => s + pips[c], 0) || 1;
  const srcTotal = identity.reduce((s, c) => s + sources[c], 0) || 1;
  const colors = identity.map((c) => {
    const share = pips[c] / pipTotal;
    const srcShare = sources[c] / srcTotal;
    return { c, pips: pips[c], sources: sources[c], share, srcShare, ok: identity.length < 2 || srcShare >= share * 0.7 || sources[c] >= 15 };
  });
  const weak = colors.filter((c) => !c.ok);
  add('colors', weak.length === 0 ? 'good' : weak.length === 1 ? 'warn' : 'bad', { weak: weak.map((c) => c.c) }, 8);
  // Sinergia con el comandante (si hay datos de EDHREC)
  let synergy = null;
  if (ed.size) {
    const pool = main.filter((e) => !isBasicLand(e.card));
    const inList = pool.filter((e) => ed.has(nameKey(e.card.name)));
    const avgSyn = inList.reduce((s, e) => s + (ed.get(nameKey(e.card.name)).synergy || 0), 0) / Math.max(1, inList.length);
    synergy = { inList: inList.length, of: pool.length, ratio: pool.length ? inList.length / pool.length : 0, avgSynergy: avgSyn };
    add('synergy', synergy.ratio >= 0.6 ? 'good' : synergy.ratio >= 0.4 ? 'warn' : 'bad', { pct: Math.round(synergy.ratio * 100), n: inList.length, of: pool.length }, 12);
  }
  // Puntuación
  const wsum = checks.reduce((s, c) => s + c.weight, 0);
  let score = (checks.reduce((s, c) => s + c.weight * (c.status === 'good' ? 1 : c.status === 'warn' ? 0.55 : 0.1), 0) / wsum) * 100;
  if (issues.length) score = Math.min(score, 60);
  score = Math.round(score);

  const gameChangers = entries.filter((e) => e.card.game_changer).map((e) => e.card.name);
  const combos = ctx.combos?.included?.filter((c) => c.cards.length <= 2).length || 0;
  const bracket = estimateBracketFull({ gameChangers: gameChangers.length, combos, massLand: counts.massLand, extraTurns: counts.extraTurn, tutors: counts.tutor });
  const strengths = checks.filter((c) => c.status === 'good' && !['legal', 'count'].includes(c.key)).map((c) => c.key);
  const weaknesses = checks.filter((c) => c.status !== 'good').sort((a, b) => b.weight - a.weight).map((c) => c.key);
  const verdict = score >= 85 ? 'great' : score >= 72 ? 'good' : score >= 58 ? 'ok' : score >= 45 ? 'weak' : 'bad';
  const ranked = main.filter((e) => !isLand(e.card)).map((e) => ({ name: e.card.name, ...values.get(e.card.name) })).sort((a, b) => a.value - b.value);
  return {
    score,
    grade: grade(score),
    verdict,
    bracket,
    themes,
    identity,
    counts: { ...counts, interaction, lands, nonland, total, avgCmc, curve, usd, recLands },
    colors,
    checks,
    strengths,
    weaknesses,
    synergy,
    gameChangers,
    weakest: ranked.slice(0, 10),
    strongest: ranked.slice(-8).reverse(),
    values,
    ctx: vctx,
  };
}

// ---------------------------------------------------------------- propuestas de cambios

let nextId = 1;
const proposal = (p) => ({ id: `p${nextId++}`, ...p });

/** Filtra candidatas válidas para el mazo según identidad, legalidad, presupuesto y bracket. */
export function usableCandidates(deck, candidates, opts = {}) {
  const identity = new Set(deckIdentity(deck));
  const owned = new Set([...deck.commanders, ...deck.cards].map((e) => nameKey(e.card?.name)));
  const seen = new Set();
  return candidates.filter(({ card }) => {
    const k = nameKey(card?.name);
    if (!card || owned.has(k) || seen.has(k)) return false;
    seen.add(k);
    if (deck.commanders.length && card.color_identity.some((c) => !identity.has(c))) return false;
    if (card.legal && card.legal !== 'legal') return false;
    if (opts.budget != null && price(card) > opts.budget) return false;
    if (opts.bracket != null && opts.bracket <= 2 && card.game_changer) return false;
    if (opts.bracket != null && opts.bracket <= 3 && (has(card, 'massLand') || has(card, 'extraTurn'))) return false;
    if (/\b(?:Conspiracy|Scheme|Plane|Phenomenon|Vanguard)\b/.test(frontType(card))) return false;
    return true;
  });
}

/**
 * Propone cambios. candidates: [{ card, inclusion?, synergy? }].
 * opts: { mode: 'balanced'|'budget'|'bracket'|'role'|'cuts'|'upgrade', role, budget, bracket, max, basics: {W: card…} }
 */
export function proposeChanges(deck, analysis, candidates, opts = {}) {
  const max = opts.max ?? 15;
  const out = [];
  const ed = analysis.ctx.edhrec;
  for (const c of candidates) {
    if (c.inclusion != null && !ed.has(nameKey(c.card.name))) ed.set(nameKey(c.card.name), { inclusion: c.inclusion, synergy: c.synergy || 0 });
  }
  const pool = usableCandidates(deck, candidates, opts).map((c) => ({ ...c, value: cardValue(c.card, analysis.ctx).value }));
  pool.sort((a, b) => b.value - a.value);
  const used = new Set();
  const cut = new Set();
  const take = (filter) => {
    const c = pool.find((p) => !used.has(p.card.name) && filter(p.card));
    if (c) used.add(c.card.name);
    return c;
  };
  const counts = { ...analysis.counts };
  const deficit = (role) => {
    if (role === 'interaction') return TARGETS.interaction - counts.interaction;
    return (TARGETS[role] ?? 0) - (counts[role] ?? 0);
  };
  const protectedRoles = () => ['ramp', 'draw', 'removal', 'wipe'].filter((r) => deficit(r === 'removal' ? 'interaction' : r) >= 0);
  const mainEntries = deck.cards.filter((e) => e.card);
  // Cartas que se pueden cortar: de menos a más valor, sin tocar las que cubren funciones que faltan.
  const cutPool = () =>
    mainEntries
      .filter((e) => !isLand(e.card) && !cut.has(e.card.name))
      .filter((e) => !protectedRoles().some((r) => has(e.card, r)))
      .map((e) => ({ e, value: analysis.values.get(e.card.name)?.value ?? 0 }))
      .sort((a, b) => a.value - b.value);
  const nextCut = (filter = () => true) => {
    const c = cutPool().find((x) => filter(x.e.card));
    if (c) cut.add(c.e.card.name);
    return c;
  };
  const account = (card, sign, qty = 1) => {
    for (const r of TRACKED) if (has(card, r)) counts[r] += sign * qty;
    counts.interaction = counts.removal + counts.counter;
    if (isLand(card)) counts.lands += sign * qty;
  };
  let sizeDelta = 100 - counts.total;
  const push = (p) => {
    if (out.length >= max) return false;
    out.push(proposal(p));
    if (p.add) account(p.add, +1, p.qty || 1);
    if (p.cut) account(p.cut, -1);
    return true;
  };
  const addOrSwap = (cand, reason, tag) => {
    if (!cand) return false;
    if (sizeDelta > 0) {
      sizeDelta--;
      return push({ kind: 'add', add: cand.card, reason, tag, score: cand.value });
    }
    const victim = nextCut((c) => c.name !== cand.card.name);
    if (!victim) return push({ kind: 'add', add: cand.card, reason, tag, score: cand.value });
    return push({ kind: 'swap', add: cand.card, cut: victim.e.card, reason, tag, score: cand.value, cutValue: victim.value });
  };

  // 1) Lo que incumple las reglas siempre sale.
  for (const e of [...deck.commanders, ...mainEntries]) {
    const c = e.card;
    if (!c || deck.commanders.includes(e)) continue;
    const offIdentity = deck.commanders.length && c.color_identity.some((x) => !analysis.identity.includes(x));
    const illegal = c.legal === 'banned' || c.legal === 'not_legal';
    const extra = e.qty > maxCopiesAllowed(c);
    if (!offIdentity && !illegal && !extra) continue;
    cut.add(c.name);
    const code = illegal ? 'cutBanned' : offIdentity ? 'cutIdentity' : 'cutSingleton';
    const role = ['ramp', 'draw', 'removal', 'wipe'].find((r) => has(c, r));
    const repl = take((x) => (role ? has(x, role) : !isLand(x)) && (isLand(c) === isLand(x)));
    if (repl) push({ kind: 'swap', add: repl.card, cut: c, reason: { code, params: { name: c.name } }, tag: 'legal', score: repl.value });
    else push({ kind: 'cut', cut: c, reason: { code, params: { name: c.name } }, tag: 'legal' });
  }

  const mode = opts.mode || 'balanced';
  if (mode === 'budget') {
    const limit = opts.budget ?? 2;
    const pricey = mainEntries.filter((e) => price(e.card) > limit && !cut.has(e.card.name)).sort((a, b) => price(b.card) - price(a.card));
    for (const e of pricey) {
      const c = e.card;
      const role = TRACKED.find((r) => has(c, r)) || null;
      // Mejor del mismo tipo y función; si no, de la misma función; si no, del mismo tipo.
      const near = (x) => isLand(c) || Math.abs((x.cmc || 0) - (c.cmc || 0)) <= 2;
      const base = (x) => isLand(x) === isLand(c) && price(x) <= limit && near(x);
      const repl = role
        ? take((x) => base(x) && has(x, role) && mainType(x) === mainType(c)) || take((x) => base(x) && has(x, role))
        : take((x) => base(x) && mainType(x) === mainType(c) && (!analysis.themes[0] || themeTest(analysis.themes[0])(x) === themeTest(analysis.themes[0])(c)));
      if (!repl) continue;
      cut.add(c.name);
      if (!push({ kind: 'swap', add: repl.card, cut: c, reason: { code: 'swapBudget', params: { name: c.name, from: price(c).toFixed(2), to: price(repl.card).toFixed(2) } }, tag: 'budget', score: repl.value })) break;
    }
    return out;
  }
  if (mode === 'bracket') {
    const target = opts.bracket ?? 2;
    const keepGc = target <= 2 ? 0 : 3;
    const gcs = mainEntries.filter((e) => e.card.game_changer).sort((a, b) => (analysis.values.get(a.card.name)?.value ?? 0) - (analysis.values.get(b.card.name)?.value ?? 0));
    const offenders = [
      ...gcs.slice(0, Math.max(0, gcs.length - keepGc)).map((e) => ({ e, code: 'swapGameChanger' })),
      ...(target <= 3 ? mainEntries.filter((e) => has(e.card, 'massLand')).map((e) => ({ e, code: 'swapMassLand' })) : []),
      ...(target <= 2 ? mainEntries.filter((e) => has(e.card, 'extraTurn')).map((e) => ({ e, code: 'swapExtraTurn' })) : []),
    ];
    for (const { e, code } of offenders) {
      const c = e.card;
      if (cut.has(c.name)) continue;
      const role = ['ramp', 'draw', 'removal', 'wipe', 'tutor', 'counter'].find((r) => has(c, r));
      const repl = take((x) => !x.game_changer && isLand(x) === isLand(c) && (!role || has(x, role)));
      cut.add(c.name);
      if (!push(repl ? { kind: 'swap', add: repl.card, cut: c, reason: { code, params: { name: c.name, bracket: target } }, tag: 'bracket', score: repl.value } : { kind: 'cut', cut: c, reason: { code, params: { name: c.name, bracket: target } }, tag: 'bracket' })) break;
    }
    return out;
  }
  if (mode === 'cuts') {
    const n = opts.count ?? Math.max(5, -sizeDelta);
    for (let i = 0; i < n; i++) {
      const v = nextCut();
      if (!v) break;
      const why = analysis.values.get(v.e.card.name);
      push({ kind: 'cut', cut: v.e.card, reason: { code: (v.e.card.cmc || 0) >= 5 ? 'cutExpensive' : why?.reasons.includes('theme') ? 'cutLowValueTheme' : 'cutLowValue', params: { name: v.e.card.name, cmc: v.e.card.cmc } }, tag: 'cuts' });
    }
    return out;
  }
  if (mode === 'role') {
    const role = opts.role;
    const n = opts.count ?? 3;
    for (let i = 0; i < n; i++) {
      const cand = take((x) => (role === 'lands' ? isLand(x) : has(x, role === 'interaction' ? 'removal' : role) && !isLand(x)));
      if (!cand) break;
      if (!addOrSwap(cand, { code: 'addRole', params: { role } }, role)) break;
    }
    return out;
  }

  // 2) Tamaño y tierras
  const landTarget = analysis.counts.recLands;
  const basicFor = (color) => opts.basics?.[color];
  const neededColor = () => {
    const weak = analysis.colors.slice().sort((a, b) => a.srcShare - a.share - (b.srcShare - b.share))[0];
    return weak?.c || analysis.identity[0] || 'C';
  };
  const landReason = { code: 'addLand', params: { n: analysis.counts.lands, target: landTarget } };
  if (counts.lands < landTarget - 1) {
    // Primero unas pocas tierras buenas; el resto, básicas (en bloque si faltan cartas).
    for (let i = 0; i < 4 && counts.lands < landTarget && out.length < max; i++) {
      const cand = take((x) => isLand(x) && !isBasicLand(x));
      if (!cand || !addOrSwap(cand, landReason, 'lands')) break;
    }
    const colors = analysis.identity.length ? analysis.identity : ['C'];
    const pipTotal = colors.reduce((s2, c) => s2 + (analysis.colors.find((x) => x.c === c)?.pips || 1), 0);
    let need = landTarget - counts.lands;
    for (const c of colors) {
      if (need <= 0 || out.length >= max) break;
      const basic = basicFor(c);
      if (!basic) continue;
      const share = (analysis.colors.find((x) => x.c === c)?.pips || 1) / pipTotal;
      let n = c === colors[colors.length - 1] ? need : Math.max(1, Math.round((landTarget - analysis.counts.lands) * share));
      n = Math.min(n, need);
      if (sizeDelta >= n) {
        sizeDelta -= n;
        push({ kind: 'add', add: basic, qty: n, reason: landReason, tag: 'lands', score: 0 });
        need -= n;
      } else {
        for (let i = 0; i < n && out.length < max; i++) {
          addOrSwap({ card: basic, value: 0 }, landReason, 'lands');
          need--;
        }
      }
    }
  }
  while (counts.lands > landTarget + 2 && out.length < max) {
    const landEntry = mainEntries
      .filter((e) => isLand(e.card) && !cut.has(e.card.name) && !(isBasicLand(e.card) && e.qty <= 0))
      .sort((a, b) => (isBasicLand(b.card) ? 1 : 0) - (isBasicLand(a.card) ? 1 : 0) || (analysis.values.get(a.card.name)?.value ?? 0) - (analysis.values.get(b.card.name)?.value ?? 0))[0];
    if (!landEntry) break;
    if (!isBasicLand(landEntry.card)) cut.add(landEntry.card.name);
    const cand = sizeDelta >= 0 ? take((x) => !isLand(x)) : null;
    if (cand) push({ kind: 'swap', add: cand.card, cut: landEntry.card, reason: { code: 'cutLand', params: { n: analysis.counts.lands, target: landTarget } }, tag: 'lands', score: cand.value });
    else {
      sizeDelta++;
      push({ kind: 'cut', cut: landEntry.card, reason: { code: 'cutLand', params: { n: analysis.counts.lands, target: landTarget } }, tag: 'lands' });
    }
  }
  // 3) Funciones que faltan (la mayor carencia primero)
  const roles = ['ramp', 'draw', 'interaction', 'wipe'];
  for (let guard = 0; guard < 40 && out.length < max; guard++) {
    const worst = roles.map((r) => ({ r, d: deficit(r) })).filter((x) => x.d > (x.r === 'wipe' ? 1 : 0)).sort((a, b) => b.d - a.d)[0];
    if (!worst) break;
    const role = worst.r === 'interaction' ? 'removal' : worst.r;
    const cand = take((x) => !isLand(x) && (has(x, role) || (worst.r === 'interaction' && has(x, 'counter'))));
    if (!cand) {
      roles.splice(roles.indexOf(worst.r), 1);
      continue;
    }
    addOrSwap(cand, { code: 'addRole', params: { role: worst.r, n: analysis.counts[worst.r], target: TARGETS[worst.r] } }, worst.r);
  }
  // 4) Completar o recortar hasta 100
  while (sizeDelta > 0 && out.length < max) {
    const cand = take((x) => !isLand(x));
    if (!cand) break;
    sizeDelta--;
    push({ kind: 'add', add: cand.card, reason: { code: 'addFill', params: { total: analysis.counts.total } }, tag: 'count', score: cand.value });
  }
  while (sizeDelta < 0 && out.length < max) {
    const v = nextCut();
    if (!v) break;
    sizeDelta++;
    push({ kind: 'cut', cut: v.e.card, reason: { code: 'cutTrim', params: { total: analysis.counts.total } }, tag: 'count' });
  }
  // 5) Curva demasiado alta: cambiar cartas caras y flojas por otras baratas
  if (analysis.counts.avgCmc > 3.6) {
    for (let i = 0; i < 4 && out.length < max; i++) {
      const v = nextCut((c) => (c.cmc || 0) >= 6);
      if (!v) break;
      const cand = take((x) => !isLand(x) && (x.cmc || 0) <= 3);
      if (!cand) break;
      push({ kind: 'swap', add: cand.card, cut: v.e.card, reason: { code: 'swapCurve', params: { name: v.e.card.name, cmc: v.e.card.cmc } }, tag: 'curve', score: cand.value, cutValue: v.value });
    }
  }
  // 6) Colores: cambiar básicas del color que sobra por el que falta
  for (const weak of analysis.colors.filter((c) => !c.ok)) {
    const strong = analysis.colors.filter((c) => c.ok).sort((a, b) => b.srcShare - b.share - (a.srcShare - a.share))[0];
    const from = strong && mainEntries.find((e) => e.card.name === BASIC_BY_COLOR[strong.c]);
    const to = basicFor(weak.c);
    if (!from || !to || out.length >= max) continue;
    for (let i = 0; i < 2; i++) push({ kind: 'swap', add: to, cut: from.card, reason: { code: 'swapColor', params: { from: strong.c, to: weak.c } }, tag: 'colors', score: 0 });
  }
  // 7) Mejoras: candidatas claramente mejores que las cartas más flojas
  for (let i = 0; i < (mode === 'upgrade' ? max : 5) && out.length < max; i++) {
    const v = cutPool()[0];
    const cand = pool.find((p) => !used.has(p.card.name) && !isLand(p.card));
    if (!v || !cand || cand.value < v.value + 0.6) break;
    used.add(cand.card.name);
    cut.add(v.e.card.name);
    push({ kind: 'swap', add: cand.card, cut: v.e.card, reason: { code: 'swapUpgrade', params: { name: v.e.card.name } }, tag: 'upgrade', score: cand.value, cutValue: v.value });
  }
  return out;
}

// ---------------------------------------------------------------- construir un mazo

/**
 * Construye las 99 cartas para el comandante. candidates: [{ card, inclusion?, synergy? }];
 * opts: { budget, bracket, basics: {W: card…}, lands }.
 * Devuelve [{ card, qty }].
 */
export function buildDeck(commanders, candidates, opts = {}) {
  const deck = { commanders: commanders.map((card) => ({ card, qty: 1 })), cards: [] };
  const identity = deckIdentity(deck);
  const themes = detectThemes({ commanders: deck.commanders, cards: candidates.slice(0, 120).map((c) => ({ card: c.card, qty: 1 })) });
  const ed = new Map(candidates.filter((c) => c.inclusion != null).map((c) => [nameKey(c.card.name), { inclusion: c.inclusion, synergy: c.synergy || 0 }]));
  const ctx = { edhrec: ed, themes };
  const pool = usableCandidates(deck, candidates, opts)
    .filter((c) => !isBasicLand(c.card))
    .map((c) => ({ ...c, value: cardValue(c.card, ctx).value }))
    .sort((a, b) => b.value - a.value);
  const picked = [];
  const pickedSet = new Set();
  const pick = (c) => {
    picked.push(c);
    pickedSet.add(c.card.name);
  };
  let gc = 0;
  const gcMax = opts.bracket == null ? 3 : opts.bracket <= 2 ? 0 : opts.bracket === 3 ? 3 : 99;
  const ok = (c) => !pickedSet.has(c.card.name) && (!c.card.game_changer || gc < gcMax);
  const takeTop = (filter, n) => {
    for (const c of pool) {
      if (n <= 0) break;
      if (!ok(c) || !filter(c.card)) continue;
      if (c.card.game_changer) gc++;
      pick(c);
      n--;
    }
  };
  const count = (role) => picked.filter((c) => has(c.card, role)).length;
  // Funciones básicas primero
  const nonLandTarget = 99 - (opts.lands ?? 36);
  takeTop((c) => !isLand(c) && has(c, 'ramp') && (c.cmc || 0) <= 3, TARGETS.ramp - count('ramp'));
  takeTop((c) => !isLand(c) && (has(c, 'removal') || has(c, 'counter')), TARGETS.interaction - count('removal') - count('counter'));
  takeTop((c) => !isLand(c) && has(c, 'draw'), TARGETS.draw - count('draw'));
  takeTop((c) => !isLand(c) && has(c, 'wipe'), TARGETS.wipe - count('wipe'));
  takeTop((c) => !isLand(c) && has(c, 'protection'), TARGETS.protection - count('protection'));
  // El resto: lo mejor para el comandante (sin pasarse de curva)
  const nonLand = () => picked.filter((c) => !isLand(c.card)).length;
  const highCmc = () => picked.filter((c) => (c.card.cmc || 0) >= 6).length;
  for (const c of pool) {
    if (nonLand() >= nonLandTarget) break;
    if (!ok(c) || isLand(c.card)) continue;
    if ((c.card.cmc || 0) >= 6 && highCmc() >= 6) continue;
    if (c.card.game_changer) gc++;
    pick(c);
  }
  // Tierras: las no básicas mejor valoradas y básicas según los símbolos de maná
  const landSlots = 99 - picked.length;
  const nonbasicTarget = Math.min(landSlots, identity.length <= 1 ? 6 : identity.length === 2 ? 12 : 17);
  takeTop((c) => isLand(c) && (identity.length > 1 || !/search your library/i.test(textOf(c))), nonbasicTarget);
  const cards = picked.map((c) => ({ card: c.card, qty: 1 }));
  const basicsNeeded = 99 - cards.length;
  if (basicsNeeded > 0) {
    const pips = Object.fromEntries(identity.map((c) => [c, 0]));
    for (const { card } of cards) for (const m of (card.mana_cost || '').matchAll(/\{([^}]+)\}/g)) for (const col of m[1].split('/')) if (col in pips) pips[col]++;
    const colors = identity.length ? identity : ['C'];
    const totalPips = colors.reduce((s, c) => s + (pips[c] || 1), 0);
    let left = basicsNeeded;
    colors.forEach((c, i) => {
      const n = i === colors.length - 1 ? left : Math.round((basicsNeeded * (pips[c] || 1)) / totalPips);
      const basic = opts.basics?.[c];
      if (basic && n > 0) cards.push({ card: basic, qty: Math.min(n, left) });
      left -= Math.min(n, left);
    });
  }
  return cards;
}
