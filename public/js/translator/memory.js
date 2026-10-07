/**
 * Memoria de traducción de Magic aprendida de cartas oficiales.
 *
 * Scryfall da, para cada impresión no inglesa, el texto impreso (printed_text) y el
 * texto Oracle en inglés. Emparejando línea a línea y frase a frase aprendemos cómo
 * traduce Wizards cada plantilla ("Draw a card." → "Roba una carta."). Para que una
 * plantilla sirva a otras cartas, se generalizan los símbolos de maná, los números y
 * el nombre de la propia carta.
 */

const SENTENCE_SPLIT = /(?<=[.!?。！？])\s*(?=[^\s"”»」)）])/u;

/** Separa una línea en segmentos: texto normal y recordatorios entre paréntesis. */
export function splitReminder(line) {
  const parts = [];
  const re = /(\s*[(（][^()（）]*[)）])/gu;
  let last = 0;
  let m;
  while ((m = re.exec(line))) {
    if (m.index > last) parts.push({ text: line.slice(last, m.index), reminder: false });
    parts.push({ text: m[1], reminder: true });
    last = m.index + m[1].length;
  }
  if (last < line.length) parts.push({ text: line.slice(last), reminder: false });
  return parts.filter((p) => p.text.trim());
}

export function splitSentences(text) {
  return text.split(SENTENCE_SPLIT).filter((s) => s.trim());
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Generaliza un texto: nombre propio → ~, símbolos → ⟨n⟩, números → ⟦n⟧.
 * Devuelve la clave y los valores sustituidos (para restaurarlos después).
 */
export function mask(text, names = []) {
  let out = text.trim();
  for (const n of names.filter(Boolean).sort((a, b) => b.length - a.length)) {
    out = out.replace(new RegExp(escapeRe(n), 'g'), '~');
  }
  const symbols = [];
  const numbers = [];
  // Una sola pasada: los marcadores no deben volver a enmascararse.
  out = out.replace(/\{[^}]+\}|\d+/g, (s) =>
    s.startsWith('{') ? `⟨${symbols.push(s) - 1}⟩` : `⟦${numbers.push(s) - 1}⟧`,
  );
  return { key: out, symbols, numbers };
}

export function unmask(text, { symbols, numbers }, name = '~') {
  return text
    .replace(/⟨(\d+)⟩/g, (m, i) => symbols[Number(i)] ?? m)
    .replace(/⟦(\d+)⟧/g, (m, i) => numbers[Number(i)] ?? m)
    .replace(/~/g, name);
}

const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Subtipos y tipos frecuentes (traducción oficial) por si la memoria aún no los ha visto. */
const SEED = {
  es: {
    types: {
      Creature: 'Criatura', Instant: 'Instantáneo', Sorcery: 'Conjuro', Artifact: 'Artefacto', Enchantment: 'Encantamiento',
      Land: 'Tierra', Planeswalker: 'Planeswalker', Battle: 'Batalla', 'Legendary Creature': 'Criatura legendaria',
      'Artifact Creature': 'Criatura artefacto', 'Legendary Artifact': 'Artefacto legendario', 'Legendary Enchantment': 'Encantamiento legendario',
      'Enchantment Creature': 'Criatura encantamiento', 'Legendary Planeswalker': 'Planeswalker legendario', 'Legendary Land': 'Tierra legendaria',
      'Kindred Instant': 'Instantáneo tribal', 'Kindred Sorcery': 'Conjuro tribal', 'Legendary Artifact Creature': 'Criatura artefacto legendaria',
      'Legendary Enchantment Creature': 'Criatura encantamiento legendaria', 'Basic Land': 'Tierra básica', 'Legendary Sorcery': 'Conjuro legendario',
    },
    subtypes: {
      Goblin: 'Trasgo', Merfolk: 'Tritón', Faerie: 'Hada', Sliver: 'Fragmentado', Zombie: 'Zombie', Vampire: 'Vampiro', Shaman: 'Chamán',
      Warrior: 'Guerrero', Wizard: 'Hechicero', Rogue: 'Pícaro', Cleric: 'Clérigo', Soldier: 'Soldado', Knight: 'Caballero', Druid: 'Druida',
      Elf: 'Elfo', Human: 'Humano', Dragon: 'Dragón', Angel: 'Ángel', Demon: 'Demonio', Beast: 'Bestia', Spirit: 'Espíritu',
      Elemental: 'Elemental', Equipment: 'Equipo', Aura: 'Aura', Saga: 'Saga', Treefolk: 'Silvano', Dinosaur: 'Dinosaurio', Pirate: 'Pirata',
      Artificer: 'Artífice', Advisor: 'Consejero', Assassin: 'Asesino', Ally: 'Aliado', Construct: 'Constructo', Horror: 'Horror', Ogre: 'Ogro',
      Giant: 'Gigante', Dwarf: 'Enano', Cat: 'Felino', Bird: 'Ave', Insect: 'Insecto', Snake: 'Serpiente', Wolf: 'Lobo', Werewolf: 'Hombre lobo',
      Eldrazi: 'Eldrazi', Phyrexian: 'Pirexiano', Noble: 'Noble', Monk: 'Monje', Berserker: 'Berserker', Scout: 'Explorador', Warlock: 'Brujo',
      Barbarian: 'Bárbaro', Ninja: 'Ninja', Samurai: 'Samurái', Food: 'Comida', Treasure: 'Tesoro', Clue: 'Pista', Vehicle: 'Vehículo',
      Shapeshifter: 'Cambiaformas', Mutant: 'Mutante', Hydra: 'Hidra', Wurm: 'Sierpe', Sphinx: 'Esfinge', Golem: 'Gólem', Thopter: 'Tóptero',
      Servo: 'Servo', Myr: 'Myr', Rat: 'Rata', Squirrel: 'Ardilla', Fungus: 'Hongo', Saproling: 'Saprolín', Plant: 'Planta', Ooze: 'Cieno',
      Kraken: 'Kraken', Octopus: 'Pulpo', Serpent: 'Serpiente marina', Leviathan: 'Leviatán', Minotaur: 'Minotauro', Centaur: 'Centauro',
      Kor: 'Kor', Vedalken: 'Vedalken', Viashino: 'Viashino', Orc: 'Orco', Halfling: 'Mediano', Peasant: 'Campesino', Citizen: 'Ciudadano',
      Detective: 'Detective', Mercenary: 'Mercenario', Archer: 'Arquero', Horse: 'Caballo', Dog: 'Perro', Elk: 'Alce', Bear: 'Oso',
      Spider: 'Araña', Skeleton: 'Esqueleto', Specter: 'Espectro', Shade: 'Sombra', Imp: 'Diablillo', Devil: 'Diablo', Gargoyle: 'Gárgola',
      Gorgon: 'Gorgona', Nightmare: 'Pesadilla', Avatar: 'Avatar', God: 'Dios', Incarnation: 'Encarnación', Illusion: 'Ilusión',
      Gnome: 'Gnomo', Kithkin: 'Kithkin', Changeling: 'Cambiante', Elder: 'Antiguo', Rebel: 'Rebelde', Pilot: 'Piloto', Bard: 'Bardo',
      Forest: 'Bosque', Island: 'Isla', Swamp: 'Pantano', Mountain: 'Montaña', Plains: 'Llanura', Cave: 'Cueva', Desert: 'Desierto',
      Gate: 'Portal', Town: 'Pueblo', Lesson: 'Lección', Adventure: 'Aventura', Arcane: 'Arcano', Trap: 'Trampa', Shrine: 'Santuario',
      Curse: 'Maldición', Class: 'Clase', Case: 'Caso', Room: 'Habitación', Background: 'Trasfondo', Role: 'Rol', Cartouche: 'Cartucho',
    },
  },
};

export class TranslationMemory {
  constructor(lang) {
    this.lang = lang;
    this.entries = new Map(); // clave inglesa generalizada → Map(traducción generalizada → veces vista)
    this.types = new Map(); // "Legendary Creature" → "Criatura legendaria"
    this.subtypes = new Map(); // "Elf" → "Elfo"
    this.subtypeSep = ' ';
    this.cards = 0;
  }

  #learn(en, tr) {
    if (!en.key || !tr.key || en.key.length > 400) return;
    // Solo aceptamos el par si los símbolos y números coinciden en orden.
    if (!sameList(en.symbols, tr.symbols) || !sameList(en.numbers, tr.numbers)) return;
    let candidates = this.entries.get(en.key);
    if (!candidates) this.entries.set(en.key, (candidates = new Map()));
    candidates.set(tr.key, (candidates.get(tr.key) || 0) + 1);
  }

  /** La traducción más repetida para una clave. */
  #best(key) {
    const candidates = this.entries.get(key);
    if (!candidates) return null;
    let best = null;
    let n = 0;
    for (const [t, c] of candidates) if (c > n) [best, n] = [t, c];
    return best;
  }

  #learnPair(enText, trText, enNames, trNames) {
    this.#learn(mask(enText, enNames), mask(trText, trNames));
    // Frases y recordatorios por separado, si la estructura coincide.
    const enParts = splitReminder(enText);
    const trParts = splitReminder(trText);
    if (enParts.length !== trParts.length || enParts.some((p, i) => p.reminder !== trParts[i].reminder)) return;
    enParts.forEach((p, i) => {
      if (enParts.length > 1) this.#learn(mask(p.text, enNames), mask(trParts[i].text, trNames));
      const es = splitSentences(p.text);
      const ts = splitSentences(trParts[i].text);
      if (es.length > 1 && es.length === ts.length) {
        es.forEach((s, j) => this.#learn(mask(s, enNames), mask(ts[j], trNames)));
      }
    });
  }

  #learnType(en, tr) {
    if (!en || !tr || en.includes(' // ')) return;
    const [enMain, enSub] = en.split(' — ');
    const [trMain, trSub] = tr.split(/\s*[—–―－]\s*/u);
    if (!enMain || !trMain || (enSub === undefined) !== (trSub === undefined)) return;
    this.#count(this.types, enMain, trMain.trim());
    // El orden de los subtipos cambia entre idiomas: solo aprendemos de líneas con un subtipo.
    if (enSub && !enSub.trim().includes(' ') && trSub) {
      const sep = /・/.test(trSub) ? '・' : ' ';
      if (sep === '・') this.subtypeSep = sep;
      if (trSub.split(sep === '・' ? '・' : /\s+/).length <= 2) this.#count(this.subtypes, enSub.trim(), trSub.trim());
    }
  }

  #count(map, key, value) {
    let c = map.get(key);
    if (!c) map.set(key, (c = new Map()));
    c.set(value, (c.get(value) || 0) + 1);
  }

  #pick(map, key) {
    const c = map.get(key);
    if (!c) return undefined;
    let best;
    let n = 0;
    for (const [v, k] of c) if (k > n) [best, n] = [v, k];
    return best;
  }

  /** Aprende de una carta de Scryfall en este idioma (con printed_text). */
  addCard(card) {
    const faces = card.card_faces?.length ? card.card_faces : [card];
    let learned = false;
    for (const f of faces) {
      const en = f.oracle_text;
      const tr = f.printed_text;
      this.#learnType(f.type_line, f.printed_type_line);
      if (!en || !tr) continue;
      const enNames = [f.name, f.name?.split(',')[0]];
      const trNames = [f.printed_name, f.printed_name?.split(/[,，、]/)[0]];
      const enLines = en.split('\n');
      const trLines = tr.split('\n');
      if (enLines.length !== trLines.length) continue;
      enLines.forEach((l, i) => this.#learnPair(l, trLines[i], enNames, trNames));
      learned = true;
    }
    if (learned) this.cards++;
  }

  lookup(text, names, translatedName) {
    const m = mask(text, names);
    const hit = this.#best(m.key);
    return hit ? unmask(hit, m, translatedName) : null;
  }

  /**
   * Traduce una línea con la memoria. Devuelve { text, pending } donde pending son los
   * fragmentos que no se encontraron (marcados como ⟪i⟫ en text).
   */
  translateLine(line, names, translatedName) {
    const pending = [];
    const whole = this.lookup(line, names, translatedName);
    if (whole) return { text: whole, pending };
    const out = [];
    for (const part of splitReminder(line)) {
      const lead = part.text.match(/^\s*/)[0];
      const hit = this.lookup(part.text, names, translatedName);
      if (hit) {
        out.push(lead + hit);
        continue;
      }
      // Frase a frase
      const sentences = splitSentences(part.text.trim());
      const done = sentences.map((s) => this.lookup(s, names, translatedName) ?? this.#keywordList(s, names, translatedName));
      if (sentences.length > 0 && done.every(Boolean)) {
        out.push(lead + done.join(' '));
        continue;
      }
      out.push(
        lead +
          sentences
            .map((s, i) => done[i] ?? `⟪${pending.push(s) - 1}⟫`)
            .join(' '),
      );
    }
    return { text: out.join(''), pending };
  }

  /** "Flying, haste" → cada palabra clave por separado. */
  #keywordList(text, names, translatedName) {
    if (!/^[^.:]+$/.test(text) || !text.includes(',')) return null;
    const parts = text.split(/,\s*/);
    const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
    const tr = parts.map((p) => this.lookup(cap(p.trim()), names, translatedName)?.replace(/[.。]$/, ''));
    if (!tr.every(Boolean)) return null;
    const end = /[.。]$/.test(this.lookup('Flying', [], '') || '.') ? '.' : '';
    const keepCase = ['de', 'ja', 'ko', 'zhs', 'zht', 'ru'].includes(this.lang);
    const joiner = ['ja', 'zhs', 'zht'].includes(this.lang) ? '、' : ', ';
    return tr.map((t, i) => (i === 0 || keepCase ? t : t.charAt(0).toLowerCase() + t.slice(1))).join(joiner) + end;
  }

  /** Traduce la línea de tipo. Devuelve { text, pending } igual que translateLine. */
  translateType(typeLine) {
    const pending = [];
    const [main, sub] = typeLine.split(' — ');
    let mainTr = this.#pick(this.types, main) ?? SEED[this.lang]?.types[main];
    if (!mainTr) {
      // Tipos con supertipo: prueba quitando palabras de la izquierda ("Legendary Snow Creature")
      mainTr = `⟪${pending.push(main) - 1}⟫`;
    }
    if (!sub) return { text: mainTr, pending };
    const words = sub.trim().split(/\s+/).map((w) => this.#pick(this.subtypes, w) ?? SEED[this.lang]?.subtypes[w] ?? `⟪${pending.push(w) - 1}⟫`);
    // En español y portugués solo va en mayúscula el primer subtipo (en italiano, todos).
    const lowerRest = ['es', 'pt'].includes(this.lang);
    const subs = words.map((w, i) => (lowerRest && i > 0 && !w.startsWith('⟪') ? w.toLowerCase() : w));
    return { text: `${mainTr} — ${subs.join(this.subtypeSep)}`, pending };
  }

  toJSON() {
    return {
      lang: this.lang,
      cards: this.cards,
      subtypeSep: this.subtypeSep,
      entries: [...this.entries].map(([k, v]) => [k, [...v]]),
      types: [...this.types].map(([k, v]) => [k, [...v]]),
      subtypes: [...this.subtypes].map(([k, v]) => [k, [...v]]),
    };
  }

  static fromJSON(data) {
    const m = new TranslationMemory(data.lang);
    m.cards = data.cards;
    m.subtypeSep = data.subtypeSep || ' ';
    for (const [k, v] of data.entries) m.entries.set(k, new Map(v));
    m.types = new Map(data.types.map(([k, v]) => [k, new Map(v)]));
    m.subtypes = new Map(data.subtypes.map(([k, v]) => [k, new Map(v)]));
    return m;
  }

  get size() {
    return this.entries.size;
  }
}
