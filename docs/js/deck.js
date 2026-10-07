/**
 * Lógica pura del mazo (sin DOM): parseo/exportación de listas, reducción de cartas
 * de Scryfall, validación de Commander y estadísticas. Se prueba con node:test.
 */

export const BASIC_LANDS = new Set([
  'Plains', 'Island', 'Swamp', 'Mountain', 'Forest', 'Wastes',
  'Snow-Covered Plains', 'Snow-Covered Island', 'Snow-Covered Swamp',
  'Snow-Covered Mountain', 'Snow-Covered Forest', 'Snow-Covered Wastes',
]);

const SECTION_ALIASES = {
  commander: 'commander', commanders: 'commander', comandante: 'commander', comandantes: 'commander',
  deck: 'main', main: 'main', mainboard: 'main', maindeck: 'main', mazo: 'main', companion: 'main',
  sideboard: 'skip', maybeboard: 'skip', considering: 'skip', tokens: 'skip', about: 'about',
};

/**
 * Parsea una lista en texto (MTGO, Arena, Moxfield, Archidekt, TappedOut...).
 * Devuelve { name, commanders: [{qty,name,set,cn}], cards: [...], errors: [string] }.
 */
export function parseDeckText(text) {
  const result = { name: null, commanders: [], cards: [], errors: [] };
  let section = 'main';
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line) continue;

    const header = line.replace(/^\/\/\s*/, '').replace(/[:\s]+$/, '').toLowerCase();
    if (SECTION_ALIASES[header]) {
      section = SECTION_ALIASES[header];
      continue;
    }
    if (section === 'about') {
      const m = line.match(/^name\s+(.+)$/i);
      if (m) result.name = m[1].trim();
      continue;
    }
    if (line.startsWith('#') || line.startsWith('//')) continue;

    let target = section;
    if (/^SB:\s*/i.test(line)) {
      line = line.replace(/^SB:\s*/i, '');
      target = 'skip';
    }
    if (target === 'skip') continue;

    if (/\*CMDR\*/i.test(line)) {
      target = 'commander';
      line = line.replace(/\*CMDR\*/gi, '').trim();
    }

    const m = line.match(/^(?:(\d+)\s*x?\s+)?(.+?)\s*$/i);
    if (!m) {
      result.errors.push(rawLine);
      continue;
    }
    const qty = m[1] ? parseInt(m[1], 10) : 1;
    let rest = m[2]
      .replace(/\s+\*[A-Z]+\*/g, '') // *F*, *E* (foil/etched)
      .replace(/\s+#.*$/, '') // etiquetas de Moxfield
      .replace(/\s+\^.*$/, '') // etiquetas de Archidekt
      .trim();

    let set = null;
    let cn = null;
    const setMatch = rest.match(/^(.*?)\s+[([]([A-Za-z0-9]{2,6})[)\]](?:\s+([A-Za-z0-9★-]+))?$/);
    if (setMatch) {
      rest = setMatch[1].trim();
      set = setMatch[2].toLowerCase();
      cn = setMatch[3] || null;
    }
    const name = rest.replace(/\s+\/\s+/g, ' // ');
    if (!name || qty <= 0) {
      result.errors.push(rawLine);
      continue;
    }
    (target === 'commander' ? result.commanders : result.cards).push({ qty, name, set, cn });
  }
  return result;
}

/** Exporta el mazo como texto. format: 'mtgo' (por defecto), 'arena' o 'plain'. */
export function exportDeckText(deck, format = 'mtgo') {
  const fmt = (e) => {
    const c = e.card;
    if (format === 'plain' || !c?.set) return `${e.qty} ${c?.name ?? e.name}`;
    return `${e.qty} ${c.name} (${c.set.toUpperCase()}) ${c.collector_number}`;
  };
  const lines = [];
  if (format === 'arena') lines.push('About', `Name ${deck.name}`, '');
  if (deck.commanders.length) {
    lines.push('Commander', ...deck.commanders.map(fmt), '');
  }
  lines.push('Deck', ...sortEntries(deck.cards).map(fmt));
  return lines.join('\n');
}

export function exportDeckCsv(deck) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['Cantidad', 'Nombre', 'Edición', 'Número', 'Tipo', 'CMC', 'Comandante', 'USD', 'EUR']];
  for (const [isCmd, list] of [[true, deck.commanders], [false, deck.cards]]) {
    for (const e of list) {
      const c = e.card || {};
      rows.push([e.qty, c.name, c.set, c.collector_number, c.type_line, c.cmc, isCmd ? 'sí' : '', c.prices?.usd, c.prices?.eur]);
    }
  }
  return rows.map((r) => r.map(esc).join(',')).join('\n');
}

