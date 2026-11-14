import type { Product, StoreContext } from '../types';
import { cleanGtin } from '../gtin';

export const CONAD_PAGE_SIZE = 40;
export const CONAD_MAX_QUANTITY_DELTA = 10;

export function isConadCode(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function regularPrice(value: unknown): number | null {
  if (typeof value === 'string') {
    if (!/^\d+(?:[.,]\d{1,2})?$/.test(value.trim())) return null;
    value = Number(value.trim().replace(',', '.'));
  }
  // Conad uses zero as its unavailable-price sentinel, not a free offer.
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

export function normaliseProduct(raw: unknown, store: StoreContext): Product {
  if (!isRecord(raw) || !isConadCode(raw.code) || typeof raw.nome !== 'string' || !raw.nome.trim()) {
    throw new Error('Conad returned a product without a usable retailer code or name.');
  }
  const product: Product = {
    product_uid: raw.code,
    name: raw.nome.trim(),
    retail_price: { price: regularPrice(raw.basePrice) },
    in_stock: null,
    provider: 'conad',
    currency: 'EUR',
    store,
  };
  if (typeof raw.defaultImgSrc === 'string' && raw.defaultImgSrc) {
    try {
      const url = new URL(raw.defaultImgSrc, 'https://spesaonline.conad.it');
      if (url.protocol === 'https:') product.image_url = url.href;
    } catch { /* Invalid optional media must not hide a usable product. */ }
  }
  if (typeof raw.netQuantity === 'number' && Number.isFinite(raw.netQuantity) && raw.netQuantity > 0 && typeof raw.netQuantityUm === 'string' && raw.netQuantityUm.trim()) {
    product.size = `${raw.netQuantity} ${raw.netQuantityUm.trim()}`;
  }
  if (typeof raw.ean === 'string' && /^\d+$/.test(raw.ean)) {
    const gtin = cleanGtin(raw.ean);
    if (gtin) product.gtin = gtin;
  }
  return product;
}
