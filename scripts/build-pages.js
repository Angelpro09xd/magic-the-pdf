/**
 * Genera la versión estática para GitHub Pages en dist/:
 *  - copia public/ y jsPDF,
 *  - precalcula las memorias de traducción de cada idioma (dist/memory/<idioma>.json)
 *    para que el traductor funcione en el navegador sin esperar.
 *
 * Uso: node scripts/build-pages.js [--out dist] [--no-memories] [--langs es,fr] [--memory-dir .memory-cache]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LANGUAGES } from '../public/js/languages.js';
import { createMemoryStore } from '../server/lib/memoryStore.js';
import { createThrottle } from '../server/lib/http.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const dist = path.resolve(root, opt('--out', 'dist'));

fs.rmSync(dist, { recursive: true, force: true });
fs.cpSync(path.join(root, 'public'), dist, { recursive: true });
fs.mkdirSync(path.join(dist, 'vendor/jspdf'), { recursive: true });
fs.copyFileSync(path.join(root, 'node_modules/jspdf/dist/jspdf.umd.min.js'), path.join(dist, 'vendor/jspdf/jspdf.umd.min.js'));
fs.writeFileSync(path.join(dist, '.nojekyll'), '');
// Marca de versión estática: la app no intentará hablar con un servidor (sin errores 404 en la consola).
const indexFile = path.join(dist, 'index.html');
fs.writeFileSync(indexFile, fs.readFileSync(indexFile, 'utf8').replace('<meta charset="utf-8">', '<meta charset="utf-8">\n  <meta name="mtp-static" content="1">'));
console.log(`Web estática copiada en ${path.relative(root, dist)}/`);

if (!args.includes('--no-memories')) {
  const langs = (opt('--langs', '') || LANGUAGES.map((l) => l.code).join(','))
    .split(',')
    .map((l) => l.trim())
    .filter((l) => l && l !== 'en');
  // Las memorias se reutilizan entre ejecuciones si tienen menos de una semana.
  const memoryDir = path.resolve(root, opt('--memory-dir', 'data'));
  const store = createMemoryStore({ dir: memoryDir, scryfall: createThrottle(150), maxAge: 7 * 24 * 60 * 60 * 1000 });
  fs.mkdirSync(path.join(dist, 'memory'), { recursive: true });
  for (const lang of langs) {
    try {
      const mem = await store.get(lang);
      const file = path.join(memoryDir, `memory-${lang}.json`);
      const data = fs.existsSync(file)
        ? fs.readFileSync(file, 'utf8')
        : JSON.stringify({ builtAt: Date.now(), memory: mem.toJSON() });
      fs.writeFileSync(path.join(dist, 'memory', `${lang}.json`), data);
      console.log(`memory/${lang}.json: ${mem.cards} cartas, ${mem.size} plantillas`);
    } catch (err) {
      console.warn(`No se pudo preparar la memoria de ${lang}: ${err.message}`);
    }
  }
}
