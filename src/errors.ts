/**
 * Turn transport errors into something a person can act on.
 *
 * Providers are reverse-engineered integrations against sites that rate-limit,
 * expire sessions and deploy bot protection. The raw failure is almost always
 * "Request failed with status code 401", which tells the user nothing and sends
 * them to the issue tracker for what is usually an expired login.
 *
 * Translating here rather than inside each provider is deliberate: there are six
 * providers and a dozen methods each, most with no try/catch at all. One
 * translation at the boundary fixes every command for every provider, including
 * ones not written yet.
 *
 * Providers that DO have something specific to say (Tesco's session help, Albert
 * Heijn's rate-limit note, Ocado's explanation that checkout was never captured)
 * still win — their messages are preserved untouched.
 */

export interface ExplainOptions {
  /** Provider id, so the suggested fix names the right one. */
  provider?: string;
  /** What was being attempted, e.g. "get slots". Used in the message. */
  action?: string;
}

function statusOf(err: any): number | undefined {
  return err?.response?.status ?? err?.status;
}

/**
 * True when a provider has already produced a considered message, in which case
 * we must not bury it under a generic one. Heuristic: anything that isn't the
 * stock axios string and is long enough to be a sentence.
 */
function alreadyExplained(message: string): boolean {
  if (!message) return false;
  if (/^Request failed with status code \d+$/.test(message)) return false;
  if (/^(timeout|socket hang up|read ECONNRESET)/i.test(message)) return false;
  return message.length > 40;
}

export function explain(err: any, opts: ExplainOptions = {}): string {
  const raw: string = err?.message ?? String(err);
  const status = statusOf(err);
  const who = opts.provider ? `${opts.provider}` : 'the provider';
  const what = opts.action ? ` while trying to ${opts.action}` : '';

  // Bot protection is checked FIRST. It arrives as prose rather than a status
  // code, and those strings are long enough to fool alreadyExplained() into
  // treating a raw WAF response as a considered provider message. A test pins
  // this ordering.
  if (/cf-mitigated|cloudflare|captcha|are you a robot|access denied/i.test(raw)) {
    return (
      `${who} served a bot-protection challenge${what}. ` +
      `This provider may need a browser session — check \`supermarket providers\` for its auth model.`
    );
  }

  if (alreadyExplained(raw)) return raw;

  if (status === 401 || status === 403) {
    const SESSION_IMPORT_PROVIDERS = new Set(['tesco', 'tesco-hu', 'instacart-web']);
    const loginHint =
      opts.provider && SESSION_IMPORT_PROVIDERS.has(opts.provider)
        ? `Import a browser session — see \`supermarket --provider ${opts.provider} import-session --help\`.`
        : `Log in with \`supermarket login --provider ${who}\`, or set SUPERMARKET_EMAIL and SUPERMARKET_PASSWORD.`;
    return (
      `Not authenticated with ${who} (HTTP ${status})${what}.\n` +
      `${loginHint}\n` +
      `Check the current state with \`supermarket status --provider ${who}\`.`
    );
  }

  if (status === 429) {
    return (
      `${who} is rate limiting us (HTTP 429)${what}. ` +
      `Wait a minute and retry — this is not a broken integration.`
    );
  }

  if (status === 404) {
    return `${who} returned 404${what}. The item may no longer exist, or the API path has moved.`;
  }

  if (typeof status === 'number' && status >= 500) {
    return `${who} is having server trouble (HTTP ${status})${what}. Usually transient — retry shortly.`;
  }

  const code = err?.code;
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return `Could not reach ${who} (${code})${what}. Check your network or DNS.`;
  }
  if (code === 'ETIMEDOUT' || code === 'ECONNABORTED' || /timeout/i.test(raw)) {
    return `${who} timed out${what}. It may be slow or blocking automated traffic.`;
  }

  return opts.action ? `${raw} (${opts.action})` : raw;
}
