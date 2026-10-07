/**
 * Idiomas en los que se imprimen cartas de Magic.
 * code = código de Scryfall; mtgio = nombre en api.magicthegathering.io;
 * gt = código de Google Translate; mt = código de MyMemory.
 */
export const LANGUAGES = [
  { code: 'es', gt: 'es', name: 'Español', english: 'Spanish', mtgio: 'Spanish', mt: 'es-ES', flag: '🇪🇸' },
  { code: 'en', gt: 'en', name: 'English', english: 'English', mtgio: 'English', mt: 'en-GB', flag: '🇬🇧' },
  { code: 'fr', gt: 'fr', name: 'Français', english: 'French', mtgio: 'French', mt: 'fr-FR', flag: '🇫🇷' },
  { code: 'de', gt: 'de', name: 'Deutsch', english: 'German', mtgio: 'German', mt: 'de-DE', flag: '🇩🇪' },
  { code: 'it', gt: 'it', name: 'Italiano', english: 'Italian', mtgio: 'Italian', mt: 'it-IT', flag: '🇮🇹' },
  { code: 'pt', gt: 'pt', name: 'Português', english: 'Portuguese (Brazil)', mtgio: 'Portuguese (Brazil)', mt: 'pt-BR', flag: '🇧🇷' },
  { code: 'ja', gt: 'ja', name: '日本語', english: 'Japanese', mtgio: 'Japanese', mt: 'ja-JP', flag: '🇯🇵' },
  { code: 'ko', gt: 'ko', name: '한국어', english: 'Korean', mtgio: 'Korean', mt: 'ko-KR', flag: '🇰🇷' },
  { code: 'ru', gt: 'ru', name: 'Русский', english: 'Russian', mtgio: 'Russian', mt: 'ru-RU', flag: '🇷🇺' },
  { code: 'zhs', gt: 'zh-CN', name: '简体中文', english: 'Simplified Chinese', mtgio: 'Chinese Simplified', mt: 'zh-CN', flag: '🇨🇳' },
  { code: 'zht', gt: 'zh-TW', name: '繁體中文', english: 'Traditional Chinese', mtgio: 'Chinese Traditional', mt: 'zh-TW', flag: '🇹🇼' },
];

export function getLanguage(code) {
  return LANGUAGES.find((l) => l.code === code) || null;
}
