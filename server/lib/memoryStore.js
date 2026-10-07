import fs from 'node:fs';
import path from 'node:path';
import { TranslationMemory } from './memory.js';
import { fetchJson } from './http.js';

const MAX_AGE = 30 * 24 * 60 * 60 * 1000;

/**
 * Construye (y guarda en disco) una memoria de traducción por idioma a partir de las
 * cartas oficiales más recientes de Scryfall en ese idioma.
 */
export function createMemoryStore({ dir = null, scryfall, pages = 24, fetchPage } = {}) {
  const memories = new Map();
  const status = new Map();

  const file = (lang) => dir && path.join(dir, `memory-${lang}.json`);

  function loadFromDisk(lang) {
    try {
      const raw = JSON.parse(fs.readFileSync(file(lang), 'utf8'));
      if (Date.now() - raw.builtAt > MAX_AGE) return null;
      return TranslationMemory.fromJSON(raw.memory);
    } catch {
      return null;
    }
  }

  // Las cartas más recientes dan la redacción actual; las de antes de 2024 traen además
  // la línea de tipo impresa (printed_type_line), que Scryfall no tiene en las más nuevas.
  const queries = (lang) => [
    { q: `lang:${lang} game:paper`, pages },
    { q: `lang:${lang} game:paper year<=2023`, pages: Math.ceil(pages / 2) },
  ];

  async function defaultFetchPage(q, page) {
    const url = `https://api.scryfall.com/cards/search?q=${encodeURIComponent(q)}&unique=prints&order=released&dir=desc&page=${page}`;
    for (let attempt = 0; ; attempt++) {
      try {
        // Pausa extra entre páginas grandes para no saturar Scryfall.
        await new Promise((r) => setTimeout(r, 300));
        return await scryfall(() => fetchJson(url, { timeoutMs: 30000 }));
      } catch (err) {
        if (err.status !== 429 || attempt >= 4) throw err;
        await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
      }
    }
  }

  async function build(lang) {
    const mem = new TranslationMemory(lang);
    const getPage = fetchPage || defaultFetchPage;
    const plan = queries(lang);
    const total = plan.reduce((n, p) => n + p.pages, 0);
    let done = 0;
    let complete = true;
    for (const { q, pages: max } of plan) {
      for (let page = 1; page <= max; page++) {
        status.set(lang, { building: true, page: ++done, pages: total });
        let data;
        try {
          data = await getPage(q, page);
        } catch (err) {
          console.warn(`[memoria] ${lang} "${q}" página ${page}: ${err.message}`);
          complete = false;
          break;
        }
        for (const card of data.data || []) mem.addCard(card);
        if (!data.has_more) break;
      }
    }
    // Una memoria incompleta se usa, pero no se guarda: se reconstruirá en el próximo arranque.
    if (dir && mem.size && complete) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file(lang), JSON.stringify({ builtAt: Date.now(), memory: mem.toJSON() }));
      } catch (err) {
        console.warn(`[memoria] No se pudo guardar: ${err.message}`);
      }
    }
    console.log(`[memoria] ${lang}: ${mem.cards} cartas, ${mem.size} plantillas, ${mem.subtypes.size} subtipos`);
    return mem;
  }

  function get(lang) {
    if (lang === 'en') return Promise.resolve(null);
    if (!memories.has(lang)) {
      const fromDisk = dir ? loadFromDisk(lang) : null;
      const p = fromDisk ? Promise.resolve(fromDisk) : build(lang);
      p.then(() => status.set(lang, { building: false })).catch(() => memories.delete(lang));
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
