#!/usr/bin/env node
'use strict';

function help() {
  process.stdout.write(`
Usage:
  node scripts/live-probe.js --provider <id> [options]

Providers:
  tesco-ie | aldi-ie | lidl-ie | mrprice-ie | dunnes-ie | supervalu-ie

Options:
  --provider <id>       provider to test
  --queries <csv>       default: milk,bread,chicken
  --limit <n>           default: 5
  --delay <ms>          default: 1250; minimum: 1000
  --transport <name>    Dunnes: vtex or gateway
  --json                print JSON only
  --help

Environment:
  TESCO_IE_STRATEGY=xapi|index|auto
  SUPERMARKET_TESCO_IE_API_KEY=...
  SUPERMARKET_TESCO_IE_COOKIE=...
  SUPERMARKET_TESCO_IE_AUTHORIZATION=...
  SUPERMARKET_ALDI_IE_STORE_ID=...
  DUNNES_IE_STORE_ID=...
  SUPERMARKET_DUNNES_IE_COOKIE_HEADER=...
  SUPERMARKET_SUPERVALU_STORE_ID=...
  SUPERMARKET_SUPERVALU_COOKIE_HEADER=...
`);
}

function parseArgs(argv) {
  const result = { queries: ['milk', 'bread', 'chicken'], limit: 5, delay: 1250, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help') result.help = true;
    else if (arg === '--json') result.json = true;
    else if (arg === '--provider') result.provider = argv[++index];
    else if (arg === '--queries') result.queries = String(argv[++index] || '').split(',').map((v) => v.trim()).filter(Boolean);
    else if (arg === '--limit') result.limit = Number(argv[++index]);
    else if (arg === '--delay') result.delay = Number(argv[++index]);
    else if (arg === '--transport') result.transport = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isInteger(result.limit) || result.limit < 1 || result.limit > 20) {
    throw new Error('--limit must be an integer from 1 to 20');
  }
  if (!Number.isFinite(result.delay) || result.delay < 1000) {
    throw new Error('--delay must be at least 1000ms');
  }
  if (result.transport && !['vtex', 'gateway'].includes(result.transport)) {
    throw new Error('--transport must be vtex or gateway');
  }
  return result;
}

function timedFetch(timeoutMs = 30000) {
  return async (input, init = {}) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(input, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  };
}

function providerFor(args) {
  const fetcher = timedFetch();
  switch (args.provider) {
    case 'tesco-ie': {
      const strategy = process.env.TESCO_IE_STRATEGY || 'auto';
      if (!['xapi', 'index', 'auto'].includes(strategy)) {
        throw new Error('TESCO_IE_STRATEGY must be xapi, index, or auto');
      }
      const { TescoIrelandProvider } = require('../dist/providers/tesco-ie.js');
      return new TescoIrelandProvider({
        fetcher,
        strategy,
      });
    }
    case 'aldi-ie': {
      const { AldiIrelandProvider } = require('../dist/providers/aldi-ie.js');
      return new AldiIrelandProvider({ fetcher });
    }
    case 'lidl-ie': {
      const { LidlIrelandProvider } = require('../dist/providers/lidl-ie.js');
      return new LidlIrelandProvider({ fetcher });
    }
    case 'mrprice-ie': {
      const { MrPriceIrelandProvider } = require('../dist/providers/mrprice-ie.js');
      return new MrPriceIrelandProvider({ fetcher });
    }
    case 'dunnes-ie': {
      const { DunnesIrelandProvider } = require('../dist/providers/dunnes-ie.js');
      return new DunnesIrelandProvider({
        fetcher,
        transport: args.transport || 'gateway',
        storeId: process.env.DUNNES_IE_STORE_ID,
      });
    }
    case 'supervalu-ie': {
      const { SuperValuIrelandProvider } = require('../dist/providers/supervalu-ie.js');
      return new SuperValuIrelandProvider({
        fetcher,
        storeId: process.env.SUPERMARKET_SUPERVALU_STORE_ID,
        cookieHeader: process.env.SUPERMARKET_SUPERVALU_COOKIE_HEADER,
      });
    }
    default:
      throw new Error(`Unknown or missing provider: ${args.provider || '(none)'}`);
  }
}

const HARD_FAILURE_PATTERNS = [
  { reason: 'authentication failure (HTTP 401)', pattern: /\b401\b|\bunauthori[sz]ed\b/i },
  { reason: 'invalid client authentication', pattern: /invalid client/i },
  { reason: 'blocked request or challenge (HTTP 403)', pattern: /\b403\b|\bforbidden\b/i },
  { reason: 'rate limit (HTTP 429)', pattern: /\b429\b|rate[- ]?limit|too many requests/i },
  { reason: 'challenge or CAPTCHA response', pattern: /challenge|captcha|recaptcha|bot[- ]?protection/i },
  { reason: 'HTML response', pattern: /<!doctype\s+html|<\s*html(?:\b|>)|text\/html|\bhtml\b/i },
];

