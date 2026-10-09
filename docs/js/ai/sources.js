/**
 * Datos para la IA de mazos (en el navegador): cartas candidatas de EDHREC y de Scryfall
 * (etiquetas de función de Scryfall Tagger), básicas y caché de cartas por nombre.
 */
import * as sf from '../scryfall.js';
import * as backend from '../backend.js';
import { deckIdentity, edhrecSlug } from '../deck.js';
import { BASIC_BY_COLOR } from './brain.js';

const byName = new Map();
const key = (n) => String(n || '').split(' // ')[0].toLowerCase();

/** Cartas completas (de Scryfall) a partir de sus nombres, con caché. */
export async function cardsByName(names) {
  const missing = [...new Set(names.filter((n) => !byName.has(key(n))))];
  if (missing.length) {
    const { found } = await sf.collection(missing.map((name) => ({ name: name.split(' // ')[0] })));
    for (const c of found) {
      byName.set(key(c.name), c);
      byName.set(c.name.toLowerCase(), c);
    }
  }
  return names.map((n) => byName.get(key(n))).filter(Boolean);
}

const edhrecCache = new Map();
/** Datos de EDHREC del comandante (o pareja). null si no hay. */
export async function edhrecFor(deck) {
  const names = deck.commanders.map((e) => e.card?.name).filter(Boolean);
  if (!names.length) return null;
  const slug = edhrecSlug(names);
  if (!edhrecCache.has(slug)) edhrecCache.set(slug, backend.edhrec(slug).catch(() => null));
  return edhrecCache.get(slug);
}

const ROLE_QUERY = {
  ramp: 'otag:ramp',
  draw: 'otag:draw',
  interaction: '(otag:spot-removal or otag:counterspell)',
  removal: 'otag:spot-removal',
  wipe: 'otag:board-wipe',
  counter: 'otag:counterspell',
  protection: 'otag:protection',
  tutor: 'otag:tutor',
  recursion: '(otag:recursion or otag:reanimate)',
  lands: 't:land -t:basic',
};

const idQuery = (identity) => (identity.length ? `id<=${identity.join('').toLowerCase()}` : 'id:c');

/**
 * Cartas candidatas para el mazo. opts: { roles: [...], budget, bracket, general, lands }.
 */
export async function candidatesFor(deck, opts = {}) {
  const identity = deckIdentity(deck);
  const out = [];
  const ed = opts.edhrec === false ? null : await edhrecFor(deck);
  if (ed?.lists?.length) {
    const entries = ed.lists.flatMap((l) => l.cards).slice(0, 450);
    const cards = await cardsByName(entries.map((c) => c.name));
    const info = new Map(entries.map((c) => [key(c.name), c]));
    for (const card of cards) {
      const i = info.get(key(card.name));
      out.push({ card, inclusion: i?.inclusion ?? null, synergy: i?.synergy ?? 0, source: 'edhrec' });
    }
  }
  const extra = [
    opts.budget != null ? ` usd<=${opts.budget}` : '',
    opts.bracket != null && opts.bracket <= 2 ? ' -is:gamechanger' : '',
  ].join('');
  const queries = [];
  for (const r of new Set(opts.roles || [])) if (ROLE_QUERY[r]) queries.push(`${ROLE_QUERY[r]} ${idQuery(identity)} f:commander${extra}`);
  if (opts.general || !ed?.lists?.length) queries.push(`${idQuery(identity)} f:commander -t:basic${extra}`);
  if ((opts.lands || !ed?.lists?.length) && identity.length > 1) queries.push(`${ROLE_QUERY.lands} ${idQuery(identity)} f:commander${extra}`);
  for (const q of queries) {
    try {
      const { cards } = await sf.search(q, { order: 'edhrec' });
      for (const card of cards) {
        byName.set(key(card.name), card);
        out.push({ card, inclusion: null, synergy: 0, source: 'scryfall' });
      }
    } catch {
      /* sin conexión con Scryfall: se sigue con lo que haya */
    }
  }
  return { candidates: out, edhrec: ed };
}

/** Tierras básicas para la identidad del mazo: { W: card, U: card… }. */
export async function basicsFor(identity) {
  const colors = identity.length ? identity : ['C'];
  const cards = await cardsByName(colors.map((c) => BASIC_BY_COLOR[c]));
  const out = {};
  for (const c of colors) out[c] = cards.find((x) => x.name === BASIC_BY_COLOR[c]);
  return out;
}
