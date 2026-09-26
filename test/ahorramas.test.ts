import assert from 'node:assert';
import { AhorramasHttpError, AhorramasParseError, AhorramasProvider, normaliseAhorramasBasket, parseAhorramasCartHtml, parseAhorramasPrice } from '../src/providers/ahorramas';
import { getManifest } from '../src/providers/registry';

let failures = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log(`  ✓ ${name}`); }
  catch (err: any) { failures++; console.error(`  ✗ ${name}\n    ${err.message}`); }
}

const line = { UUID: 'line-uuid-1', id: '78030', productName: 'Leche entera', quantity: 2, unitPrice: { sales: { value: '1,99€' } }, priceTotal: { decimalPrice: '3,98' } };
const empty = { items: [], quantityTotal: 0, totals: { subTotal: '0,00', total: '0,00' } };
const basket = { items: [line], quantityTotal: 2, totals: { subTotal: '3,98', total: '3,98' } };

function fakeProvider(initial: any = empty) {
  const calls: any[] = [];
  let current: any = initial;
  const provider = new AhorramasProvider({
    async request(config: any) {
      calls.push({ ...config, headers: { ...config.headers } });
      const path = config.url;
      if (path === '/cart') return { status: 200, data: JSON.stringify({ cart: current }), headers: { 'set-cookie': ['sid=abc123; Path=/', 'dwsid=secret; Path=/'] } };
      if (path.endsWith('Cart-AddProduct')) { current = basket; return { status: 200, data: { cart: current }, headers: {} }; }
      if (path.endsWith('Cart-UpdateQuantity')) { current = { ...basket, items: [{ ...line, quantity: Number(config.params.quantityAbs) }], quantityTotal: Number(config.params.quantityAbs) }; return { status: 200, data: { cart: current }, headers: {} }; }
      if (path.endsWith('Cart-RemoveProductLineItem')) { current = empty; return { status: 200, data: { cart: current }, headers: {} }; }
      if (path.endsWith('Search-Show')) return { status: 200, data: '<script type="application/json">{"products":[{"id":"78030","name":"Leche","price":"1,99€"}]}</script>', headers: {} };
      throw new Error(`unexpected path ${path}`);
    },
  } as any);
  return { provider, calls };
}

async function main() {
  await check('manifest declares anonymous search and basket', () => {
    assert.deepStrictEqual(getManifest('ahorramas').capabilities, ['search', 'basket']);
    assert.strictEqual(getManifest('ahorramas').auth, 'anonymous');
  });
  await check('Spanish price parsing uses euros, not cents', () => assert.strictEqual(parseAhorramasPrice('1,99€'), 1.99));
  await check('basket maps UUID/item id/product id and effective prices', () => {
    const b = normaliseAhorramasBasket(basket);
    assert.strictEqual(b.items[0].item_id, 'line-uuid-1');
    assert.strictEqual(b.items[0].product_uid, '78030');
    assert.strictEqual(b.items[0].unit_price, 1.99);
    assert.strictEqual(b.items[0].total_price, 3.98);
    assert.strictEqual(b.total_cost, 3.98);
  });
  await check('empty SSR basket is distinct from malformed HTML', () => {
    assert.deepStrictEqual(normaliseAhorramasBasket(parseAhorramasCartHtml('<script type="application/json">{"cart":{"items":[],"totals":{"total":"0,00"}}}</script>')).items, []);
    assert.throws(() => parseAhorramasCartHtml('<html>unexpected upstream page</html>'), AhorramasParseError);
  });
  await check('search product id is compatible with basket product_uid', async () => {
    const { provider } = fakeProvider();
    assert.strictEqual((await provider.search('leche'))[0].product_uid, '78030');
  });
  await check('add, get and cookie jar keep the anonymous session', async () => {
    const { provider, calls } = fakeProvider();
    await provider.addToBasket('78030', 1);
    const result = await provider.getBasket();
    await provider.getBasket();
    assert.strictEqual(result.items[0].product_uid, '78030');
    assert.match(String(calls[2].headers.Cookie), /sid=abc123/);
    assert.doesNotMatch(JSON.stringify(result), /abc123|secret/);
    assert.match(String(calls[0].data), /pid=78030/);
  });
  await check('update is absolute and sends quantityAbs', async () => {
    const { provider, calls } = fakeProvider(basket);
    await provider.getBasket();
    await provider.updateBasketItem('line-uuid-1', 1);
    const update = calls.find(c => c.url.endsWith('Cart-UpdateQuantity'));
    assert.deepStrictEqual(update.params, { pid: '78030', quantity: 1, quantityAbs: 1, uuid: 'line-uuid-1' });
  });
  await check('remove and clear use UUID line endpoints', async () => {
    const { provider, calls } = fakeProvider(basket);
    await provider.removeFromBasket('line-uuid-1');
    assert.strictEqual(calls.filter(c => c.url.endsWith('Cart-RemoveProductLineItem')).length, 1);
    assert.strictEqual(calls[1].params.uuid, 'line-uuid-1');
    const cleared = fakeProvider(basket);
    await cleared.provider.clearBasket();
    assert.strictEqual(cleared.calls.filter(c => c.url.endsWith('Cart-RemoveProductLineItem')).length, 1);
  });
  await check('clear removes multiple lines and propagates partial failures', async () => {
    const lines = [
      { ...line, UUID: 'line-1', id: '78030' },
      { ...line, UUID: 'line-2', id: '78031' },
    ];
    const calls: any[] = [];
    const provider = new AhorramasProvider({ async request(config: any) {
      calls.push(config);
      if (config.url === '/cart') return { data: JSON.stringify({ cart: { items: lines, totals: { total: '7,96' } } }), headers: {} };
      if (config.params.uuid === 'line-2') { const error: any = new Error('second line failed'); error.response = { status: 500, data: { error: 'line removal failed' } }; throw error; }
      return { data: {}, headers: {} };
    } } as any);
    await assert.rejects(provider.clearBasket(), /line removal failed/);
    assert.deepStrictEqual(calls.filter(c => c.url.endsWith('Cart-RemoveProductLineItem')).map(c => c.params.uuid), ['line-1', 'line-2']);
  });
  await check('invalid quantity fails before HTTP', async () => {
    const { provider, calls } = fakeProvider();
    await assert.rejects(provider.addToBasket('78030', 0), /greater than zero/);
    await assert.rejects(provider.updateBasketItem('line-uuid-1', -1), /greater than zero/);
    assert.strictEqual(calls.length, 0);
  });
  await check('HTTP 500 remains an actionable error and is not an empty basket', async () => {
    const provider = new AhorramasProvider({ async request() { const e: any = new Error('server'); e.response = { status: 500, data: { error: 'product 999 does not exist' } }; throw e; } } as any);
    await assert.rejects(provider.getBasket(), (err: any) => err instanceof AhorramasHttpError && err.status === 500 && /product 999 does not exist/.test(err.message) && !/items/.test(err.message));
  });
  process.exit(failures ? 1 : 0);
}

main();
