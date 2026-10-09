/**
 * Funciones de cada carta (ramp, robo, removal…) con el modelo entrenado por la app
 * (scripts/train-roles.js → ai/roles-model.json) más unas reglas que lo completan.
 */
import { features } from './features.js';

let model = null;
let index = null;
const memo = new WeakMap();

/** Carga el modelo (en el navegador lo descarga; en las pruebas se pasa el JSON). */
export async function loadRolesModel(data) {
  if (model && !data) return model;
  if (!data) {
    const res = await fetch(new URL('../../ai/roles-model.json', import.meta.url));
    if (!res.ok) throw new Error(`roles-model ${res.status}`);
    data = await res.json();
  }
  model = data;
  index = new Map(model.vocab.map((f, i) => [f, i]));
  for (const r of Object.values(model.roles)) {
    r.map = new Map(r.weights.map(([i, w]) => [i, w]));
  }
  return model;
}

export const modelInfo = () => (model ? { cards: model.cards, builtAt: model.builtAt, roles: Object.keys(model.roles).length, f1: Object.fromEntries(Object.entries(model.roles).map(([k, r]) => [k, r.f1])) } : null);

// Reglas que el modelo no cubre o que conviene asegurar.
const RULES = {
  tokens: /\bcreate[^.]*\btokens?\b/i,
  wincon: /\byou win the game\b|each opponent loses \w+ life|infinite|deals? damage equal to [^.]*to each opponent/i,
  massLand: /destroy all lands|each player sacrifices [^.]*lands?/i,
  extraTurn: /take an extra turn/i,
  tutor: /search your library for (?:a|an|up to \w+) (?!(?:basic )?(?:land|Forest|Plains|Island|Swamp|Mountain|snow land)s?\b)[^.]*card/i,
  counter: /\bcounter target\b/i,
  wipe: /(?:destroy|exile) all (?:other )?(?:creatures|nonland permanents|permanents)|all creatures get -\w+\/-\w+|deals? \w+ damage to each creature/i,
};

const typeOf = (card) => card.type_line || (card.faces || card.card_faces || []).map((f) => f.type_line).join(' // ') || '';

/** Probabilidad de cada función (0-1). */
export function roleScores(card) {
  if (!card) return {};
  if (memo.has(card)) return memo.get(card);
  const out = {};
  const text = (card.faces?.length ? card.faces.map((f) => f.oracle_text).join('\n') : card.oracle_text) || '';
  if (model) {
    const feats = features(card).map((f) => index.get(f)).filter((i) => i != null);
    for (const [role, r] of Object.entries(model.roles)) {
      let z = r.bias;
      for (const i of feats) z += r.map.get(i) || 0;
      // Se normaliza para que el umbral del modelo quede en 0,5.
      const p = 1 / (1 + Math.exp(-z));
      out[role] = p >= r.threshold ? 0.5 + ((p - r.threshold) / (1 - r.threshold)) * 0.5 : (p / r.threshold) * 0.5;
    }
  }
  for (const [role, re] of Object.entries(RULES)) if (re.test(text)) out[role] = Math.max(out[role] || 0, 0.8);
  // Buscar solo tierras es ramp, no tutor (cuenta para el bracket); destruir tierras no es un barrido.
  if (!RULES.tutor.test(text)) out.tutor = Math.min(out.tutor || 0, 0.3);
  if (!/creatures?|nonland|permanents|all (?:artifacts|enchantments)/i.test(text)) out.wipe = Math.min(out.wipe || 0, 0.3);
  // Las tierras no cuentan como ramp (aunque den maná), salvo las que buscan tierras adicionales.
  if (/\bLand\b/.test(typeOf(card)) && !/\bCreature\b/.test(typeOf(card))) {
    if (!/search your library for [^.]*land/i.test(text)) out.ramp = Math.min(out.ramp || 0, 0.2);
  }
  memo.set(card, out);
  return out;
}

/** Funciones claras (por encima del umbral) de una carta, de más a menos seguras. */
export function rolesOf(card, min = 0.5) {
  return Object.entries(roleScores(card))
    .filter(([, p]) => p >= min)
    .sort((a, b) => b[1] - a[1])
    .map(([r]) => r);
}
