import type { AccountData, CatalogueData } from '../lib/upstream.ts';

// Each service has its own version, so a test can see which value a test id shows.
export const WEB_VERSION = '1.2.3';

export const catalogueBody = {
  service: 'catalogue',
  version: '0.2.0',
  core: { version: '0.1.0', itemCount: 3 },
  products: [
    { id: 'product-1', name: 'First product', price: 10 },
    { id: 'product-2', name: 'Second product', price: 20 },
  ],
} satisfies CatalogueData & { service: string };

export const accountBody = {
  service: 'account',
  version: '0.3.0',
  core: { version: '0.1.0', itemCount: 3 },
  profile: { id: 'user-1', name: 'First user', plan: 'free' },
} satisfies AccountData & { service: string };

// The text content of each element that has this test id. Nested tags are removed.
export function textsOf(html: string, testId: string): string[] {
  const element = new RegExp(`<([a-z0-9]+)[^>]*data-testid="${testId}"[^>]*>(.*?)</\\1>`, 'gs');
  return [...html.matchAll(element)].map((match) => (match[2] ?? '').replace(/<[^>]+>/g, '').trim());
}
