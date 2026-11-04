import assert from 'node:assert/strict';
import { asNumber, firstNumber, jsonResponse, ProviderHttpError, ProviderProtocolError } from '../src/providers/ie/shared';

async function main() {
  for (const [input, expected] of [
    [0, 0], [2.5, 2.5], ['2', 2], ['2.50', 2.5], ['€2,50', 2.5],
    ['2.50 EUR', 2.5], ['£ 2.50', 2.5], ['USD 2.50', 2.5],
    ['€1.234,56', 1234.56], ['€1,234.56', 1234.56], ['1,234', 1234],
    ['1,234,567.89', 1234567.89], ['1.234.567,89', 1234567.89], ['-2.5', -2.5],
  ] as const) assert.equal(asNumber(input), expected, String(input));
  for (const input of ['2 for €3', 'from €2', '€2 / kg', '2kg', '1,23,4',
    '1.234,5.6', '2 50', '€2EUR', '', 'Infinity', null, NaN, Infinity]) {
    assert.equal(asNumber(input), undefined, String(input));
  }
  assert.equal(firstNumber('2 for €3', '€1.50'), 1.5);
  const canary = 'unlabelled-secret-canary@example.test <private-contact>';
  for (const status of [401, 403, 429, 500]) {
    await assert.rejects(jsonResponse(new Response(canary, { status }), 'lidl-ie'), error => {
      assert.ok(error instanceof ProviderHttpError);
      assert.equal(error.status, status);
      assert.equal(error.provider, 'lidl-ie');
      assert.match(error.message, new RegExp(`HTTP ${status}`));
      assert.ok(!JSON.stringify(error).includes(canary));
      assert.ok(!error.stack?.includes(canary));
      return true;
    });
  }
  await assert.rejects(jsonResponse(new Response(canary), 'lidl-ie'), error => {
    assert.ok(error instanceof ProviderProtocolError);
    assert.match(error.message, /expected JSON/);
    assert.ok(!error.message.includes(canary));
    return true;
  });
  for (const name of ['TimeoutError', 'TypeError']) {
    const transportError = new Error('response stream failed');
    transportError.name = name;
    const brokenBody = { ok: true, status: 200, text: async () => { throw transportError; } } as Response;
    await assert.rejects(jsonResponse(brokenBody, 'lidl-ie'), error => error === transportError);
  }
  // Error status does not require reading or exposing the retailer body.
  const unreadableError = { ok: false, status: 429, text: async () => { throw new Error('private body'); } } as Response;
  await assert.rejects(jsonResponse(unreadableError, 'lidl-ie'), error => {
    assert.ok(error instanceof ProviderHttpError);
    assert.equal(error.status, 429);
    assert.ok(!error.message.includes('private body'));
    return true;
  });
  assert.deepEqual(await jsonResponse(new Response('{"items":[]}'), 'lidl-ie'), { items: [] });
  console.log('  ✓ strict amounts and safe retailer-response errors');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
