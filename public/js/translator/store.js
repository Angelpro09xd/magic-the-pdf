/**
 * Construcción y almacenamiento de las memorias de traducción (una por idioma).
 * Común al servidor (guarda en disco) y al navegador (ficheros precalculados + IndexedDB).
 */
import { TranslationMemory } from './memory.js';

export const MEMORY_MAX_AGE = 30 * 24 * 60 * 60 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Consultas a Scryfall: las cartas más recientes dan la redacción actual; las de antes
 * de 2024 traen además la línea de tipo impresa (que Scryfall no tiene en las nuevas).
 */
export function memoryQueries(lang, pages = 24) {
  return [
    { q: `lang:${lang} game:paper`, pages },
    { q: `lang:${lang} game:paper year<=2023`, pages: Math.ceil(pages / 2) },
  ];
}

/** Una página de búsqueda de Scryfall, con pausa y reintentos si nos limitan (429). */
export async function fetchScryfallPage(q, page, { headers = {}, throttle = (fn) => fn() } = {}) {
  const url = `https://api.scryfall.com/cards/search?q=${encodeURIComponent(q)}&unique=prints&order=released&dir=desc&page=${page}`;
  for (let attempt = 0; ; attempt++) {
    await sleep(300);
    let res;
    try {
      res = await throttle(() => fetch(url, { headers: { Accept: 'application/json', ...headers } }));
    } catch (err) {
      // En el navegador, un 429 de Scryfall llega sin cabeceras CORS y fetch falla: se reintenta igual.
      if (attempt >= 3) throw err;
      await sleep(2000 * 2 ** attempt);
      continue;
    }
    if (res.ok) return res.json();
    if (res.status === 404) return { data: [], has_more: false };
    if (res.status !== 429 || attempt >= 4) throw new Error(`Scryfall respondió ${res.status}`);
    await sleep(2000 * 2 ** attempt);
  }
}

/** Descarga cartas oficiales del idioma y aprende de ellas. */
export async function buildMemory(lang, { pages = 24, fetchPage, onProgress = () => {} } = {}) {
  const mem = new TranslationMemory(lang);
  const plan = memoryQueries(lang, pages);
  const total = plan.reduce((n, p) => n + p.pages, 0);
  let done = 0;
  let complete = true;
  for (const { q, pages: max } of plan) {
    for (let page = 1; page <= max; page++) {
      onProgress(++done, total);
      let data;
      try {
        data = await fetchPage(q, page);
      } catch (err) {
        console.warn(`[memoria] ${lang} "${q}" página ${page}: ${err.message}`);
        complete = false;
        break;
      }
      for (const card of data.data || []) mem.addCard(card);
      if (!data.has_more) break;
    }
  }
  return { memory: mem, complete };
}

/**
 * Almacén de memorias.
 * load(lang) → { builtAt, memory } | null; save(lang, { builtAt, memory }) guarda.
 */
export function createMemoryStore({ load = async () => null, save = async () => {}, fetchPage, pages = 24, maxAge = MEMORY_MAX_AGE } = {}) {
  const memories = new Map();
  const status = new Map();

  async function obtain(lang) {
    try {
      const stored = await load(lang);
      if (stored?.memory && (!stored.builtAt || Date.now() - stored.builtAt <= maxAge)) {
        return TranslationMemory.fromJSON(stored.memory);
      }
    } catch {
      // Si falla la lectura, se reconstruye.
    }
    const { memory, complete } = await buildMemory(lang, {
      pages,
      fetchPage,
      onProgress: (page, total) => status.set(lang, { building: true, page, pages: total }),
    });
    // Una memoria incompleta se usa, pero no se guarda: se reconstruirá la próxima vez.
    if (complete && memory.size) {
      try {
        await save(lang, { builtAt: Date.now(), memory: memory.toJSON() });
      } catch (err) {
        console.warn(`[memoria] No se pudo guardar: ${err.message}`);
      }
    }
    console.log(`[memoria] ${lang}: ${memory.cards} cartas, ${memory.size} plantillas, ${memory.subtypes.size} subtipos`);
    return memory;
  }

  function get(lang) {
    if (lang === 'en') return Promise.resolve(null);
    if (!memories.has(lang)) {
      status.set(lang, { building: true, page: 0, pages: 0 });
      const p = obtain(lang);
      p.then(() => status.set(lang, { building: false })).catch(() => {
        memories.delete(lang);
        status.delete(lang);
      });
      memories.set(lang, p);
    }
    return memories.get(lang);
  }

  async function info() {
    const out = {};
    for (const [lang, p] of memories) {
      const st = status.get(lang) || {};
      if (st.building) out[lang] = { building: true, page: st.page, pages: st.pages };
      else {
        const mem = await p.catch(() => null);
        out[lang] = mem ? { cards: mem.cards, templates: mem.size } : { error: true };
      }
    }
    return out;
  }

  return { get, info };
}
