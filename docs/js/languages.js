/**
 * Idiomas de las cartas.
 * code = código de Scryfall; mtgio = nombre en api.magicthegathering.io;
 * gt = código de Google Translate; mt = código de MyMemory.
 * printed: false → Magic no se imprime en ese idioma: no hay cartas oficiales ni memoria de
 * traducción, todo se traduce (traducción automática + correcciones).
 */
export const LANGUAGES = [
  { code: 'es', gt: 'es', name: 'Español', english: 'Spanish', mtgio: 'Spanish', mt: 'es-ES', flag: '🇪🇸', printed: true },
  { code: 'en', gt: 'en', name: 'English', english: 'English', mtgio: 'English', mt: 'en-GB', flag: '🇬🇧', printed: true },
  { code: 'fr', gt: 'fr', name: 'Français', english: 'French', mtgio: 'French', mt: 'fr-FR', flag: '🇫🇷', printed: true },
  { code: 'de', gt: 'de', name: 'Deutsch', english: 'German', mtgio: 'German', mt: 'de-DE', flag: '🇩🇪', printed: true },
  { code: 'it', gt: 'it', name: 'Italiano', english: 'Italian', mtgio: 'Italian', mt: 'it-IT', flag: '🇮🇹', printed: true },
  { code: 'pt', gt: 'pt', name: 'Português', english: 'Portuguese (Brazil)', mtgio: 'Portuguese (Brazil)', mt: 'pt-BR', flag: '🇧🇷', printed: true },
  { code: 'ja', gt: 'ja', name: '日本語', english: 'Japanese', mtgio: 'Japanese', mt: 'ja-JP', flag: '🇯🇵', printed: true },
  { code: 'ko', gt: 'ko', name: '한국어', english: 'Korean', mtgio: 'Korean', mt: 'ko-KR', flag: '🇰🇷', printed: true },
  { code: 'ru', gt: 'ru', name: 'Русский', english: 'Russian', mtgio: 'Russian', mt: 'ru-RU', flag: '🇷🇺', printed: true },
  { code: 'zhs', gt: 'zh-CN', name: '简体中文', english: 'Simplified Chinese', mtgio: 'Chinese Simplified', mt: 'zh-CN', flag: '🇨🇳', printed: true },
  { code: 'zht', gt: 'zh-TW', name: '繁體中文', english: 'Traditional Chinese', mtgio: 'Chinese Traditional', mt: 'zh-TW', flag: '🇹🇼', printed: true },
  // Solo traducción (sin cartas oficiales)
  { code: 'ca', gt: 'ca', name: 'Català', english: 'Catalan', mt: 'ca-ES', flag: '🏳️', printed: false },
  { code: 'gl', gt: 'gl', name: 'Galego', english: 'Galician', mt: 'gl-ES', flag: '🏳️', printed: false },
  { code: 'eu', gt: 'eu', name: 'Euskara', english: 'Basque', mt: 'eu-ES', flag: '🏳️', printed: false },
  { code: 'nl', gt: 'nl', name: 'Nederlands', english: 'Dutch', mt: 'nl-NL', flag: '🇳🇱', printed: false },
  { code: 'pl', gt: 'pl', name: 'Polski', english: 'Polish', mt: 'pl-PL', flag: '🇵🇱', printed: false },
  { code: 'tr', gt: 'tr', name: 'Türkçe', english: 'Turkish', mt: 'tr-TR', flag: '🇹🇷', printed: false },
  { code: 'sv', gt: 'sv', name: 'Svenska', english: 'Swedish', mt: 'sv-SE', flag: '🇸🇪', printed: false },
  { code: 'uk', gt: 'uk', name: 'Українська', english: 'Ukrainian', mt: 'uk-UA', flag: '🇺🇦', printed: false },
];

export const PRINTED_LANGUAGES = LANGUAGES.filter((l) => l.printed);

export function getLanguage(code) {
  return LANGUAGES.find((l) => l.code === code) || null;
}

/** ¿Hay cartas oficiales impresas en este idioma? */
export const isPrinted = (code) => Boolean(getLanguage(code)?.printed);

/**
 * <option>s agrupados: idiomas con cartas oficiales y "solo traducción".
 * groupLabels: { printed, translated } (textos de la interfaz).
 */
export function languageOptions(selected, groupLabels = {}, { onlyPrinted = false } = {}) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const opt = (l) => `<option value="${l.code}" ${l.code === selected ? 'selected' : ''}>${l.flag} ${esc(l.name)}</option>`;
  const printed = LANGUAGES.filter((l) => l.printed).map(opt).join('');
  if (onlyPrinted) return printed;
  const translated = LANGUAGES.filter((l) => !l.printed).map(opt).join('');
  return `<optgroup label="${esc(groupLabels.printed || 'Official cards')}">${printed}</optgroup><optgroup label="${esc(groupLabels.translated || 'Translation only')}">${translated}</optgroup>`;
}
