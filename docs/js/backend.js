/**
 * Acceso a los servicios de la app con dos modos:
 *  - "server": hay un servidor Node (npm start) y se usan sus rutas /api/…
 *  - "static": página estática (GitHub Pages). Todo se hace desde el navegador:
 *    Scryfall, EDHREC, Google Translate y MyMemory permiten peticiones directas (CORS),
 *    y el traductor corre aquí mismo con memorias precalculadas (memory/<idioma>.json).
 */
import { createTranslator } from './translator/engine.js';
import { createMachineTranslator } from './translator/machine.js';
import { createMemoryStore, fetchScryfallPage } from './translator/store.js';
import { EDHREC_URL, SPELLBOOK_URL, simplifyCombos, simplifyEdhrec, spellbookBody } from './sources.js';
import { idbGet, idbSet } from './idb.js';

let modePromise = null;

/** Detecta si hay servidor (responde api/status) o si estamos en modo estático. */
export function detectMode() {
  modePromise ??= (async () => {
    // La versión publicada (GitHub Pages) lleva esta marca: así no se pregunta por un servidor que no existe.
    if (location.protocol === 'file:' || document.querySelector('meta[name="mtp-static"]')) return 'static';
    try {
      const res = await fetch('api/status', { signal: AbortSignal.timeout(4000) });
      const data = await res.json();
      return res.ok && data.mode === 'server' ? 'server' : 'static';
    } catch {
      return 'static';
    }
  })();
  return modePromise;
}

export class BackendError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new BackendError(data.error || `HTTP ${res.status}`);
  return data;
}

// ---------------------------------------------------------------- traductor en el navegador

const STATIC_MAX_AGE = 120 * 24 * 60 * 60 * 1000;

/** Caché síncrona en memoria con copia en IndexedDB. */
function createBrowserCache() {
  let map = new Map();
  let timer = null;
  const ready = idbGet('translations').then((saved) => {
    if (saved && typeof saved === 'object') map = new Map(Object.entries(saved));
  });
  return {
    ready,
    get: (k) => map.get(k),
    set(k, v) {
      map.set(k, v);
      clearTimeout(timer);
      timer = setTimeout(() => idbSet('translations', Object.fromEntries(map)), 1000);
    },
  };
}

let local = null;
function localServices() {
  if (local) return local;
  const cache = createBrowserCache();
  const memories = createMemoryStore({
    maxAge: STATIC_MAX_AGE,
    fetchPage: (q, page) => fetchScryfallPage(q, page),
    // La más reciente entre la precalculada (publicada con la web) y la guardada en este navegador.
    load: async (lang) => {
      const [published, saved] = await Promise.all([
        fetch(`memory/${lang}.json`)
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null),
        idbGet(`memory-${lang}`),
      ]);
      const candidates = [published, saved].filter((m) => m?.memory);
      return candidates.sort((a, b) => (b.builtAt || 0) - (a.builtAt || 0))[0] || null;
    },
    save: (lang, data) => idbSet(`memory-${lang}`, data),
  });
  const translator = createTranslator({ cache, memories, machine: createMachineTranslator() });
  local = { cache, memories, translator };
  return local;
}

// ---------------------------------------------------------------- API pública

export async function getStatus() {
  if ((await detectMode()) === 'server') return api('api/status');
  const { memories } = localServices();
  return { mode: 'static', ai: false, translator: 'memory+machine', memories: await memories.info() };
}

/** Empieza a preparar la memoria de un idioma. */
export async function warm(lang) {
  if (lang === 'en') return;
  if ((await detectMode()) === 'server') {
    await api(`api/memory/${lang}`, { method: 'POST' });
    return;
  }
  localServices().memories.get(lang).catch(() => {});
}

export async function translate(lang, cards) {
  if ((await detectMode()) === 'server') {
    return (await api('api/translate', { method: 'POST', body: { lang, cards } })).translations;
  }
  const { cache, translator } = localServices();
  await cache.ready;
  return translator.translate(lang, cards);
}

export async function edhrec(slug) {
  if ((await detectMode()) === 'server') return api(`api/edhrec/${slug}`);
  const res = await fetch(EDHREC_URL(slug));
  if (!res.ok) throw new BackendError(`EDHREC ${res.status}`);
  return simplifyEdhrec(await res.json());
}

export async function combos(commanders, main) {
  if ((await detectMode()) === 'server') return api('api/combos', { method: 'POST', body: { commanders, main } });
  try {
    const res = await fetch(SPELLBOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(spellbookBody(commanders, main)),
    });
    if (!res.ok) throw new Error(String(res.status));
    return simplifyCombos(await res.json());
  } catch {
    // Commander Spellbook no permite peticiones desde otras webs (CORS).
    throw new BackendError('combos-unavailable', 'needs-server');
  }
}

export async function importUrl(url) {
  if ((await detectMode()) === 'server') return api(`api/import?url=${encodeURIComponent(url)}`);
  // Archidekt, Moxfield, MTGGoldfish y TappedOut no permiten peticiones desde otras webs.
  throw new BackendError('import-unavailable', 'needs-server');
}
