/**
 * Adaptadores de fuentes externas (EDHREC, Commander Spellbook), comunes al servidor y al navegador.
 */

export const EDHREC_URL = (slug) => `https://json.edhrec.com/pages/commanders/${slug}.json`;
export const SPELLBOOK_URL = 'https://backend.commanderspellbook.com/find-my-combos';

/** Reduce la página de EDHREC de un comandante a listas de cartas recomendadas. */
export function simplifyEdhrec(d) {
  const dict = d?.container?.json_dict || {};
  return {
    numDecks: dict.card?.num_decks ?? null,
    lists: (dict.cardlists || []).map((l) => ({
      header: l.header,
      tag: l.tag,
      cards: (l.cardviews || []).map((c) => ({
        name: c.name,
        synergy: c.synergy ?? null,
        inclusion: c.potential_decks ? c.num_decks / c.potential_decks : null,
        numDecks: c.num_decks ?? null,
      })),
    })),
  };
}

export function spellbookBody(commanders, main) {
  return {
    commanders: commanders.slice(0, 4).map((card) => ({ card: String(card) })),
    main: main.slice(0, 250).map((card) => ({ card: String(card) })),
  };
}

/** Reduce la respuesta de "find my combos" de Commander Spellbook. */
export function simplifyCombos(d) {
  const simplify = (v) => ({
    id: v.id,
    cards: (v.uses || []).map((u) => u.card.name),
    produces: (v.produces || []).map((p) => p.feature.name),
    description: v.description,
    prerequisites: v.easyPrerequisites || v.notablePrerequisites || '',
    manaNeeded: v.manaNeeded || '',
    identity: v.identity,
    bracketTag: v.bracketTag,
    url: `https://commanderspellbook.com/combo/${v.id}/`,
  });
  const r = d?.results || {};
  return {
    included: (r.included || []).slice(0, 60).map(simplify),
    almostIncluded: (r.almostIncluded || []).slice(0, 60).map(simplify),
  };
}
