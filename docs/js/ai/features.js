/**
 * Rasgos de una carta para el modelo de funciones (ramp, robo, removal…).
 * Se usan igual al entrenar (scripts/train-roles.js) y en el navegador.
 */

/** Texto de reglas de todas las caras, sin recordatorios y con el nombre cambiado por "~". */
export function cardText(card) {
  const faces = card.faces?.length ? card.faces : card.card_faces?.length ? card.card_faces : [card];
  const names = new Set();
  for (const n of [card.name, ...faces.map((f) => f.name)]) {
    if (!n) continue;
    for (const part of n.split(' // ')) {
      names.add(part);
      // "Atraxa, Praetors' Voice" se llama a sí misma "Atraxa".
      if (part.includes(',')) names.add(part.split(',')[0]);
    }
  }
  let text = faces.map((f) => f.oracle_text || '').join('\n') || card.oracle_text || '';
  text = text.replace(/\([^)]*\)/g, ' ');
  for (const n of [...names].sort((a, b) => b.length - a.length)) text = text.split(n).join('~');
  return text;
}

const typeLine = (card) => card.type_line || (card.card_faces || card.faces || []).map((f) => f.type_line).join(' // ') || '';

/** Lista de rasgos (palabras, parejas de palabras, tipos, coste) de una carta. */
export function features(card) {
  const raw = cardText(card)
    .toLowerCase()
    .replace(/\{t\}/g, ' _tap ')
    .replace(/\{q\}/g, ' _untap ')
    .replace(/\{x\}/g, ' _x ')
    .replace(/\{c\}/g, ' _colorless ')
    .replace(/\{[wubrgs](?:\/[wubrgp])?\}/g, ' _mana ')
    .replace(/\{\d+\}/g, ' _generic ')
    .replace(/\bthis (?:creature|artifact|enchantment|land|spell|planeswalker|permanent|card)\b/g, '~')
    .replace(/[+−-]?\d+\/[+−-]?\d+/g, ' _pt ')
    .replace(/\b\d+\b/g, ' # ')
    .replace(/\b(?:one|two|three|four|five|six|seven|x)\b/g, ' # ');
  const words = raw.match(/[a-z~#_']+|[:.,]/g) || [];
  const out = new Set();
  let prev = '^';
  for (const w of words) {
    if (w === ',' ) {
      prev = ',';
      continue;
    }
    if (w !== ':' && w !== '.') out.add(w);
    out.add(`${prev} ${w}`);
    prev = w === '.' ? '^' : w;
  }
  for (const t of typeLine(card).toLowerCase().split(/[\s—/-]+/).filter(Boolean)) out.add(`t:${t}`);
  const cmc = Math.min(7, Math.floor(card.cmc || 0));
  out.add(`cmc:${cmc}`);
  for (const k of card.keywords || []) out.add(`kw:${k.toLowerCase()}`);
  return [...out];
}
