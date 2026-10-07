/** Sustituye los símbolos {X} por marcadores que la traducción automática no toca. */
export function protectSymbols(text) {
  const symbols = [];
  const masked = (text || '').replace(/\{[^}]+\}/g, (m) => {
    symbols.push(m);
    return `⟨${symbols.length - 1}⟩`;
  });
  return { masked, symbols };
}

export function restoreSymbols(text, symbols) {
  return (text || '').replace(/⟨\s*(\d+)\s*⟩/g, (m, i) => symbols[Number(i)] ?? m);
}