export function sortEntries(entries) {
  return [...entries].sort((a, b) => (a.card?.name || '').localeCompare(b.card?.name || ''));
}

const pickImages = (uris) =>
  uris ? { normal: uris.normal, large: uris.large, png: uris.png, art_crop: uris.art_crop, small: uris.small } : null;

/** Reduce un objeto carta de Scryfall a lo que necesita la app (para guardarlo en localStorage). */
export function slimCard(c) {
  if (!c) return null;
  const faces = (c.card_faces || []).map((f) => ({
    name: f.name,
    printed_name: f.printed_name || null,
    mana_cost: f.mana_cost || '',
    type_line: f.type_line || '',
    printed_type_line: f.printed_type_line || null,
    oracle_text: f.oracle_text || '',
    printed_text: f.printed_text || null,
    power: f.power ?? null,
    toughness: f.toughness ?? null,
    loyalty: f.loyalty ?? null,
    defense: f.defense ?? null,
    colors: f.colors || null,
    flavor_text: f.flavor_text || '',
    artist: f.artist || null,
    illustration_id: f.illustration_id || null,
    image: pickImages(f.image_uris),
  }));
  const tokens = (c.all_parts || [])
    .filter((p) => p.component === 'token' || (p.component === 'combo_piece' && /Emblem|Token/.test(p.type_line || '')))
    .filter((p) => p.id !== c.id)
    .map((p) => ({ id: p.id, name: p.name }));
  return {
    id: c.id,
    oracle_id: c.oracle_id || c.card_faces?.[0]?.oracle_id || null,
    name: c.name,
    lang: c.lang || 'en',
    printed_name: c.printed_name || null,
    mana_cost: c.mana_cost ?? faces[0]?.mana_cost ?? '',
    cmc: c.cmc ?? 0,
    type_line: c.type_line || faces.map((f) => f.type_line).join(' // '),
    printed_type_line: c.printed_type_line || null,
    oracle_text: c.oracle_text ?? '',
    printed_text: c.printed_text || null,
    colors: c.colors || faces[0]?.colors || [],
    color_identity: c.color_identity || [],
    keywords: c.keywords || [],
    produced_mana: c.produced_mana || [],
    power: c.power ?? null,
    toughness: c.toughness ?? null,
    loyalty: c.loyalty ?? null,
    defense: c.defense ?? null,
    layout: c.layout,
    set: c.set,
    set_name: c.set_name,
    collector_number: c.collector_number,
    rarity: c.rarity,
    released_at: c.released_at,
    frame: c.frame,
    frame_effects: c.frame_effects || [],
    full_art: Boolean(c.full_art),
    border_color: c.border_color,
    flavor_text: c.flavor_text || '',
    artist: c.artist || null,
    illustration_id: c.illustration_id || c.card_faces?.[0]?.illustration_id || null,
    promo: Boolean(c.promo),
    image_status: c.image_status || null,
    legal: c.legalities?.commander || 'legal',
    game_changer: Boolean(c.game_changer),
    prices: { usd: c.prices?.usd ?? null, eur: c.prices?.eur ?? null },
    image: pickImages(c.image_uris),
    faces,
    tokens,
    edhrec_rank: c.edhrec_rank ?? null,
    scryfall_uri: c.scryfall_uri,
    purchase: { cardmarket: c.purchase_uris?.cardmarket ?? null, tcgplayer: c.purchase_uris?.tcgplayer ?? null },
    related: { edhrec: c.related_uris?.edhrec ?? null },
  };
}

/** Caras imprimibles de una carta (las DFC tienen dos imágenes; las split/aventura, una). */
export function printableFaces(card) {
  if (!card) return [];
  if (card.faces?.length && card.faces[0].image) return card.faces;
  return [{ ...card, image: card.image }];
}

/** Caras con texto (para traducir): todas las caras, aunque compartan imagen. */
export function textFaces(card) {
  if (!card) return [];
  if (card.faces?.length) return card.faces;
  return [card];
}

export function isBasicLand(card) {
  return BASIC_LANDS.has(card?.name) || /^Basic (Snow )?Land/.test(card?.type_line || '');
}

