/**
 * Tesco: a basket that is really an upcoming order in amend mode must not take
 * writes unless the caller opted in.
 *
 * When a Tesco shopper has an order open for amending, GetBasket returns that
 * order. Before this guard, `supermarket add` quietly added to someone's next
 * delivery. Uses a fake TescoAPI; never touches a real account.
 *
 * Run: npx tsx test/tesco-amend.test.ts
 */

import assert from 'node:assert';
import { TescoProvider, amendOf } from '../src/providers/tesco';
import { OrderAmendError } from '../src/errors';
import { batchAdd } from '../src/batch';

const AMEND = {
  basket: {
    id: 'trn:tesco:order:amend', isInAmend: true, amendOrderId: 'ord-1',
    orderNo: '1234-5678-90', amendExpiry: '2026-11-05T22:45:00Z',
    splitView: [{ totalPrice: 12.5, totalItems: 1, items: [{ id: 'line-1', quantity: 1, product: { id: '111', title: 'Bananas', price: { actual: 0.16 } } }] }],
  },
};
const TROLLEY = { basket: { ...AMEND.basket, id: 'trn:tesco:order:trolley', isInAmend: false } };

function provider(basket: any) {
  const p = new TescoProvider();
  const writes: any[] = [];
  (p as any).api = {
    getBasket: async () => basket,
    updateBasket: async (...a: any[]) => { writes.push(a); },
  };
  return { p, writes };
}

let failures = 0;
const tests: [string, () => Promise<void>][] = [];
const check = (name: string, fn: () => Promise<void>) => tests.push([name, fn]);

check('amend basket is reported as an amend', async () => {
  const b = await provider(AMEND).p.getBasket();
  assert.deepStrictEqual(b.amend, { order_id: 'ord-1', order_no: '1234-5678-90', expires_at: '2026-11-05T22:45:00Z' });
  assert.strictEqual(b.basket_id, 'trn:tesco:order:amend');
});

check('a normal trolley has no amend', async () => {
  assert.strictEqual((await provider(TROLLEY).p.getBasket()).amend, undefined);
  assert.strictEqual(amendOf(undefined), undefined);
});

for (const [name, op] of [
  ['add', (p: TescoProvider) => p.addToBasket('222', 1)],
  ['update', (p: TescoProvider) => p.updateBasketItem('line-1', 3)],
  ['remove', (p: TescoProvider) => p.removeFromBasket('line-1')],
  ['clear', (p: TescoProvider) => p.clearBasket()],
] as const) {
  check(`${name} refuses to edit an amend order by default`, async () => {
    const { p, writes } = provider(AMEND);
    await assert.rejects(op(p), (e: any) => e instanceof OrderAmendError && /1234-5678-90/.test(e.message) && /--amend/.test(e.message));
    assert.strictEqual(writes.length, 0, 'nothing may be written');
  });

  check(`${name} edits the amend order once opted in`, async () => {
    const { p, writes } = provider(AMEND);
    p.allowOrderAmend(true);
    await op(p);
    assert.ok(writes.length > 0);
    assert.strictEqual(writes[0][2], 'trn:tesco:order:amend');
  });

  check(`${name} on a normal trolley needs no opt-in`, async () => {
    const { p, writes } = provider(TROLLEY);
    await op(p);
    assert.ok(writes.length > 0);
  });
}

check('batch add stops at the first amend refusal instead of failing N times', async () => {
  const { p, writes } = provider(AMEND);
  await assert.rejects(batchAdd(p, [{ id: 'a' }, { id: 'b' }]), OrderAmendError);
  assert.strictEqual(writes.length, 0);
});

(async () => {
  console.log('tesco-amend');
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`  ✓ ${name}`); }
    catch (e: any) { failures++; console.error(`  ✗ ${name}\n    ${e.message}`); }
  }
  if (failures) { console.error(`\n${failures} failed`); process.exit(1); }
  console.log('\nall passed');
})();
