/**
 * Fuentes de las cartas: una para nombres/tipos (como Beleren) y otra para el texto de reglas
 * (como MPlantin). Se puede elegir entre fuentes libres parecidas o subir las propias
 * (por ejemplo Beleren y MPlantin si las tienes): se guardan en el navegador.
 */
import { DEFAULT_FONTS, setCardFonts } from './render.js';
import { idbGet, idbSet } from './idb.js';

export const TITLE_FONTS = ['Vollkorn', 'Gentium Book Plus', 'Eczar', 'Alegreya Sans SC'];
export const RULES_FONTS = ['Crimson Text', 'Libre Caslon Text', 'Spectral', 'EB Garamond'];
export const CUSTOM_TITLE = 'MTP Título propio';
export const CUSTOM_RULES = 'MTP Reglas propia';

const KEY = 'mtp.fonts.v1';

function readChoice() {
  try {
    return { ...DEFAULT_FONTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return { ...DEFAULT_FONTS };
  }
}

let choice = readChoice();
const uploaded = { title: false, rules: false };

export const currentFonts = () => ({ ...choice, uploaded: { ...uploaded } });

async function register(kind, buffer) {
  const family = kind === 'title' ? CUSTOM_TITLE : CUSTOM_RULES;
  const face = new FontFace(family, buffer);
  await face.load();
  document.fonts.add(face);
  if (kind === 'rules') {
    // La misma fuente sirve también para la cursiva (el navegador la inclina).
    const italic = new FontFace(family, buffer, { style: 'italic' });
    await italic.load().catch(() => {});
    document.fonts.add(italic);
  }
  uploaded[kind] = true;
}

/** Carga las fuentes subidas anteriormente y aplica la elección guardada. */
export async function initFonts() {
  for (const kind of ['title', 'rules']) {
    const buffer = await idbGet(`font-${kind}`);
    if (buffer) await register(kind, buffer).catch(() => {});
  }
  if (choice.title === CUSTOM_TITLE && !uploaded.title) choice.title = DEFAULT_FONTS.title;
  if (choice.rules === CUSTOM_RULES && !uploaded.rules) choice.rules = DEFAULT_FONTS.rules;
  setCardFonts(choice);
}

export function chooseFonts(next) {
  choice = { ...choice, ...next };
  try {
    localStorage.setItem(KEY, JSON.stringify({ title: choice.title, rules: choice.rules }));
  } catch {
    // sin almacenamiento: solo para esta sesión
  }
  setCardFonts(choice);
}

/** Sube un fichero de fuente (TTF/OTF/WOFF) y la usa. */
export async function uploadFont(kind, file) {
  const buffer = await file.arrayBuffer();
  await register(kind, buffer);
  await idbSet(`font-${kind}`, buffer);
  chooseFonts(kind === 'title' ? { title: CUSTOM_TITLE } : { rules: CUSTOM_RULES });
}
