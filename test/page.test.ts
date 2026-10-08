import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderErrorPage, renderPage } from '../lib/page.tsx';
import type { AccountData, CatalogueData, Section } from '../lib/upstream.ts';
import { accountBody, catalogueBody, textsOf, WEB_VERSION } from './fixtures.ts';

const ok = <T>(data: T): Section<T> => ({ ok: true, data });
const failed = (reason: string): Section<never> => ({ ok: false, reason });

const catalogue: Section<CatalogueData> = ok(catalogueBody);
const account: Section<AccountData> = ok(accountBody);

describe('the page when both APIs answer', () => {
  const html = renderPage({ version: WEB_VERSION, catalogue, account });

  it('is a complete HTML document', () => {
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<title>');
  });

  it('shows the four versions with their test ids', () => {
    expect(textsOf(html, 'web-version')).toEqual(['1.2.3']);
    expect(textsOf(html, 'catalogue-version')).toEqual(['0.2.0']);
    expect(textsOf(html, 'account-version')).toEqual(['0.3.0']);
    expect(textsOf(html, 'core-version')).toEqual(['0.1.0']);
  });

  it('lists each product', () => {
    expect(textsOf(html, 'product')).toEqual(['First product 10', 'Second product 20']);
  });

  it('shows the name of the profile', () => {
    expect(textsOf(html, 'profile-name')).toEqual(['First user']);
  });

  it('has no error block', () => {
    expect(textsOf(html, 'catalogue-error')).toEqual([]);
    expect(textsOf(html, 'account-error')).toEqual([]);
  });

  it('has no client-side script and no React hydration marker', () => {
    expect(html).not.toContain('<script');
    expect(html).not.toContain('data-reactroot');
    expect(html).not.toContain('<!-- -->');
  });
});

describe('the core version in the page', () => {
  it('names both values when the two APIs report different versions', () => {
    const html = renderPage({
      version: WEB_VERSION,
      catalogue,
      account: ok({ ...accountBody, core: { version: '0.9.0', itemCount: 3 } }),
    });
    expect(textsOf(html, 'core-version')).toEqual(['catalogue: 0.1.0, account: 0.9.0']);
  });
});

describe('the page when the catalogue API fails', () => {
  const html = renderPage({ version: WEB_VERSION, catalogue: failed('HTTP 503'), account });

  it('shows an error block for the catalogue and no products', () => {
    expect(textsOf(html, 'catalogue-error')).toHaveLength(1);
    expect(textsOf(html, 'catalogue-error')[0]).toContain('HTTP 503');
    expect(textsOf(html, 'product')).toEqual([]);
    expect(textsOf(html, 'catalogue-version')).toEqual(['unavailable']);
  });

  it('still shows the profile, the web version and the core version of account', () => {
    expect(textsOf(html, 'profile-name')).toEqual(['First user']);
    expect(textsOf(html, 'web-version')).toEqual(['1.2.3']);
    expect(textsOf(html, 'account-version')).toEqual(['0.3.0']);
    expect(textsOf(html, 'core-version')).toEqual(['0.1.0']);
    expect(textsOf(html, 'account-error')).toEqual([]);
  });
});

describe('the page when the account API fails', () => {
  const html = renderPage({ version: WEB_VERSION, catalogue, account: failed('the request timed out') });

  it('shows an error block for the account and no profile', () => {
    expect(textsOf(html, 'account-error')).toHaveLength(1);
    expect(textsOf(html, 'account-error')[0]).toContain('the request timed out');
    expect(textsOf(html, 'profile-name')).toEqual([]);
    expect(textsOf(html, 'account-version')).toEqual(['unavailable']);
  });

  it('still shows the products, the web version and the core version of catalogue', () => {
    expect(textsOf(html, 'product')).toHaveLength(2);
    expect(textsOf(html, 'web-version')).toEqual(['1.2.3']);
    expect(textsOf(html, 'catalogue-version')).toEqual(['0.2.0']);
    expect(textsOf(html, 'core-version')).toEqual(['0.1.0']);
    expect(textsOf(html, 'catalogue-error')).toEqual([]);
  });
});

describe('the page with data that contains HTML', () => {
  it('escapes the text of the data', () => {
    const html = renderPage({
      version: WEB_VERSION,
      catalogue: ok({ ...catalogueBody, products: [{ id: 'p', name: '<script>alert(1)</script>', price: 1 }] }),
      account: ok({ ...accountBody, profile: { id: 'u', name: '<img src=x onerror=alert(1)>', plan: 'free' } }),
    });
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});

describe('the error page for two failed APIs', () => {
  const html = renderErrorPage({ catalogue: 'HTTP 500', account: 'the request timed out' });

  it('is a complete HTML document with a heading that names the error', () => {
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<h1>502 Bad gateway</h1>');
  });

  it('has the error block of each API', () => {
    expect(textsOf(html, 'catalogue-error')[0]).toContain('HTTP 500');
    expect(textsOf(html, 'account-error')[0]).toContain('the request timed out');
  });

  it('has no product, no profile and no version', () => {
    expect(textsOf(html, 'product')).toEqual([]);
    expect(textsOf(html, 'profile-name')).toEqual([]);
    expect(textsOf(html, 'web-version')).toEqual([]);
  });
});

describe('the discount on the page', () => {
  const withProducts = (products: CatalogueData['products']): Section<CatalogueData> => ok({ ...catalogueBody, products });
  const render = (products: CatalogueData['products']) =>
    renderPage({ version: WEB_VERSION, catalogue: withProducts(products), account });

  it('is byte for byte the page of before when no product has a discount', () => {
    // test/golden/page-without-discount.html is the output of the page before the discount existed.
    const golden = readFileSync(new URL('./golden/page-without-discount.html', import.meta.url), 'utf8');
    expect(renderPage({ version: WEB_VERSION, catalogue, account })).toBe(golden);
  });

  it('shows no discount element when no product has a discount', () => {
    expect(renderPage({ version: WEB_VERSION, catalogue, account })).not.toContain('data-testid="discount"');
  });

  it('shows the discount beside the product that has one, and only there', () => {
    const html = render([
      { id: 'product-1', name: 'First product', price: 10, discount: 10 },
      { id: 'product-2', name: 'Second product', price: 20 },
    ]);
    expect(textsOf(html, 'discount')).toEqual(['10% off']);
    expect(html).toContain(
      '<li data-testid="product"><span>First product</span> <span>10</span> <span data-testid="discount">10% off</span></li>',
    );
    expect(html).toContain('<li data-testid="product"><span>Second product</span> <span>20</span></li>');
  });

  it('shows one discount for each product that has one', () => {
    const html = render([
      { id: 'product-1', name: 'First product', price: 10, discount: 10 },
      { id: 'product-2', name: 'Second product', price: 20, discount: 25.5 },
    ]);
    expect(textsOf(html, 'discount')).toEqual(['10% off', '25.5% off']);
  });

  it('shows a discount of 0, because the field is present', () => {
    const html = render([{ id: 'product-1', name: 'First product', price: 10, discount: 0 }]);
    expect(textsOf(html, 'discount')).toEqual(['0% off']);
  });
});
