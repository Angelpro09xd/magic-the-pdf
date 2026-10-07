/** Persistencia local (localStorage) de mazos y ajustes. Todo va envuelto en try/catch. */
const KEY_DECKS = 'mtp.decks.v1';
const KEY_CURRENT = 'mtp.current';
const KEY_SETTINGS = 'mtp.settings.v1';

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (err) {
    console.warn('No se pudo guardar en localStorage', err);
    return false;
  }
}

export const loadDecks = () => read(KEY_DECKS, []);
export const saveDecks = (decks) => write(KEY_DECKS, decks);
export const loadCurrentId = () => read(KEY_CURRENT, null);
export const saveCurrentId = (id) => write(KEY_CURRENT, id);
export const loadSettings = () => read(KEY_SETTINGS, {});
export const saveSettings = (s) => write(KEY_SETTINGS, s);

export function newDeck(name = 'Nuevo mazo', lang = 'es') {
  return {
    id: crypto.randomUUID(),
    name,
    lang,
    commanders: [],
    cards: [],
    notes: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

export function newEntry(card, qty = 1) {
  return { uid: crypto.randomUUID(), qty, card };
}
