/**
 * IA de texto gratuita y sin clave (Pollinations, https://pollinations.ai). Solo redacta:
 * los datos y las decisiones los calcula la IA propia de la app, y se le pasan como hechos.
 * Si no responde, la app sigue funcionando con sus respuestas locales.
 */
import { detectMode } from '../backend.js';

const ENDPOINT = 'https://text.pollinations.ai/openai';
let last = 0;
let chain = Promise.resolve();

export async function askLLM(messages, { timeout = 30000, maxChars = 1800 } = {}) {
  // Con el servidor (npm start) se pide a través de él (Claude si hay clave; Pollinations si no).
  if ((await detectMode().catch(() => 'static')) === 'server') {
    const res = await fetch('api/llm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages }), signal: AbortSignal.timeout(timeout + 15000) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.text) throw new Error(data.error || `IA en línea ${res.status}`);
    return data.text.replace(/<think>[\s\S]*?<\/think>/g, '').trim().slice(0, maxChars);
  }
  const run = chain.then(async () => {
    // Uso anónimo: como mucho una petición cada pocos segundos.
    let res;
    for (let attempt = 0; ; attempt++) {
      const wait = last + 5000 - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      last = Date.now();
      res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'openai', messages, private: true, referrer: 'magic-the-pdf' }),
        signal: AbortSignal.timeout(timeout),
      });
      // Límite del uso anónimo (402/429): se espera un poco y se reintenta.
      if ((res.status === 402 || res.status === 429) && attempt < 2) {
        last = Date.now() + 6000 * (attempt + 1);
        continue;
      }
      break;
    }
    if (!res.ok) throw new Error(`IA en línea ${res.status}`);
    const data = await res.json();
    const text = String(data?.choices?.[0]?.message?.content || '')
      .replace(/<think>[\s\S]*?<\/think>/g, '')
      .trim();
    if (!text) throw new Error('IA en línea sin respuesta');
    return text.slice(0, maxChars);
  });
  chain = run.catch(() => {});
  return run;
}
