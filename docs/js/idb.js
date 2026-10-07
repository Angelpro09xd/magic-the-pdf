/** Almacén clave/valor mínimo sobre IndexedDB (para memorias y traducciones en el navegador). */
const DB_NAME = 'magic-the-pdf';
const STORE = 'kv';
let dbPromise = null;

function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function run(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function idbGet(key) {
  try {
    return await run('readonly', (s) => s.get(key));
  } catch {
    return undefined;
  }
}

export async function idbSet(key, value) {
  try {
    await run('readwrite', (s) => s.put(value, key));
    return true;
  } catch {
    return false;
  }
}
