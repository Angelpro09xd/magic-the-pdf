import fs from 'node:fs';
import path from 'node:path';

/**
 * Caché clave/valor en memoria con persistencia opcional en un fichero JSON.
 * Las entradas pueden caducar (ttlMs) y el guardado a disco se agrupa.
 */
export class Cache {
  constructor({ file = null, ttlMs = 0, maxEntries = 5000 } = {}) {
    this.file = file;
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.map = new Map();
    this.saveTimer = null;
    if (file) this.#load();
  }

  #load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const [k, v] of Object.entries(raw)) this.map.set(k, v);
    } catch {
      // Fichero inexistente o corrupto: empezamos vacíos.
    }
  }

  #scheduleSave() {
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.map)));
      } catch (err) {
        console.warn(`[cache] No se pudo guardar ${this.file}: ${err.message}`);
      }
    }, 1000);
    this.saveTimer.unref?.();
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (this.ttlMs && Date.now() - entry.t > this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    return entry.v;
  }

  set(key, value) {
    this.map.delete(key);
    this.map.set(key, { v: value, t: Date.now() });
    while (this.map.size > this.maxEntries) {
      this.map.delete(this.map.keys().next().value);
    }
    this.#scheduleSave();
  }

  delete(key) {
    this.map.delete(key);
    this.#scheduleSave();
  }
}