export function allowsAnyNumber(card) {
  return /A deck can have any number of cards named/i.test(card?.oracle_text || '');
}

export function maxCopiesAllowed(card) {
  if (isBasicLand(card) || allowsAnyNumber(card)) return Infinity;
  const m = (card?.oracle_text || '').match(/A deck can have up to (\w+) cards named/i);
  if (m) {
    const words = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
    return words[m[1].toLowerCase()] || parseInt(m[1], 10) || 1;
  }
  return 1;
}

const frontType = (card) => (card?.type_line || '').split(' // ')[0];

export function canBeCommander(card) {
  if (!card) return false;
  const type = frontType(card);
  if (/Legendary/.test(type) && /Creature/.test(type)) return true;
  return /can be your commander/i.test(allText(card));
}

function allText(card) {
  return textFaces(card).map((f) => f.oracle_text || '').join('\n');
}

/** ¿Pueden estas dos cartas ser comandantes juntas? */
export function validPair(a, b) {
  const ta = allText(a);
  const tb = allText(b);
  const plain = (t) => /(^|\n)Partner(\s*\(|$|\n)/.test(t);
  if (plain(ta) && plain(tb)) return true;
  const partnerWith = (t, other) => new RegExp(`Partner with ${escapeRegex(other.name.split(' // ')[0])}`).test(t);
  if (partnerWith(ta, b) && partnerWith(tb, a)) return true;
  if (/Friends forever/.test(ta) && /Friends forever/.test(tb)) return true;
  const bg = (t) => /Choose a Background/.test(t);
  const isBg = (c) => /Background/.test(frontType(c));
  if ((bg(ta) && isBg(b)) || (bg(tb) && isBg(a))) return true;
  const doc = (c) => /Time Lord Doctor/.test(frontType(c));
  if ((/Doctor's companion/.test(ta) && doc(b)) || (/Doctor's companion/.test(tb) && doc(a))) return true;
  const kindred = (t) => t.match(/Partner—([\w\s]+?)(\s*\(|$|\n)/)?.[1];
  if (kindred(ta) && kindred(ta) === kindred(tb)) return true;
  return false;
}

export function wantsPartner(card) {
  const t = allText(card);
  return /(^|\n)Partner|Friends forever|Choose a Background|Doctor's companion/.test(t) || /Time Lord Doctor/.test(frontType(card));
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function deckIdentity(deck) {
  const set = new Set();
  for (const e of deck.commanders) for (const c of e.card?.color_identity || []) set.add(c);
  return ['W', 'U', 'B', 'R', 'G'].filter((c) => set.has(c));
}

export function countCards(deck) {
  return [...deck.commanders, ...deck.cards].reduce((n, e) => n + e.qty, 0);
}

/**
 * Valida un mazo de Commander. Devuelve [{ level: 'error'|'warn'|'info', code, params }].
 * Los textos los pone la interfaz (i18n).
 */
export function validateDeck(deck) {
  const issues = [];
  const cmds = deck.commanders.map((e) => e.card).filter(Boolean);
  if (cmds.length === 0) issues.push({ level: 'error', code: 'noCommander' });
  if (cmds.length > 2) issues.push({ level: 'error', code: 'tooManyCommanders' });
  const pairOk = cmds.length === 2 && validPair(cmds[0], cmds[1]);
  for (const c of cmds) {
    const pairedBackground = pairOk && /Background/.test(frontType(c));
    if (!canBeCommander(c) && !pairedBackground) issues.push({ level: 'error', code: 'invalidCommander', params: { name: c.name } });
  }
  if (cmds.length === 2 && !pairOk) {
    issues.push({ level: 'error', code: 'invalidPair', params: { a: cmds[0].name, b: cmds[1].name } });
  }

  const total = countCards(deck);
  if (total !== 100) issues.push({ level: total > 100 ? 'error' : 'warn', code: 'count', params: { total } });

  const identity = new Set(deckIdentity(deck));
  const byName = new Map();
  for (const e of [...deck.commanders, ...deck.cards]) {
    const c = e.card;
    if (!c) continue;
    byName.set(c.name, (byName.get(c.name) || 0) + e.qty);
    if (cmds.length && c.color_identity.some((col) => !identity.has(col))) {
      issues.push({ level: 'error', code: 'identity', params: { name: c.name } });
    }
    if (c.legal === 'banned') issues.push({ level: 'error', code: 'banned', params: { name: c.name } });
    else if (c.legal === 'not_legal') issues.push({ level: 'warn', code: 'notLegal', params: { name: c.name } });
  }
  for (const [name, n] of byName) {
    const card = [...deck.commanders, ...deck.cards].find((e) => e.card?.name === name).card;
    if (n > maxCopiesAllowed(card)) issues.push({ level: 'error', code: 'singleton', params: { name, n } });
  }

  const gc = [...deck.commanders, ...deck.cards].filter((e) => e.card?.game_changer).length;
  if (gc > 3) issues.push({ level: 'warn', code: 'gameChangers', params: { n: gc } });

  const lands = deck.cards.filter((e) => /Land/.test(frontType(e.card))).reduce((n, e) => n + e.qty, 0);
  if (deck.cards.length > 0 && lands < 32) issues.push({ level: 'warn', code: 'fewLands', params: { n: lands } });
  if (lands > 42) issues.push({ level: 'warn', code: 'manyLands', params: { n: lands } });
  return issues;
}

const ROLE_PATTERNS = {
  ramp: [/Add \{/, /search your library for (?:a|up to \w+) (?:basic )?(?:land|Forest|Plains|Island|Swamp|Mountain)/i, /put (?:a|up to \w+) land cards? from your hand onto the battlefield/i],
  draw: [/draws? (?:a|two|three|four|X|\w+) cards?/i, /draw cards equal/i, /look at the top .* put .* into your hand/i, /exile the top .* You may play/i],
  removal: [/(?:destroy|exile) target (?:creature|artifact|enchantment|planeswalker|permanent|nonland)/i, /deals? \w+ damage to (?:target|any target)/i, /target (?:creature|player) .*sacrifices?/i, /return target (?:creature|nonland permanent) to its owner's hand/i],
  wipe: [/(?:destroy|exile) all (?:creatures|nonland permanents|artifacts|enchantments|other creatures)/i, /each (?:creature|player) .*sacrifices?/i, /all creatures get -\w+\/-\w+/i, /deals? \w+ damage to each creature/i],
  tutor: [/search your library for (?:a|an) (?!(?:basic )?(?:land|Forest|Plains|Island|Swamp|Mountain))/i],
  counter: [/counter target/i],
  protection: [/(?:hexproof|indestructible|protection from|phase out)/i],
};

export function cardRoles(card) {
  const text = allText(card);
  const type = frontType(card);
  const roles = [];
  for (const [role, patterns] of Object.entries(ROLE_PATTERNS)) {
    if (role === 'ramp' && /Land/.test(type)) continue;
    if (patterns.some((p) => p.test(text))) roles.push(role);
  }
  return roles;
}

export const CARD_TYPES = ['Creature', 'Planeswalker', 'Battle', 'Instant', 'Sorcery', 'Artifact', 'Enchantment', 'Land'];

// Tipos en otros idiomas (para cartas personalizadas escritas, por ejemplo, en español).
const TYPE_ALIASES = {
  Creature: /Criatura|Créature|Kreatur|Creatura/i,
  Planeswalker: /Planeswalker/i,
  Battle: /Batalla|Bataille|Schlacht|Battaglia/i,
  Instant: /Instantáneo|Éphémère|Spontanzauber|Istantaneo|Mágica Instantânea/i,
  Sorcery: /Conjuro|Rituel|Hexerei|Stregoneria|Feitiço/i,
  Artifact: /Artefacto|Artefact|Artefakt|Artefatto|Artefato/i,
  Enchantment: /Encantamiento|Enchantement|Verzauberung|Incantesimo|Encantamento/i,
  Land: /Tierra|Terrain|Land|Terra/i,
};

export function mainType(card) {
  const type = frontType(card);
  return (
    CARD_TYPES.find((t) => type.includes(t)) ||
    (card?.custom && CARD_TYPES.find((t) => TYPE_ALIASES[t].test(type))) ||
    'Other'
  );
}

export function deckStats(deck) {
  const all = [...deck.commanders, ...deck.cards].filter((e) => e.card);
  const curve = Array(8).fill(0);
  const pips = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
  const sources = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
  const types = {};
  const roles = { ramp: 0, draw: 0, removal: 0, wipe: 0, tutor: 0, counter: 0, protection: 0 };
  let cmcSum = 0;
  let nonLand = 0;
  let usd = 0;
  let eur = 0;
  for (const e of all) {
    const c = e.card;
    const t = mainType(c);
    types[t] = (types[t] || 0) + e.qty;
    if (t !== 'Land') {
      curve[Math.min(7, Math.floor(c.cmc))] += e.qty;
      cmcSum += c.cmc * e.qty;
      nonLand += e.qty;
    }
    const cost = c.mana_cost || textFaces(c).map((f) => f.mana_cost).join('');
    for (const m of cost.matchAll(/\{([^}]+)\}/g)) {
      for (const col of m[1].split('/')) if (col in pips) pips[col] += e.qty;
    }
    for (const col of c.produced_mana || []) if (col in sources) sources[col] += e.qty;
    for (const r of cardRoles(c)) roles[r] += e.qty;
    usd += (parseFloat(c.prices?.usd) || 0) * e.qty;
    eur += (parseFloat(c.prices?.eur) || 0) * e.qty;
  }
  return {
    curve,
    pips,
    sources,
    types,
    roles,
    avgCmc: nonLand ? cmcSum / nonLand : 0,
    usd,
    eur,
    gameChangers: all.filter((e) => e.card.game_changer).map((e) => e.card.name),
    total: countCards(deck),
  };
}

/** Estimación del bracket de Commander (1-5) según Game Changers y combos. */
export function estimateBracket(stats, twoCardCombos = 0) {
  const gc = stats.gameChangers.length;
  if (gc > 3 || twoCardCombos > 0) return 4;
  if (gc > 0) return 3;
  return 2;
}

/** Slug de EDHREC a partir del nombre (o nombres) del comandante. */
export function edhrecSlug(names) {
  const slug = (n) =>
    n
      .split(' // ')[0]
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/['",.!?:]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  return [...names].map(slug).sort().join('-');
}

/** Codifica/decodifica un mazo en una cadena compacta para compartir por URL. */
export function encodeShare(deck) {
  const data = {
    n: deck.name,
    l: deck.lang,
    c: deck.commanders.map((e) => [e.card.id, e.qty]),
    d: deck.cards.map((e) => [e.card.id, e.qty]),
  };
  const json = JSON.stringify(data);
  const bytes = new TextEncoder().encode(json);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeShare(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  const data = JSON.parse(new TextDecoder().decode(bytes));
  return { name: data.n, lang: data.l, commanders: data.c, cards: data.d };
}

/** Baraja (Fisher–Yates) con generador inyectable para tests. */
export function shuffle(list, random = Math.random) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Valor de maná de un coste ("{2}{G}{G}" → 4; X = 0; {2/W} = 2). */
export function manaValue(cost) {
  let total = 0;
  for (const [, sym] of String(cost || '').matchAll(/\{([^}]+)\}/g)) {
    if (/^\d+$/.test(sym)) total += Number(sym);
    else if (/^[XYZ]$/.test(sym)) continue;
    else if (/^2\//.test(sym)) total += 2;
    else total += 1;
  }
  return total;
}

/** Colores que aparecen en un texto con símbolos de maná. */
export function manaColors(text) {
  const symbols = String(text || '').match(/\{[^}]+\}/g) || [];
  return ['W', 'U', 'B', 'R', 'G'].filter((c) => symbols.some((s) => s.includes(c)));
}

/** Carta personalizada (sin equivalente en Scryfall). */
export function customCard(face, lang = 'en') {
  const id = `custom-${crypto.randomUUID()}`;
  return applyCustomFace(
    {
      id,
      oracle_id: id,
      custom: true,
      lang,
      keywords: [],
      produced_mana: [],
      layout: 'normal',
      set: 'custom',
      set_name: 'Personalizada',
      collector_number: '1',
      rarity: 'special',
      legal: 'legal',
      game_changer: false,
      prices: { usd: null, eur: null },
      image: null,
      faces: [],
      tokens: [],
      purchase: {},
      related: {},
    },
    face,
  );
}

/** Copia los datos editados de la cara principal a la carta (para validación y estadísticas). */
export function applyCustomFace(card, face) {
  return Object.assign(card, {
    name: face.name || card.name || 'Carta personalizada',
    mana_cost: face.mana_cost || '',
    cmc: manaValue(face.mana_cost),
    type_line: face.type_line || '',
    oracle_text: face.oracle_text || '',
    flavor_text: face.flavor_text || '',
    colors: manaColors(face.mana_cost),
    color_identity: manaColors(`${face.mana_cost} ${face.oracle_text}`),
    power: face.power || null,
    toughness: face.toughness || null,
    loyalty: face.loyalty || null,
  });
}
