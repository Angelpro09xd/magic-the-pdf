import fs from 'node:fs';
import path from 'node:path';
import { createMemoryStore as createStore, fetchScryfallPage } from '../../public/js/translator/store.js';

const USER_AGENT = 'MagicThePDF/1.0 (+https://github.com/angelpro09xd/magic-the-pdf)';

/** Memorias de traducción del servidor, guardadas en data/memory-<idioma>.json. */
export function createMemoryStore({ dir = null, scryfall = (fn) => fn(), pages = 24, fetchPage, maxAge } = {}) {
  const file = (lang) => path.join(dir, `memory-${lang}.json`);
  return createStore({
    pages,
    maxAge,
    fetchPage: fetchPage || ((q, page) => fetchScryfallPage(q, page, { headers: { 'User-Agent': USER_AGENT }, throttle: scryfall })),
    load: async (lang) => (dir ? JSON.parse(await fs.promises.readFile(file(lang), 'utf8')) : null),
    save: async (lang, data) => {
      if (!dir) return;
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(file(lang), JSON.stringify(data));
    },
  });
}
