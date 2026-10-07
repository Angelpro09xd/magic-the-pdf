/**
 * Cliente de la API de Scryfall (https://scryfall.com/docs/api) desde el navegador.
 * Scryfall permite CORS y pide no superar ~10 peticiones/segundo.
 */
import { slimCard } from './deck.js';

const API = 'https://api.scryfall.com';
let last = 0;
let chain = Promise.resolve();

function throttled(fn) {
  const run = chain.then(async () => {
    const wait = last + 110 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
    return fn();
  });
  chain = run.catch(() => {});
  return run;
}

export class ScryfallError extends Error {
  constructor(status, details) {
    super(details || `Scryfall ${status}`);
    this.status = status;
  }
}

async function get(pathOrUrl, init) {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${API}${pathOrUrl}`;
  return throttled(async () => {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, ...init });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ScryfallError(res.status, data.details);
    return data;
  });
}

const q = encodeURIComponent;

/** Búsqueda con la sintaxis completa de Scryfall. Devuelve { cards, total, hasMore, next }. */
export async function search(query, { order = 'edhrec', dir = 'auto', unique = 'cards', page = 1 } = {}) {
  try {
    const data = await get(`/cards/search?q=${q(query)}&order=${order}&dir=${dir}&unique=${unique}&page=${page}`);
    return { cards: data.data.map(slimCard), total: data.total_cards, hasMore: data.has_more };
  } catch (err) {
    if (err.status === 404) return { cards: [], total: 0, hasMore: false };
    throw err;
  }
}

export async function autocomplete(text) {
  if (text.trim().length < 2) return [];
  const data = await get(`/cards/autocomplete?q=${q(text)}`);
  return data.data || [];
}

export async function named(name, { fuzzy = false, set } = {}) {
  const data = await get(`/cards/named?${fuzzy ? 'fuzzy' : 'exact'}=${q(name)}${set ? `&set=${q(set)}` : ''}`);
  return slimCard(data);
}

export async function byId(id) {
  return slimCard(await get(`/cards/${q(id)}`));
}

export async function randomCard(query) {
  return slimCard(await get(`/cards/random?q=${q(query)}`));
}

export async function rulings(id) {
  const data = await get(`/cards/${q(id)}/rulings`);
  return data.data || [];
}

/** Todas las impresiones (todas las ediciones e idiomas) de una carta. */
export async function prints(oracleId, lang = 'any') {
  const langFilter = lang === 'any' ? 'lang:any' : `lang:${lang}`;
  const out = [];
  let url = `/cards/search?q=${q(`oracleid:${oracleId} ${langFilter}`)}&unique=prints&order=released&dir=desc`;
  for (let i = 0; url && i < 5; i++) {
    try {
      const data = await get(url);
      out.push(...data.data.map(slimCard));
      url = data.has_more ? data.next_page : null;
    } catch (err) {
      if (err.status === 404) break;
      throw err;
    }
  }
  return out;
}

/**
 * Carga muchas cartas a la vez con /cards/collection (75 por petición).
 * identifiers: [{ id } | { name } | { name, set } | { set, collector_number }]
 */
export async function collection(identifiers) {
  const found = [];
  const notFound = [];
  for (let i = 0; i < identifiers.length; i += 75) {
    const chunk = identifiers.slice(i, i + 75);
    const data = await get('/cards/collection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ identifiers: chunk }),
    });
    found.push(...data.data.map(slimCard));
    notFound.push(...(data.not_found || []));
  }
  return { found, notFound };
}

/** Divide nombres en consultas OR que no superen ~900 caracteres. */
function nameQueries(names, extra) {
  const queries = [];
  let current = [];
  let length = 0;
  for (const n of names) {
    const part = `!"${n.replace(/"/g, '')}"`;
    if (current.length && length + part.length > 900) {
      queries.push(current);
      current = [];
      length = 0;
    }
    current.push(part);
    length += part.length + 4;
  }
  if (current.length) queries.push(current);
  return queries.map((parts) => `${extra} (${parts.join(' or ')})`);
}

async function searchAll(query, order = 'released') {
  const out = [];
  let url = `/cards/search?q=${q(query)}&unique=prints&order=${order}&dir=desc&include_extras=true`;
  while (url) {
    try {
      const data = await get(url);
      out.push(...data.data);
      url = data.has_more ? data.next_page : null;
    } catch (err) {
      if (err.status === 404) break;
      throw err;
    }
  }
  return out;
}

