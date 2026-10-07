import { describe, expect, it } from 'vitest';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import type { ReadableSpan } from '@opentelemetry/sdk-trace';
import { Tracing } from '../lib/tracing.ts';
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

describe('the calls with tracing', () => {
  const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
  const PARENT = '00f067aa0ba902b7';
  const TRACEPARENT = `00-${TRACE}-${PARENT}-01`;

  function traced() {
    const memory = new InMemorySpanExporter();
    const tracing = Tracing.create({ service: 'web', version: '1.2.3', exporter: memory });
    return { memory, tracing };
  }

  // Records the URL and the headers of each call.
  function recording(answer: () => Response = () => json(catalogueBody)) {
    const seen: { url: string; headers: Record<string, string> | undefined; signal: AbortSignal }[] = [];
    const send: FetchLike = (url, init) => {
      seen.push({ url, headers: init.headers, signal: init.signal });
      return Promise.resolve(answer());
    };
    return { seen, send };
  }

  const clientSpans = (spans: ReadableSpan[]): ReadableSpan[] => spans.filter((span) => span.kind === SpanKind.CLIENT);

  it('sends the call to the catalogue as a client span, and puts the header traceparent on the request', async () => {
    const { memory, tracing } = traced();
    const { seen, send } = recording();
    await tracing.serve({ name: 'GET /', headers: { traceparent: TRACEPARENT } }, () =>
      fetchCatalogue(BASE, { fetch: send, timeoutMs: 1000, tracing }),
    );
    const server = memory.getFinishedSpans().find((span) => span.kind === SpanKind.SERVER);
    const [client] = clientSpans(memory.getFinishedSpans());
    expect(clientSpans(memory.getFinishedSpans())).toHaveLength(1);
    expect(client?.name).toBe('GET catalogue.example.test');
    expect(client?.parentSpanContext?.spanId).toBe(server?.spanContext().spanId);
    expect(seen[0]?.url).toBe(`${BASE}/products`);
    expect(seen[0]?.headers).toEqual({ traceparent: `00-${TRACE}-${client?.spanContext().spanId}-01` });
  });

  it('sends the call to the account as a client span too', async () => {
    const { memory, tracing } = traced();
    const { seen, send } = recording(() => json(accountBody));
    await tracing.serve({ name: 'GET /' }, () => fetchAccount('https://account.example.test', { fetch: send, timeoutMs: 1000, tracing }));
    const [client] = clientSpans(memory.getFinishedSpans());
    expect(client?.name).toBe('GET account.example.test');
    expect(seen[0]?.headers?.traceparent).toContain(client?.spanContext().spanId);
  });

  it('keeps the time limit: the request still gets the abort signal', async () => {
    const { tracing } = traced();
    const { seen, send } = recording();
    await tracing.serve({ name: 'GET /' }, () => fetchCatalogue(BASE, { fetch: send, timeoutMs: 1000, tracing }));
    expect(seen[0]?.signal.aborted).toBe(false);
    const slow = traced();
    await slow.tracing.serve({ name: 'GET /' }, async () => {
      await expect(fetchCatalogue(BASE, { fetch: silent, timeoutMs: 20, tracing: slow.tracing })).rejects.toThrow('the request timed out');
    });
  });

  it('marks the client span as an error for HTTP 503, and still throws the same safe error', async () => {
    const { memory, tracing } = traced();
    const { send } = recording(() => json({ secret: 'role arn:aws:iam::1:role/x' }, 503));
    await tracing.serve({ name: 'GET /' }, async () => {
      const error = await fetchCatalogue(BASE, { fetch: send, timeoutMs: 1000, tracing }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UpstreamError);
      expect((error as UpstreamError).message).toBe('HTTP 503');
    });
    const [client] = clientSpans(memory.getFinishedSpans());
    expect(client?.status.code).toBe(SpanStatusCode.ERROR);
    expect(client?.attributes['http.response.status_code']).toBe(503);
  });

  it('records a network error on the client span, and still throws the same safe error', async () => {
    const { memory, tracing } = traced();
    const failing: FetchLike = () => Promise.reject(new TypeError('connect ECONNREFUSED 10.0.0.1:443'));
    await tracing.serve({ name: 'GET /' }, async () => {
      const error = await fetchCatalogue(BASE, { fetch: failing, timeoutMs: 1000, tracing }).catch((e: unknown) => e);
      expect((error as UpstreamError).message).toBe('the request failed');
    });
    expect(clientSpans(memory.getFinishedSpans())[0]?.status.code).toBe(SpanStatusCode.ERROR);
  });

  it('sends the request with no change when no server span is active', async () => {
    const { memory, tracing } = traced();
    const { seen, send } = recording();
    await fetchCatalogue(BASE, { fetch: send, timeoutMs: 1000, tracing });
    expect(memory.getFinishedSpans()).toHaveLength(0);
    expect(seen[0]?.headers).toBeUndefined();
  });

  it('uses the tracing of the function when the option is not set, and outside Lambda that is no tracing', async () => {
    const { seen, send } = recording();
    await fetchCatalogue(BASE, { fetch: send, timeoutMs: 1000 });
    expect(seen[0]?.headers).toBeUndefined();
  });
});
