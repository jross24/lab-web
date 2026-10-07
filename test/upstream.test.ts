import { describe, expect, it } from 'vitest';
import { fetchAccount, fetchCatalogue, UpstreamError } from '../lib/upstream.ts';
import type { FetchLike } from '../lib/upstream.ts';
import { accountBody, catalogueBody } from './fixtures.ts';

const BASE = 'https://catalogue.example.test';
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// A fetch that does not answer. It fails when the timeout signal fires, like the real fetch.
const silent: FetchLike = (_url, init) =>
  new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason));
  });

const options = (fetch: FetchLike) => ({ fetch, timeoutMs: 20 });

describe('fetchCatalogue', () => {
  it('calls GET /products on the base URL and returns the checked data', async () => {
    const urls: string[] = [];
    const data = await fetchCatalogue(BASE, options(async (url) => (urls.push(url), json(catalogueBody))));
    expect(urls).toEqual([`${BASE}/products`]);
    expect(data).toEqual({
      version: '0.2.0',
      core: { version: '0.1.0', itemCount: 3 },
      products: catalogueBody.products,
    });
  });

  it('keeps one slash when the base URL ends with a slash', async () => {
    const urls: string[] = [];
    await fetchCatalogue(`${BASE}/`, options(async (url) => (urls.push(url), json(catalogueBody))));
    expect(urls).toEqual([`${BASE}/products`]);
  });

  it('throws an error with the HTTP status when the status is not 200', async () => {
    const error = await fetchCatalogue(BASE, options(async () => json({ secret: 'role arn:aws:iam::1:role/x' }, 503))).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(UpstreamError);
    expect((error as UpstreamError).message).toBe('HTTP 503');
  });

  it('throws a timeout error when the API does not answer in time', async () => {
    await expect(fetchCatalogue(BASE, options(silent))).rejects.toThrow('the request timed out');
  });

  it('throws a safe error when the request fails', async () => {
    const failing: FetchLike = async () => {
      throw new TypeError('connect ECONNREFUSED 10.0.0.1:443');
    };
    const error = await fetchCatalogue(BASE, options(failing)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UpstreamError);
    expect((error as UpstreamError).message).toBe('the request failed');
    expect(((error as UpstreamError).cause as Error).message).toContain('ECONNREFUSED');
  });

  it.each([
    ['not JSON', async () => new Response('<html>nope</html>', { status: 200 })],
    ['a JSON null', async () => json(null)],
    ['no products', async () => json({ ...catalogueBody, products: undefined })],
    ['a product with no price', async () => json({ ...catalogueBody, products: [{ id: 'p', name: 'n' }] })],
    ['no core block', async () => json({ ...catalogueBody, core: undefined })],
    ['no version', async () => json({ ...catalogueBody, version: 3 })],
  ])('throws a safe error for an answer that is %s', async (_name, answer) => {
    const error = await fetchCatalogue(BASE, options(answer)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UpstreamError);
    expect((error as UpstreamError).message).toBe('an answer that this page does not understand');
  });
});

describe('fetchAccount', () => {
  it('calls GET /profile on the base URL and returns the checked data', async () => {
    const urls: string[] = [];
    const data = await fetchAccount(BASE, options(async (url) => (urls.push(url), json(accountBody))));
    expect(urls).toEqual([`${BASE}/profile`]);
    expect(data).toEqual({
      version: '0.3.0',
      core: { version: '0.1.0', itemCount: 3 },
      profile: { id: 'user-1', name: 'First user', plan: 'free' },
    });
  });

  it('throws a safe error for an answer with no profile', async () => {
    await expect(fetchAccount(BASE, options(async () => json({ ...accountBody, profile: undefined })))).rejects.toThrow(
      'an answer that this page does not understand',
    );
  });

  it('throws a timeout error when the API does not answer in time', async () => {
    await expect(fetchAccount(BASE, options(silent))).rejects.toThrow('the request timed out');
  });
});
