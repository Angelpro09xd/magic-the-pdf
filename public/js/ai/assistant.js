/**
 * Entiende lo que se le pide al asistente (en español o inglés) y lo convierte en una acción.
 * Lógica pura: { type, role?, budget?, bracket?, count?, card? }.
 */

const ROLE_WORDS = [
  ['lands', /\b(?:tierras?|lands?|man[aá] base)\b/i],
  ['ramp', /\b(?:ramp|rampeo|aceleraci[oó]n|acelerar|m[aá]s man[aá]|mana rocks?|piedras de man[aá])\b/i],
  ['draw', /\b(?:robo|robar|card draw|draw|ventaja de cartas|card advantage)\b/i],
  ['wipe', /\b(?:barridos?|wipes?|board ?wipes?|limpiar la mesa|sweepers?|wraths?)\b/i],
  ['interaction', /\b(?:removal|eliminaci[oó]n|quitar amenazas|interacci[oó]n|interaction|contrahechizos?|counters?pells?|counterspell)\b/i],
  ['protection', /\b(?:protecci[oó]n|protection|proteger)\b/i],
  ['tutor', /\b(?:tutor(?:es|s)?|buscadores)\b/i],
  ['recursion', /\b(?:recursi[oó]n|recursion|reanimar|reanimaci[oó]n|recuperar del cementerio)\b/i],
];

const has = (re, s) => re.test(s);

export function parseIntent(raw) {
  const text = String(raw || '').trim();
  const s = text.toLowerCase();
  if (!s) return { type: 'help' };
  const num = s.match(/\b(\d{1,2})\b/);
  const count = num ? Math.min(30, parseInt(num[1], 10)) : null;
  const role = ROLE_WORDS.find(([, re]) => re.test(s))?.[0] || null;
  const money = s.match(/(\d+(?:[.,]\d+)?)\s*(?:\$|€|usd|eur|d[oó]lares|euros)/);

  // Construir / completar
  if (has(/\b(?:constr[uú]y\w*|construir|genera\w*|crea\w*|hazme|haz un|build|make)\b[^.?!]*\b(?:mazo|deck|lista)\b/, s)) {
    // "construye un mazo de Atraxa" → comandante
    const cmd = text.match(/\b(?:mazo|deck|lista)\b(?:\s+\w+)?\s+(?:de|para|con|for|with|around)\s+(.+?)\s*[.?!]*$/i);
    const commander = cmd && !/^(?:mi|my|el|the|este|this)\b/i.test(cmd[1]) ? cmd[1].replace(/\b(?:barato|econ[oó]mico|cheap|budget)\b/gi, '').trim() || null : null;
    return { type: 'build', commander, budget: money ? parseFloat(money[1].replace(',', '.')) : has(/barat|presupuesto|budget|cheap|econ[oó]mic/, s) ? 1 : null };
  }
  if (has(/\b(?:completa|completar|rellena|rellenar|llena|fill|complete|finish)\b/, s)) return { type: 'complete' };
  // Presupuesto
  if (money || has(/\b(?:barat[oa]s?|presupuesto|budget|cheap(?:er)?|econ[oó]mic[oa]s?|menos caro|precio|ahorrar)\b/, s)) {
    return { type: 'budget', budget: money ? parseFloat(money[1].replace(',', '.')) : 2 };
  }
  // Bracket / potencia
  const br = s.match(/\bbracket\s*(\d)/);
  if (br) return { type: 'bracket', bracket: Math.max(1, Math.min(5, parseInt(br[1], 10))) };
  if (has(/\b(?:m[aá]s casual|casual|menos fuerte|menos potente|bajar (?:el )?nivel|amistos[oa]|weaker|less powerful)\b/, s)) return { type: 'bracket', bracket: 2 };
  if (has(/\b(?:m[aá]s fuerte|m[aá]s potente|competitiv[oa]|cedh|subir (?:el )?nivel|mejor[ae]s? cartas|optimiza(?:r)?|stronger|upgrade|mejora(?:r)? (?:el|mi) mazo|mej[oó]ralo)\b/, s)) return { type: 'upgrade' };
  // Quitar / cortar
  if (has(/\b(?:qu[eé] (?:quito|corto|sobra|saco)|cortar|cortes|recortar|sobran|cuts?|what (?:to|should i) cut|quita(?:r)? (?:las )?(?:peores|malas))\b/, s)) return { type: 'cuts', count };
  // Añadir una función concreta
  if (role && has(/\b(?:m[aá]s|a[nñ]ade|a[nñ]adir|pon|poner|falta|faltan|necesito|sugiere|more|add|need|suggest|mejora)\b/, s)) return { type: 'role', role, count };
  if (has(/\b(?:menos|quita|quitar|fewer|less|remove)\b/, s) && role === 'lands') return { type: 'cutLands', count };
  // Preguntas sobre el mazo
  if (has(/\bcurva\b|\bcurve\b|coste medio|mana value|cmc/, s)) return { type: 'curve' };
  if (has(/\bcolor(?:es)?\b|\bcolou?rs?\b|fuentes de man[aá]|mana base/, s) && !role) return { type: 'colors' };
  if (role === 'lands') return { type: 'lands' };
  if (has(/\bcombos?\b|infinit/, s)) return { type: 'combos' };
  if (has(/\bbracket\b|nivel de poder|power level|qu[eé] nivel/, s)) return { type: 'bracketInfo' };
  if (has(/\b(?:plan|c[oó]mo (?:se )?juega|estrategia|explica|strategy|how (?:do i|to) play|game ?plan)\b/, s)) return { type: 'explain' };
  if (has(/\b(?:est[aá] bien|qu[eé] tal|analiza|an[aá]lisis|eval[uú]a|puntu|nota|review|rate|how good|is my deck|opini[oó]n del mazo|revisa)\b/, s)) return { type: 'analyze' };
  // Una carta concreta: "¿es buena X?", "qué opinas de X", "X o Y"
  const card = text.match(/(?:qu[eé] (?:opinas|piensas) de|es buena?|vale la pena|deber[ií]a (?:poner|meter|jugar)|should i (?:play|run|add)|is)\s+["“]?([^"”?]+?)["”]?\s*(?:\?|$| en mi mazo| in my deck| good)/i);
  if (card) return { type: 'card', card: card[1].trim() };
  if (has(/\b(?:ayuda|help|qu[eé] puedes hacer|comandos)\b/, s)) return { type: 'help' };
  if (role) return { type: 'roleInfo', role };
  return { type: 'chat', text };
}