const MANUAL_CHECKS_REQUIRED = Object.freeze([
  'repeat the probe after five minutes and compare product IDs for stability',
  'spot-check prices and stock against official retailer pages',
  'confirm authentication and store context match the intended request',
]);

const MAX_P95_DURATION_MS = 15000;

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function hardFailureReason(value) {
  const status = value && typeof value === 'object' ? Number(value.status) : NaN;
  const text = value instanceof Error
    ? value.message
    : value && typeof value === 'object'
      ? [value.error, value.message, value.bodySnippet].filter(Boolean).join(' ')
      : String(value ?? '');

  if (status === 401) return HARD_FAILURE_PATTERNS[0].reason;
  if (status === 403) {
    return /invalid client/i.test(text)
      ? HARD_FAILURE_PATTERNS[1].reason
      : HARD_FAILURE_PATTERNS[2].reason;
  }
  if (status === 429) return HARD_FAILURE_PATTERNS[3].reason;
  const match = HARD_FAILURE_PATTERNS.find(({ pattern }) => pattern.test(text));
  return match ? match.reason : null;
}

function isHardFailure(value) {
  return hardFailureReason(value) !== null;
}

function assess(products, selectedProvider) {
  const rows = Array.isArray(products) ? products : [];
  const ids = rows.map((product) => nonEmptyString(product?.product_uid)
    ? product.product_uid.trim()
    : null);
  const uniqueIds = new Set(ids);
  const positivePrices = rows.filter((product) => {
    const price = product?.retail_price?.price;
    return typeof price === 'number' && Number.isFinite(price) && price > 0;
  }).length;
  const validationErrors = new Set();
  const validRows = rows.every((product) => {
    if (!nonEmptyString(product?.product_uid)) validationErrors.add('missing product ID');
    if (!nonEmptyString(product?.name)) validationErrors.add('missing product name');
    if (!nonEmptyString(product?.provider)) validationErrors.add('missing provider');
    if (selectedProvider && product?.provider !== selectedProvider) {
      validationErrors.add('provider does not match selected provider');
    }
    if (product?.currency !== 'EUR') validationErrors.add('currency is not EUR');
    if (product?.in_stock !== true && product?.in_stock !== false && product?.in_stock !== null) {
      validationErrors.add('stock state is not boolean or null');
    }
    if (typeof product?.retail_price?.price !== 'number' ||
      !Number.isFinite(product.retail_price.price)) {
      validationErrors.add('retail price is not a finite number');
    }
    return nonEmptyString(product?.product_uid) &&
      nonEmptyString(product?.name) &&
      nonEmptyString(product?.provider) &&
      (!selectedProvider || product.provider === selectedProvider) &&
      product.currency === 'EUR' &&
      (product.in_stock === true || product.in_stock === false || product.in_stock === null) &&
      typeof product?.retail_price?.price === 'number' &&
      Number.isFinite(product.retail_price.price);
  });
  if (ids.some((id) => id === null) || uniqueIds.size !== rows.length) {
    validationErrors.add('product IDs are not unique non-empty strings');
  }
  const knownStockCount = rows.filter((product) => typeof product?.in_stock === 'boolean').length;
  const unknownStockCount = rows.filter((product) => product?.in_stock === null).length;
  return {
    count: rows.length,
    unique_id_count: uniqueIds.size,
    positive_price_count: positivePrices,
    positive_price_rate: rows.length ? Number((positivePrices / rows.length).toFixed(3)) : 0,
    all_ids_non_empty: ids.every((id) => id !== null),
    all_names_non_empty: rows.every((product) => nonEmptyString(product?.name)),
    all_provider_non_empty: rows.every((product) => nonEmptyString(product?.provider)),
    provider_matches_selected: rows.every((product) =>
      !selectedProvider || product?.provider === selectedProvider
    ),
    all_eur: rows.every((product) => product?.currency === 'EUR'),
    all_stock_state_valid: rows.every((product) =>
      product?.in_stock === true || product?.in_stock === false || product?.in_stock === null
    ),
    stock_known_count: knownStockCount,
    stock_known_rate: rows.length ? Number((knownStockCount / rows.length).toFixed(3)) : 0,
    stock_unknown_count: unknownStockCount,
    stock_unknown_rate: rows.length ? Number((unknownStockCount / rows.length).toFixed(3)) : 0,
    all_rows_valid: validRows && uniqueIds.size === rows.length,
    validation_errors: [...validationErrors],
    sample: rows.slice(0, 3).map((product) => ({
      id: product?.product_uid,
      name: product?.name,
      price: product?.retail_price?.price ?? null,
      unit_price: product?.unit_price || null,
      in_stock: product?.in_stock,
      size: product?.size || null,
    })),
  };
}

