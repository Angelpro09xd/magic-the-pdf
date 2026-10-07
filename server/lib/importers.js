import { fetchJson, HttpError } from './http.js';

const UA = 'MagicThePDF/1.0 (+https://github.com/angelpro09xd/magic-the-pdf)';

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new HttpError(res.status, `${new URL(url).host} respondió ${res.status}`);
  return res.text();
}

const line = (qty, name, set, cn) => `${qty} ${name}${set ? ` (${set.toUpperCase()})${cn ? ` ${cn}` : ''}` : ''}`;

async function importArchidekt(id) {
  const d = await fetchJson(`https://archidekt.com/api/decks/${id}/`);
  const excluded = new Set((d.categories || []).filter((c) => c.includedInDeck === false).map((c) => c.name));
  const commanders = [];
  const main = [];
  for (const entry of d.cards || []) {
    const cats = entry.categories || [];
    if (cats.some((c) => excluded.has(c))) continue;
    const card = entry.card;
    const text = line(entry.quantity, card.oracleCard?.name, card.edition?.editioncode, card.collectorNumber);
    (cats.includes('Commander') ? commanders : main).push(text);
  }
  return { name: d.name, text: toText(commanders, main) };
}

async function importMoxfield(id) {
  let d;
  try {
    d = await fetchJson(`https://api2.moxfield.com/v3/decks/all/${id}`);
  } catch (err) {
    if (err.status === 403 || err.status === 429) {
      throw new HttpError(
        502,
        'Moxfield bloquea las peticiones automáticas. En Moxfield usa "Export → Copy for MTGO" y pega la lista en "Importar texto".',
      );
    }
    throw err;
  }
  const commanders = [];
  const main = [];
  const boards = d.boards || {};
  for (const [boardName, list] of [['commanders', commanders], ['companions', main], ['mainboard', main]]) {
    for (const entry of Object.values(boards[boardName]?.cards || {})) {
      list.push(line(entry.quantity, entry.card.name, entry.card.set, entry.card.cn));
    }
  }
  return { name: d.name, text: toText(commanders, main) };
}

function toText(commanders, main) {
  return [commanders.length ? 'Commander' : null, ...commanders, commanders.length ? '' : null, 'Deck', ...main]
    .filter((l) => l !== null)
    .join('\n');
}

/** Importa un mazo desde la URL pública de varias webs. Devuelve { name, text } en formato de lista. */
export async function importDeckFromUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new HttpError(400, 'URL no válida');
  }
  const host = url.hostname.replace(/^www\./, '');
  let m;
  if (host === 'archidekt.com' && (m = url.pathname.match(/\/(?:api\/)?decks\/(\d+)/))) {
    return importArchidekt(m[1]);
  }
  if (host === 'moxfield.com' && (m = url.pathname.match(/\/decks\/([\w-]+)/))) {
    return importMoxfield(m[1]);
  }
  if (host === 'mtggoldfish.com' && (m = url.pathname.match(/\/deck\/(?:download\/)?(\d+)/))) {
    return { name: `MTGGoldfish ${m[1]}`, text: await fetchText(`https://www.mtggoldfish.com/deck/download/${m[1]}`) };
  }
  if (host === 'tappedout.net' && (m = url.pathname.match(/\/mtg-decks\/([\w-]+)/))) {
    return { name: m[1].replace(/-/g, ' '), text: await fetchText(`https://tappedout.net/mtg-decks/${m[1]}/?fmt=txt`) };
  }
  throw new HttpError(400, 'Web no soportada. Usa Archidekt, Moxfield, MTGGoldfish o TappedOut, o pega la lista como texto.');
}
