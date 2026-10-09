#!/usr/bin/env node
/**
 * Entrena el modelo de funciones de carta (la "IA" propia de la app).
 *
 * Datos: las etiquetas de función de Scryfall Tagger (otag:ramp, otag:board-wipe…) para todas
 * las cartas legales en Commander, más las ~9000 cartas más jugadas como ejemplos generales.
 * Modelo: una regresión logística por función sobre rasgos del texto de reglas (palabras,
 * parejas de palabras, tipos y coste), con el umbral ajustado para el mejor F1 en validación.
 *
 *   node scripts/train-roles.js [--cache <dir>] [--out public/ai/roles-model.json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { features } from '../public/js/ai/features.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : def;
};
const OUT = path.resolve(ROOT, arg('--out', 'public/ai/roles-model.json'));
const CACHE = path.resolve(arg('--cache', path.join(ROOT, '.cache/train')));
fs.mkdirSync(CACHE, { recursive: true });

/** Función → consulta de Scryfall Tagger. */
export const ROLES = {
  ramp: 'otag:ramp',
  draw: 'otag:draw',
  removal: 'otag:spot-removal',
  wipe: 'otag:board-wipe',
  counter: 'otag:counterspell',
  tutor: 'otag:tutor',
  recursion: '(otag:recursion or otag:reanimate)',
  protection: 'otag:protection',
  sacOutlet: 'otag:sacrifice-outlet',
  lifegain: 'otag:lifegain',
  gravehate: 'otag:graveyard-hate',
  anthem: 'otag:anthem',
  costReducer: 'otag:cost-reducer',
  landRemoval: 'otag:land-removal',
  extraTurn: 'otag:extra-turn',
  wheel: 'otag:wheel',
  theft: 'otag:theft',
  discard: 'otag:discard',
  mill: 'otag:mill',
  flicker: 'otag:flicker',
  copy: 'otag:copy',
  untapper: 'otag:untapper',
  burn: 'otag:burn',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function page(q, n) {
  const file = path.join(CACHE, `${Buffer.from(`${q}#${n}`).toString('base64url')}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const url = `https://api.scryfall.com/cards/search?q=${encodeURIComponent(q)}&unique=cards&order=edhrec&page=${n}`;
  for (let attempt = 0; ; attempt++) {
    await sleep(120);
    const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'MagicThePDF/1.0 (training)' } });
    if (res.status === 404) return { data: [], has_more: false };
    if (res.ok) {
      const d = await res.json();
      const slim = {
        has_more: d.has_more,
        data: d.data.map((c) => ({
          name: c.name,
          type_line: c.type_line || (c.card_faces || []).map((f) => f.type_line).join(' // '),
          oracle_text: c.oracle_text || '',
          card_faces: c.card_faces?.map((f) => ({ name: f.name, oracle_text: f.oracle_text || '', type_line: f.type_line })),
          cmc: c.cmc,
          keywords: c.keywords,
        })),
      };
      fs.writeFileSync(file, JSON.stringify(slim));
      return slim;
    }
    if (attempt > 4) throw new Error(`Scryfall ${res.status} para ${q}`);
    await sleep(1500 * 2 ** attempt);
  }
}

async function all(q, max = 60) {
  const out = [];
  for (let n = 1; n <= max; n++) {
    const d = await page(q, n);
    out.push(...d.data);
    if (!d.has_more) break;
  }
  return out;
}

// ---------------------------------------------------------------- datos

const cards = new Map();
const labels = new Map(); // nombre → Set(funciones)
for (const [role, q] of Object.entries(ROLES)) {
  const list = await all(`${q} f:commander`);
  for (const c of list) {
    cards.set(c.name, c);
    if (!labels.has(c.name)) labels.set(c.name, new Set());
    labels.get(c.name).add(role);
  }
  console.log(`${role.padEnd(12)} ${list.length}`);
}
for (const c of await all('f:commander -t:basic', 50)) if (!cards.has(c.name)) cards.set(c.name, c);
console.log(`cartas: ${cards.size}`);