const isGoodPrint = (c) =>
  c.image_status !== 'missing' &&
  c.image_status !== 'placeholder' &&
  !c.digital &&
  !['art_series', 'double_faced_token'].includes(c.layout) &&
  !c.oversized &&
  (c.image_uris || c.card_faces?.[0]?.image_uris);

/**
 * Busca, para cada carta, una impresión oficial en el idioma indicado.
 * cards: slimCards. Devuelve Map<oracle_id, slimCard>. Prefiere la misma edición.
 */
export async function findPrintsInLanguage(cards, lang, onProgress) {
  const result = new Map();
  const names = [...new Set(cards.map((c) => c.name))];
  const queries = nameQueries(names, `lang:${lang}`);
  let done = 0;
  for (const query of queries) {
    const found = await searchAll(query);
    for (const raw of found) {
      if (!isGoodPrint(raw)) continue;
      const oid = raw.oracle_id || raw.card_faces?.[0]?.oracle_id;
      const wanted = cards.find((c) => c.oracle_id === oid);
      if (!wanted) continue;
      const prev = result.get(oid);
      const sameSet = raw.set === wanted.set;
      if (!prev || (sameSet && prev.set !== wanted.set)) result.set(oid, slimCard(raw));
    }
    onProgress?.(++done, queries.length);
  }
  return result;
}

/**
 * Todas las impresiones de varias cartas a la vez (para cambiar el arte de todo el mazo).
 * Devuelve Map<oracle_id, slimCard[]> ordenadas de más nueva a más antigua.
 */
export async function printsForCards(cards, extra = '', onProgress) {
  const result = new Map();
  const names = [...new Set(cards.map((c) => c.name))];
  const queries = nameQueries(names, `game:paper ${extra}`.trim());
  let done = 0;
  for (const query of queries) {
    for (const raw of await searchAll(query)) {
      if (!isGoodPrint(raw)) continue;
      const slim = slimCard(raw);
      if (!result.has(slim.oracle_id)) result.set(slim.oracle_id, []);
      result.get(slim.oracle_id).push(slim);
    }
    onProgress?.(++done, queries.length);
  }
  return result;
}

/** Etiquetas de estilo de una impresión (para filtrar artes). */
export function printStyle(card) {
  const tags = [];
  if (card.border_color === 'borderless') tags.push('borderless');
  if (card.frame_effects?.includes('showcase')) tags.push('showcase');
  if (card.frame_effects?.includes('extendedart')) tags.push('extended');
  if (card.full_art) tags.push('fullart');
  if (card.frame === '1993' || card.frame === '1997') tags.push('retro');
  if (card.frame_effects?.includes('etched')) tags.push('etched');
  if (card.promo) tags.push('promo');
  if (!tags.length) tags.push('normal');
  return tags;
}

/** Marco moderno (2015) sin arte completo: el que mejor admite superponer texto traducido. */
export function overlayFriendly(card) {
  const badEffects = ['showcase', 'etched', 'inverted', 'extendedart', 'fullart', 'textless', 'spree'];
  const badLayouts = ['saga', 'class', 'case', 'split', 'flip', 'adventure', 'leveler', 'planar', 'scheme', 'battle', 'prototype', 'mutate', 'meld', 'host', 'augment'];
  return (
    card?.frame === '2015' &&
    !card.full_art &&
    ['black', 'white', 'silver'].includes(card.border_color) &&
    !card.frame_effects?.some((e) => badEffects.includes(e)) &&
    !badLayouts.includes(card.layout) &&
    !/Planeswalker/.test(card.type_line)
  );
}

/** Busca impresiones inglesas con marco moderno para superponer la traducción. */
export async function findOverlayBases(cards) {
  const result = new Map();
  const names = [...new Set(cards.map((c) => c.name))];
  const queries = nameQueries(names, 'lang:en frame:2015 -is:fullart -frame:showcase -frame:extendedart -frame:etched -is:borderless');
  for (const query of queries) {
    const found = await searchAll(query);
    for (const raw of found) {
      if (!isGoodPrint(raw)) continue;
      const slim = slimCard(raw);
      if (!overlayFriendly(slim)) continue;
      if (!result.has(slim.oracle_id)) result.set(slim.oracle_id, slim);
    }
  }
  return result;
}

let symbologyPromise = null;
/** Map símbolo → URL del SVG ("{T}" → https://svgs.scryfall.io/card-symbols/T.svg). */
export function symbology() {
  symbologyPromise ??= get('/symbology')
    .then((data) => new Map(data.data.map((s) => [s.symbol, s.svg_uri])))
    .catch(() => new Map());
  return symbologyPromise;
}
