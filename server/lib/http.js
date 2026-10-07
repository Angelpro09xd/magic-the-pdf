const USER_AGENT = 'MagicThePDF/1.0 (+https://github.com/angelpro09xd/magic-the-pdf)';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** fetch con User-Agent, timeout y errores legibles. */
export async function fetchJson(url, { method = 'GET', body, headers = {}, timeoutMs = 15000 } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new HttpError(res.status, `${method} ${new URL(url).host} respondió ${res.status}`);
  }
  return res.json();
}

export async function fetchBinary(url, { timeoutMs = 20000 } = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'image/*,*/*' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new HttpError(res.status, `GET ${new URL(url).host} respondió ${res.status}`);
  return {
    buffer: Buffer.from(await res.arrayBuffer()),
    contentType: res.headers.get('content-type') || 'application/octet-stream',
  };
}

/** Serializa llamadas para respetar límites de ritmo (p. ej. Scryfall pide <10 req/s). */
export function createThrottle(minGapMs) {
  let last = 0;
  let chain = Promise.resolve();
  return (fn) => {
    const run = chain.then(async () => {
      const wait = last + minGapMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      last = Date.now();
      return fn();
    });
    chain = run.catch(() => {});
    return run;
  };
}