// Reparto determinista entrenamiento / validación (por nombre).
const hash = (s) => [...s].reduce((h, ch) => (Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0), 2166136261);
const docs = [...cards.values()].map((c) => ({ name: c.name, feats: features(c), roles: labels.get(c.name) || new Set(), val: hash(c.name) % 100 < 15 }));

// Vocabulario: rasgos presentes en al menos 4 cartas.
const df = new Map();
for (const d of docs) for (const f of d.feats) df.set(f, (df.get(f) || 0) + 1);
const vocab = [...df].filter(([, n]) => n >= 4).map(([f]) => f);
const index = new Map(vocab.map((f, i) => [f, i]));
for (const d of docs) d.x = d.feats.map((f) => index.get(f)).filter((i) => i != null);
console.log(`vocabulario: ${vocab.length}`);

// ---------------------------------------------------------------- entrenamiento

const sigmoid = (z) => 1 / (1 + Math.exp(-z));

function train(role) {
  const tr = docs.filter((d) => !d.val);
  const w = new Float64Array(vocab.length);
  let b = 0;
  const pos = tr.filter((d) => d.roles.has(role)).length;
  // Las positivas pesan más cuando escasean (equilibrio de clases suave).
  const posW = Math.min(8, Math.sqrt((tr.length - pos) / Math.max(1, pos)));
  const l2 = 1e-4;
  let lr = 0.3;
  const order = tr.map((_, i) => i);
  for (let epoch = 0; epoch < 14; epoch++) {
    for (let i = order.length - 1; i > 0; i--) {
      const j = (hash(`${role}${epoch}${i}`) % (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    for (const k of order) {
      const d = tr[k];
      const y = d.roles.has(role) ? 1 : 0;
      let z = b;
      for (const i of d.x) z += w[i];
      const g = (sigmoid(z) - y) * (y ? posW : 1);
      b -= lr * g;
      for (const i of d.x) w[i] -= lr * (g + l2 * w[i]);
    }
    lr *= 0.8;
  }
  // Umbral con el mejor F1 en validación.
  const va = docs.filter((d) => d.val).map((d) => {
    let z = b;
    for (const i of d.x) z += w[i];
    return { p: sigmoid(z), y: d.roles.has(role) };
  });
  let best = { f1: 0, t: 0.5, p: 0, r: 0 };
  for (let t = 0.2; t <= 0.9; t += 0.05) {
    const tp = va.filter((v) => v.p >= t && v.y).length;
    const fp = va.filter((v) => v.p >= t && !v.y).length;
    const fn = va.filter((v) => v.p < t && v.y).length;
    const p = tp / Math.max(1, tp + fp);
    const r = tp / Math.max(1, tp + fn);
    const f1 = (2 * p * r) / Math.max(1e-9, p + r);
    if (f1 > best.f1) best = { f1, t, p, r };
  }
  return { w, b, ...best, support: va.filter((v) => v.y).length };
}

const model = { version: 1, builtAt: Date.now(), cards: cards.size, vocab: [], roles: {} };
const used = new Map();
const report = [];
for (const role of Object.keys(ROLES)) {
  const m = train(role);
  // Solo los rasgos con peso apreciable (modelo pequeño para la web).
  const top = [...m.w.keys()].filter((i) => Math.abs(m.w[i]) >= 0.05).sort((a, c) => Math.abs(m.w[c]) - Math.abs(m.w[a])).slice(0, 1800);
  const weights = top.map((i) => {
    if (!used.has(i)) used.set(i, used.size);
    return [used.get(i), Math.round(m.w[i] * 100) / 100];
  });
  model.roles[role] = { bias: Math.round(m.b * 1000) / 1000, threshold: Math.round(m.t * 100) / 100, weights, f1: Math.round(m.f1 * 1000) / 1000 };
  report.push(`${role.padEnd(12)} F1 ${(m.f1 * 100).toFixed(1)}%  precisión ${(m.p * 100).toFixed(1)}%  exhaustividad ${(m.r * 100).toFixed(1)}%  (${m.support} en validación)`);
}
model.vocab = [...used.keys()].sort((a, c) => used.get(a) - used.get(c)).map((i) => vocab[i]);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(model));
console.log(report.join('\n'));
console.log(`modelo: ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB, ${model.vocab.length} rasgos)`);
