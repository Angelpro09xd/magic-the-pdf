/**
 * Traductor del servidor: el motor común más Claude como opción si hay ANTHROPIC_API_KEY.
 */
import { createTranslator } from '../../public/js/translator/engine.js';

export { cacheKey, protectSymbols, restoreSymbols } from '../../public/js/translator/engine.js';

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    cards: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          name: { type: 'string' },
          type_line: { type: 'string' },
          oracle_text: { type: 'string' },
          flavor_text: { type: 'string' },
        },
        required: ['key', 'name', 'type_line', 'oracle_text', 'flavor_text'],
        additionalProperties: false,
      },
    },
  },
  required: ['cards'],
  additionalProperties: false,
};

/** Función de traducción con Claude para el motor (o null sin cliente). */
export function claudeTranslator({ anthropic, model, effort = 'low' }) {
  if (!anthropic) return null;
  return async (cards, language) => {
    const response = await anthropic.beta.messages.create({
      model,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort, format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
      system: `You translate Magic: The Gathering cards from English into ${language.english} for casual proxy printing. Use the official ${language.english} Magic terminology and templating used by Wizards of the Coast. Keep every symbol in braces exactly as written ({T}, {G}, {2}…) and keep the line breaks. Translate reminder text and flavor text too. Return one entry per input card with the same key.`,
      messages: [{ role: 'user', content: `Translate these cards:\n${JSON.stringify(cards, null, 2)}` }],
    });
    if (response.stop_reason === 'refusal') throw new Error('La IA rechazó la traducción');
    if (response.stop_reason === 'max_tokens') throw new Error('La respuesta de la IA se cortó');
    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
    return new Map(JSON.parse(text).cards.map((c) => [c.key, c]));
  };
}

export function createServerTranslator({ anthropic = null, model, effort, cache, memories, machine }) {
  return createTranslator({ cache, memories, machine, claude: claudeTranslator({ anthropic, model, effort }) });
}