function percentile(values, percentileValue = 0.95) {
  const numbers = values
    .filter((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0)
    .sort((left, right) => left - right);
  if (numbers.length === 0) return null;
  const rank = Math.max(1, Math.ceil(numbers.length * percentileValue));
  return numbers[Math.min(rank, numbers.length) - 1];
}

function evaluateRun(run) {
  const results = Array.isArray(run?.results) ? run.results : [];
  const successfulNonEmpty = results.filter((result) =>
    result?.ok === true &&
    nonEmptyString(result.query) &&
    Number.isInteger(result.count) &&
    result.count > 0
  );
  const hardFailures = results
    .map((result) => ({ result, reason: result?.hard_failure || hardFailureReason(result?.error) }))
    .filter(({ reason }) => reason)
    .map(({ result, reason }) => ({ query: result.query, reason, error: result.error || null }));
  const durationsAreValid = results.length > 0 && results.every((result) =>
    typeof result?.duration_ms === 'number' &&
    Number.isFinite(result.duration_ms) &&
    result.duration_ms >= 0
  );
  const p95Duration = durationsAreValid
    ? percentile(results.map((result) => result.duration_ms), 0.95)
    : null;
  const checks = {
    at_least_two_successful_non_empty_queries: successfulNonEmpty.length >= 2,
    positive_price_rate_at_least_80_percent: successfulNonEmpty.length > 0 &&
      successfulNonEmpty.every((result) => result.positive_price_rate >= 0.8),
    product_contract_valid: successfulNonEmpty.length > 0 &&
      successfulNonEmpty.every((result) =>
        result.all_rows_valid === true &&
        result.all_ids_non_empty === true &&
        result.all_names_non_empty === true &&
        result.all_provider_non_empty === true &&
        result.provider_matches_selected === true &&
        result.all_eur === true &&
        result.all_stock_state_valid === true &&
        result.count === result.unique_id_count
      ),
    no_hard_failures: hardFailures.length === 0,
    p95_duration_below_15000ms: p95Duration !== null && p95Duration < MAX_P95_DURATION_MS,
  };
  const automatedPass = Object.values(checks).every(Boolean);
  return {
    successful_non_empty_query_count: successfulNonEmpty.length,
    p95_duration_ms: p95Duration,
    hard_failures: hardFailures,
    checks,
    automated_pass: automatedPass,
    // Keep the original field for callers that consumed the probe output.
    pass: automatedPass,
    manual_gate: {
      status: 'required',
      automated_pass_is_not_full_manual_gate: true,
      checks_required: MANUAL_CHECKS_REQUIRED,
    },
    manual_checks_required: MANUAL_CHECKS_REQUIRED,
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    help();
    process.exitCode = 2;
    return;
  }
  if (args.help) {
    help();
    return;
  }

  let provider;
  try {
    provider = providerFor(args);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    help();
    process.exitCode = 2;
    return;
  }

  const run = {
    provider: args.provider,
    strategy: args.provider === 'tesco-ie' ? (process.env.TESCO_IE_STRATEGY || 'auto') : undefined,
    started_at: new Date().toISOString(),
    node: process.version,
    results: [],
  };

  for (let index = 0; index < args.queries.length; index += 1) {
    const query = args.queries[index];
    const started = Date.now();
    try {
      const products = await provider.search(query, { limit: args.limit });
      run.results.push({
        query,
        ok: true,
        duration_ms: Date.now() - started,
        ...assess(products, args.provider),
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const hardFailure = hardFailureReason(error);
      run.results.push({
        query,
        ok: false,
        duration_ms: Date.now() - started,
        error: errorMessage,
        ...(hardFailure ? { hard_failure: hardFailure } : {}),
      });
      // Authentication, throttling, and challenge responses are a hard stop.
      // Do not create a fallback burst against another retailer route.
      if (hardFailure) break;
    }
    if (index < args.queries.length - 1) await sleep(args.delay);
  }

  run.finished_at = new Date().toISOString();
  Object.assign(run, evaluateRun(run));

  if (args.json) {
    process.stdout.write(`${JSON.stringify(run, null, 2)}\n`);
  } else {
    process.stdout.write(`Provider: ${run.provider}${run.strategy ? ` (${run.strategy})` : ''}\n`);
    for (const result of run.results) {
      if (result.ok) {
        process.stdout.write(
          `  ${result.query}: ${result.count} products, ${(result.positive_price_rate * 100).toFixed(0)}% priced, ${(result.stock_known_rate * 100).toFixed(0)}% stock known, ${result.duration_ms}ms\n`
        );
      } else {
        process.stdout.write(`  ${result.query}: FAILED — ${result.error}\n`);
      }
    }
    process.stdout.write(`Automated result: ${run.automated_pass ? 'PASS' : 'FAIL'}\n`);
    process.stdout.write('Automated PASS is not the full manual live gate; manual checks are still required.\n');
    process.stdout.write('Manual checks required:\n');
    for (const check of run.manual_checks_required) process.stdout.write(`  - ${check}\n`);
  }
  if (!run.automated_pass) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  MAX_P95_DURATION_MS,
  MANUAL_CHECKS_REQUIRED,
  assess,
  evaluateRun,
  hardFailureReason,
  help,
  isHardFailure,
  main,
  parseArgs,
  percentile,
  providerFor,
  timedFetch,
};
