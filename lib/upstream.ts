// The two public APIs that the page reads. Each function checks the answer, so the page can trust the shape.

import { currentTracing } from './tracing.ts';
import type { Tracing } from './tracing.ts';

export interface CoreSummary {
  readonly version: string;
  readonly itemCount: number;
}

export interface Product {
  readonly id: string;
  readonly name: string;
  readonly price: number;
  // A percentage. The catalogue sends it only while the flag show-discounts is on, so it is optional.
  readonly discount?: number;
}

export interface CatalogueData {
  readonly version: string;
  readonly core: CoreSummary;
  readonly products: readonly Product[];
}

export interface Profile {
  readonly id: string;
  readonly name: string;
  readonly plan: string;
}

export interface AccountData {
  readonly version: string;
  readonly core: CoreSummary;
  readonly profile: Profile;
}

// The result for one API. The reason is a short text that is safe to show on the page.
export type Section<T> = { readonly ok: true; readonly data: T } | { readonly ok: false; readonly reason: string };

// An error with a message that is safe to show on the page. The cause can hold more detail for the log.
export class UpstreamError extends Error {
  override readonly name = 'UpstreamError';
}

// The request that the page sends. The tracing adds the header traceparent to it, so the headers are optional.
export type FetchLike = (url: string, init: { signal: AbortSignal; headers?: Record<string, string> }) => Promise<Response>;

export interface UpstreamOptions {
  readonly fetch: FetchLike;
  readonly timeoutMs: number;
  // The default is the tracing of the function, which is read at each request (see tracing.ts).
  readonly tracing?: Tracing;
}

const UNDERSTOOD = 'an answer that this page does not understand';

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

function coreOf(value: unknown): CoreSummary | undefined {
  const core = record(value);
  if (typeof core?.version !== 'string' || typeof core.itemCount !== 'number') return undefined;
  return { version: core.version, itemCount: core.itemCount };
}

function productOf(value: unknown): Product | undefined {
  const product = record(value);
  if (typeof product?.id !== 'string' || typeof product.name !== 'string' || typeof product.price !== 'number') {
    return undefined;
  }
  const base = { id: product.id, name: product.name, price: product.price };
  // An absent discount adds no key, so a product without a discount looks as it did before.
  if (product.discount === undefined) return base;
  // A discount of another type breaks the contract of the catalogue, like a price of another type.
  return typeof product.discount === 'number' ? { ...base, discount: product.discount } : undefined;
}

function catalogueOf(body: unknown): CatalogueData | undefined {
  const answer = record(body);
  const core = coreOf(answer?.core);
  if (typeof answer?.version !== 'string' || !core || !Array.isArray(answer.products)) return undefined;
  const products = answer.products.map(productOf);
  if (products.some((product) => product === undefined)) return undefined;
  return { version: answer.version, core, products: products as Product[] };
}

function accountOf(body: unknown): AccountData | undefined {
  const answer = record(body);
  const core = coreOf(answer?.core);
  const profile = record(answer?.profile);
  if (typeof answer?.version !== 'string' || !core) return undefined;
  if (typeof profile?.id !== 'string' || typeof profile.name !== 'string' || typeof profile.plan !== 'string') {
    return undefined;
  }
  return { version: answer.version, core, profile: { id: profile.id, name: profile.name, plan: profile.plan } };
}

// One GET request with a time limit. The signal also covers the read of the body.
// Inside a traced request, the call is a client span and carries the header traceparent. The APIs are public,
// so the request has no signature and the header needs no special order.
// The page starts both calls at the same time. Each call reads the server span as its parent, so the two
// client spans are siblings.
async function getJson(url: string, options: UpstreamOptions, headers?: Record<string, string>): Promise<unknown> {
  const signal = AbortSignal.timeout(options.timeoutMs);
  const tracing = options.tracing ?? currentTracing();
  let response: Response;
  try {
    response = await tracing.fetch(options.fetch, url, headers ? { signal, headers } : { signal });
  } catch (cause) {
    throw new UpstreamError(signal.aborted ? 'the request timed out' : 'the request failed', { cause });
  }
  // The body of an error answer is not safe to show. Keep only the status.
  if (response.status !== 200) throw new UpstreamError(`HTTP ${response.status}`);
  try {
    return await response.json();
  } catch (cause) {
    throw new UpstreamError(signal.aborted ? 'the request timed out' : UNDERSTOOD, { cause });
  }
}

function join(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

// Calls GET /products of the catalogue API. The headers, if any, go on this request only.
export async function fetchCatalogue(
  baseUrl: string,
  options: UpstreamOptions,
  headers?: Record<string, string>,
): Promise<CatalogueData> {
  const data = catalogueOf(await getJson(join(baseUrl, '/products'), options, headers));
  if (!data) throw new UpstreamError(UNDERSTOOD);
  return data;
}

// Calls GET /profile of the account API.
export async function fetchAccount(baseUrl: string, options: UpstreamOptions): Promise<AccountData> {
  const data = accountOf(await getJson(join(baseUrl, '/profile'), options));
  if (!data) throw new UpstreamError(UNDERSTOOD);
  return data;
}
