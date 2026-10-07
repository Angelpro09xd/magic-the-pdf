import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { Cache } from './lib/cache.js';
import { createThrottle, fetchBinary, fetchJson, HttpError } from './lib/http.js';
import { createServerTranslator } from './lib/translate.js';
import { createMemoryStore } from './lib/memoryStore.js';
import { createMachineTranslator } from '../public/js/translator/machine.js';
import { EDHREC_URL, SPELLBOOK_URL, simplifyCombos, simplifyEdhrec, spellbookBody } from '../public/js/sources.js';
import { importDeckFromUrl } from './lib/importers.js';
import { getLanguage } from '../public/js/languages.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const DAY = 24 * 60 * 60 * 1000;

const IMAGE_HOSTS = new Set(['cards.scryfall.io', 'svgs.scryfall.io', 'c1.scryfall.com', 'gatherer.wizards.com']);

export function createApp({ anthropic, model, effort, mymemoryEmail, cacheDir, memories, machine, warmup = [] } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));

  const scryfall = createThrottle(110);
  const translationCache = new Cache({ file: cacheDir && path.join(cacheDir, 'translations.json'), maxEntries: 50000 });
  const apiCache = new Cache({ ttlMs: DAY, maxEntries: 2000 });
  const imageCache = new Cache({ ttlMs: DAY, maxEntries: 400 });
  const memoryStore = memories || createMemoryStore({ dir: cacheDir, scryfall });
  const translator = createServerTranslator({
    anthropic,
    model,
    effort,
    cache: translationCache,
    memories: memoryStore,
    machine: machine || createMachineTranslator({ email: mymemoryEmail }),
  });
  // Precarga la memoria de los idiomas más usados para que la primera traducción sea rápida.
  for (const lang of warmup) memoryStore.get(lang).catch(() => {});

  const cached = async (key, fn) => {
    const hit = apiCache.get(key);
    if (hit !== undefined) return hit;
    const value = await fn();
    apiCache.set(key, value);
    return value;
  };

  const route = (fn) => async (req, res) => {
    try {
      res.json(await fn(req, res));
    } catch (err) {
      const status = err instanceof HttpError ? (err.status >= 400 && err.status < 600 ? err.status : 502) : 500;
      if (status >= 500) console.error(`[api] ${req.method} ${req.path}: ${err.message}`);
      res.status(status).json({ error: err.message });
    }
  };

  app.get(
    '/api/status',
    route(async () => ({
      ai: translator.hasAI,
      model: translator.hasAI ? model : null,
      translator: 'memory+machine',
      mode: 'server',
      memories: await memoryStore.info(),
    })),
  );

  // Empieza a preparar (en segundo plano) la memoria de traducción de un idioma.
  app.post(
    '/api/memory/:lang',
    route(async (req) => {
      const lang = String(req.params.lang);
      if (!getLanguage(lang)) throw new HttpError(400, 'Idioma no soportado');
      memoryStore.get(lang).catch(() => {});
      return { memories: await memoryStore.info() };
    }),
  );

  // Proxy de imágenes: permite usar las imágenes en <canvas> y en el PDF sin problemas de CORS.
  app.get('/api/image', async (req, res) => {
    let url;
    try {
      url = new URL(String(req.query.url || ''));
    } catch {
      return res.status(400).json({ error: 'URL no válida' });
    }
    if (url.protocol !== 'https:' || !IMAGE_HOSTS.has(url.hostname)) {
      return res.status(400).json({ error: 'Host de imagen no permitido' });
    }
    try {
      let img = imageCache.get(url.href);
      if (!img) {
        img = await fetchBinary(url.href);
        imageCache.set(url.href, img);
      }
      res.set('Content-Type', img.contentType);
      res.set('Cache-Control', 'public, max-age=604800, immutable');
      res.send(img.buffer);
    } catch (err) {
      res.status(err.status === 404 ? 404 : 502).json({ error: err.message });
    }
  });

  // Recomendaciones de EDHREC para un comandante.
  app.get(
    '/api/edhrec/:slug',
    route(async (req) => {
      const slug = String(req.params.slug).toLowerCase();
      if (!/^[a-z0-9-]+$/.test(slug)) throw new HttpError(400, 'Slug no válido');
      return cached(`edhrec|${slug}`, async () => simplifyEdhrec(await fetchJson(EDHREC_URL(slug))));
    }),
  );

  // Combos de Commander Spellbook presentes (o casi) en el mazo.
  app.post(
    '/api/combos',
    route(async (req) => {
      const { commanders = [], main = [] } = req.body || {};
      if (!Array.isArray(commanders) || !Array.isArray(main)) throw new HttpError(400, 'Formato no válido');
      const d = await fetchJson(SPELLBOOK_URL, { method: 'POST', body: spellbookBody(commanders, main), timeoutMs: 30000 });
      return simplifyCombos(d);
    }),
  );

  // Importar un mazo desde una URL (Archidekt, Moxfield, MTGGoldfish, TappedOut).
  app.get(
    '/api/import',
    route(async (req) => importDeckFromUrl(String(req.query.url || ''))),
  );

  // Traducción de cartas (IA + respaldos).
  app.post(
    '/api/translate',
    route(async (req) => {
      const { lang, cards } = req.body || {};
      if (!getLanguage(lang)) throw new HttpError(400, 'Idioma no soportado');
      if (!Array.isArray(cards) || cards.length === 0) throw new HttpError(400, 'No hay cartas que traducir');
      if (cards.length > 150) throw new HttpError(400, 'Máximo 150 cartas por petición');
      const clean = cards.map((c) => ({
        key: String(c.key || '').slice(0, 100),
        name: String(c.name || '').slice(0, 200),
        mana_cost: String(c.mana_cost || '').slice(0, 100),
        type_line: String(c.type_line || '').slice(0, 200),
        oracle_text: String(c.oracle_text || '').slice(0, 2000),
        flavor_text: String(c.flavor_text || '').slice(0, 1000),
      }));
      if (clean.some((c) => !c.key)) throw new HttpError(400, 'Cada carta necesita una clave');
      return { translations: await translator.translate(lang, clean) };
    }),
  );

  app.use(
    '/vendor/jspdf',
    express.static(path.join(root, 'node_modules/jspdf/dist'), { maxAge: '7d' }),
  );
  app.use(express.static(path.join(root, 'public'), { extensions: ['html'] }));

  return app;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const key = process.env.ANTHROPIC_API_KEY;
  const anthropic = key ? new Anthropic({ apiKey: key }) : null;
  const model = process.env.ANTHROPIC_MODEL || 'claude-opus-5-5';
  const app = createApp({
    anthropic,
    model,
    effort: process.env.ANTHROPIC_EFFORT || 'low',
    mymemoryEmail: process.env.MYMEMORY_EMAIL || '',
    cacheDir: path.join(root, 'data'),
    warmup: (process.env.MEMORY_WARMUP ?? 'es').split(',').map((l) => l.trim()).filter(Boolean),
  });
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => {
    console.log(`Magic the PDF escuchando en http://localhost:${port}`);
    console.log(
      anthropic
        ? `Traductor: Claude (${model}) + motor propio de respaldo.`
        : 'Traductor: motor propio (memoria de cartas oficiales + traducción automática gratuita).',
    );
  });
}
