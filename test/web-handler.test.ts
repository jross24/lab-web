import type { APIGatewayProxyEventV2, Context } from 'aws-lambda';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import type { ReadableSpan } from '@opentelemetry/sdk-trace';
import type { Signals } from '../lib/instrument.ts';
import { Tracing } from '../lib/tracing.ts';
import type { FetchLike } from '../lib/upstream.ts';
import { createHandler, handler } from '../lib/web-handler.ts';
import { accountBody, catalogueBody, textsOf, WEB_VERSION } from './fixtures.ts';

const ENV = {
  VERSION: WEB_VERSION,
  CATALOGUE_URL: 'https://catalogue.example.test',
  ACCOUNT_URL: 'https://account.example.test',
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Answer = Response | Error | 'silent';

// A fake fetch that answers by URL. It records each call.
function fakeFetch(answers: { catalogue: Answer; account: Answer }) {
  const calls: string[] = [];
  const send: FetchLike = (url, init) => {
    calls.push(url);
    const answer = url.startsWith(ENV.CATALOGUE_URL) ? answers.catalogue : answers.account;
    if (answer === 'silent') {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason));
      });
    }
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer.clone());
  };
  return { send, calls };
}

function handlerFor(answers: { catalogue: Answer; account: Answer }, env: Record<string, string | undefined> = ENV) {
  const { send, calls } = fakeFetch(answers);
  return { handle: createHandler({ fetch: send, env, timeoutMs: 20 }), calls };
}

const page = { rawPath: '/' };

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('GET / when both APIs answer', () => {
  it('returns status 200 and HTML', async () => {
    const { handle } = handlerFor({ catalogue: json(catalogueBody), account: json(accountBody) });
    const response = await handle(page);
    expect(response.statusCode).toBe(200);
    expect(response.headers).toMatchObject({ 'content-type': 'text/html; charset=utf-8' });
  });

  it('calls the two APIs, one time each', async () => {
    const { handle, calls } = handlerFor({ catalogue: json(catalogueBody), account: json(accountBody) });
    await handle(page);
    expect([...calls].sort()).toEqual([
      'https://account.example.test/profile',
      'https://catalogue.example.test/products',
    ]);
  });

  it('shows the four versions, the products and the profile name', async () => {
    const { handle } = handlerFor({ catalogue: json(catalogueBody), account: json(accountBody) });
    const html = (await handle(page)).body;
    expect(textsOf(html, 'web-version')).toEqual(['1.2.3']);
    expect(textsOf(html, 'catalogue-version')).toEqual(['0.2.0']);
    expect(textsOf(html, 'account-version')).toEqual(['0.3.0']);
    expect(textsOf(html, 'core-version')).toEqual(['0.1.0']);
    expect(textsOf(html, 'product')).toEqual(['First product 10', 'Second product 20']);
    expect(textsOf(html, 'profile-name')).toEqual(['First user']);
  });

  it('calls the two APIs at the same time', async () => {
    // Both calls start before one of them ends.
    const started: string[] = [];
    const send: FetchLike = async (url) => {
      started.push(url);
      await new Promise((resolve) => setTimeout(resolve, 10));
      return json(url.endsWith('/products') ? catalogueBody : accountBody);
    };
    const pending = createHandler({ fetch: send, env: ENV, timeoutMs: 1000 })(page);
    await Promise.resolve();
    expect(started).toHaveLength(2);
    await pending;
  });

  it('shows the version "unknown" when the environment has no version', async () => {
    const { handle } = handlerFor(
      { catalogue: json(catalogueBody), account: json(accountBody) },
      { ...ENV, VERSION: undefined },
    );
    expect(textsOf((await handle(page)).body, 'web-version')).toEqual(['unknown']);
  });
});

describe('GET / when one API fails', () => {
  it('returns 200 with an error block for the catalogue when it answers with HTTP 500', async () => {
    const { handle } = handlerFor({ catalogue: json({ error: 'boom' }, 500), account: json(accountBody) });
    const response = await handle(page);
    const html = response.body;
    expect(response.statusCode).toBe(200);
    expect(textsOf(html, 'catalogue-error')).toHaveLength(1);
    expect(textsOf(html, 'account-error')).toEqual([]);
    expect(textsOf(html, 'product')).toEqual([]);
    expect(textsOf(html, 'profile-name')).toEqual(['First user']);
  });

  it('returns 200 with an error block for the account when it does not answer in time', async () => {
    const { handle } = handlerFor({ catalogue: json(catalogueBody), account: 'silent' });
    const response = await handle(page);
    const html = response.body;
    expect(response.statusCode).toBe(200);
    expect(textsOf(html, 'account-error')[0]).toContain('the request timed out');
    expect(textsOf(html, 'catalogue-error')).toEqual([]);
    expect(textsOf(html, 'product')).toHaveLength(2);
    expect(textsOf(html, 'profile-name')).toEqual([]);
  });

  it('returns 200 when one API sends a body that the page does not understand', async () => {
    const { handle } = handlerFor({ catalogue: json({ nothing: true }), account: json(accountBody) });
    const response = await handle(page);
    expect(response.statusCode).toBe(200);
    expect(textsOf(response.body, 'catalogue-error')[0]).toContain('does not understand');
  });

  it('returns 200 when the URL of one API is not set', async () => {
    const { handle, calls } = handlerFor(
      { catalogue: json(catalogueBody), account: json(accountBody) },
      { ...ENV, ACCOUNT_URL: undefined },
    );
    const response = await handle(page);
    expect(response.statusCode).toBe(200);
    expect(textsOf(response.body, 'account-error')[0]).toContain('not set');
    expect(calls).toEqual(['https://catalogue.example.test/products']);
  });

  it('does not copy the body of the failed answer into the HTML, and logs the failure', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const secret = 'role secret-role is not allowed';
    const { handle } = handlerFor({ catalogue: json({ message: secret }, 403), account: json(accountBody) });
    const html = (await handle(page)).body;
    expect(html).not.toContain('secret-role');
    expect(log).toHaveBeenCalled();
  });

  it('does not copy the message of a network error into the HTML', async () => {
    const { handle } = handlerFor({
      catalogue: new TypeError('connect ECONNREFUSED 10.1.2.3:443'),
      account: json(accountBody),
    });
    const html = (await handle(page)).body;
    expect(html).not.toContain('ECONNREFUSED');
    expect(html).not.toContain('10.1.2.3');
    expect(textsOf(html, 'catalogue-error')[0]).toContain('the request failed');
  });
});

describe('GET / when both APIs fail', () => {
  it('returns status 502 and an HTML error page', async () => {
    const { handle } = handlerFor({ catalogue: json({}, 500), account: 'silent' });
    const response = await handle(page);
    const html = response.body;
    expect(response.statusCode).toBe(502);
    expect(response.headers).toMatchObject({ 'content-type': 'text/html; charset=utf-8' });
    expect(html).toContain('502 Bad gateway');
    expect(textsOf(html, 'catalogue-error')[0]).toContain('HTTP 500');
    expect(textsOf(html, 'account-error')[0]).toContain('the request timed out');
  });

  it('returns status 502 when no URL is set', async () => {
    const { handle, calls } = handlerFor(
      { catalogue: json(catalogueBody), account: json(accountBody) },
      { VERSION: WEB_VERSION },
    );
    expect((await handle(page)).statusCode).toBe(502);
    expect(calls).toEqual([]);
  });
});

describe('GET /health', () => {
  it('returns the service and the version as JSON and calls no API', async () => {
    const { handle, calls } = handlerFor({ catalogue: new Error('never'), account: new Error('never') });
    const response = await handle({ rawPath: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.headers).toMatchObject({ 'content-type': 'application/json' });
    expect(JSON.parse(response.body)).toEqual({ service: 'web', version: '1.2.3' });
    expect(calls).toEqual([]);
  });

  it('works when no URL is set', async () => {
    const { handle } = handlerFor({ catalogue: new Error('never'), account: new Error('never') }, { VERSION: '2.0.0' });
    expect(JSON.parse((await handle({ rawPath: '/health' })).body)).toEqual({
      service: 'web',
      version: '2.0.0',
    });
  });
});

describe('the signals of the handler', () => {
  // The wrapper gives the handler an object for the signals. The handler sets "degraded" when it
  // handled a failure and still answered with a good status. See Signals in lib/instrument.ts.
  async function signalsOf(answers: { catalogue: Answer; account: Answer }, request = page): Promise<Signals> {
    const signals: Signals = {};
    const { handle } = handlerFor(answers);
    await handle(request, signals);
    return signals;
  }

  it('leaves degraded unset when both APIs answer', async () => {
    expect(await signalsOf({ catalogue: json(catalogueBody), account: json(accountBody) })).toEqual({});
  });

  it('sets degraded to the safe reason of the catalogue when only the catalogue fails', async () => {
    const signals = await signalsOf({ catalogue: 'silent', account: json(accountBody) });
    expect(signals.degraded).toBe('catalogue: the request timed out');
  });

  it('sets degraded to the safe reason of the account when only the account fails', async () => {
    const signals = await signalsOf({ catalogue: json(catalogueBody), account: json({ error: 'boom' }, 500) });
    expect(signals.degraded).toBe('account: HTTP 500');
  });

  it('uses the same reason as the error block of the page', async () => {
    const { handle } = handlerFor({ catalogue: json({ nothing: true }), account: json(accountBody) });
    const signals: Signals = {};
    const html = (await handle(page, signals)).body;
    expect(signals.degraded).toBe('catalogue: an answer that this page does not understand');
    expect(textsOf(html, 'catalogue-error')[0]).toContain('an answer that this page does not understand');
  });

  it('does not copy the body or the network error of a failed call into degraded', async () => {
    const body = await signalsOf({
      catalogue: json({ message: 'role secret-role is not allowed' }, 403),
      account: json(accountBody),
    });
    expect(body.degraded).toBe('catalogue: HTTP 403');
    const network = await signalsOf({
      catalogue: json(catalogueBody),
      account: new TypeError('connect ECONNREFUSED 10.1.2.3:443'),
    });
    expect(network.degraded).toBe('account: the request failed');
    expect(JSON.stringify([body, network])).not.toMatch(/secret-role|ECONNREFUSED|10\.1\.2\.3/);
  });

  it('leaves degraded unset when both APIs fail, because the status 502 is already an error', async () => {
    const signals: Signals = {};
    const { handle } = handlerFor({ catalogue: json({}, 500), account: json({}, 503) });
    expect((await handle(page, signals)).statusCode).toBe(502);
    expect(signals).toEqual({});
  });

  it('leaves degraded unset for GET /health', async () => {
    const signals = await signalsOf(
      { catalogue: new Error('never'), account: new Error('never') },
      { rawPath: '/health' },
    );
    expect(signals).toEqual({});
  });

  it('works when the caller gives no signals', async () => {
    const { handle } = handlerFor({ catalogue: 'silent', account: json(accountBody) });
    expect((await handle(page)).statusCode).toBe(200);
  });
});

describe('the exported handler: the log line and the metric line', () => {
  const EVENT = { rawPath: '/', routeKey: 'GET /' } as APIGatewayProxyEventV2;
  const HEALTH_EVENT = { rawPath: '/health', routeKey: 'GET /health' } as APIGatewayProxyEventV2;
  const CONTEXT = { awsRequestId: 'req-9' } as Context;
  const CATALOGUE_URL = 'https://catalogue.example.test';
  const ACCOUNT_URL = 'https://account.example.test';

  let written: string[];
  let requested: string[];

  // Collect what the handler writes to stdout. The test environment is not Lambda, so the variables are stubs.
  beforeEach(() => {
    written = [];
    requested = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    });
    vi.stubEnv('VERSION', WEB_VERSION);
    vi.stubEnv('CATALOGUE_URL', CATALOGUE_URL);
    vi.stubEnv('ACCOUNT_URL', ACCOUNT_URL);
  });

  function stubUpstreams(answers: { catalogue: () => Response; account: () => Response }): void {
    vi.stubGlobal('fetch', (url: string): Promise<Response> => {
      requested.push(url);
      return Promise.resolve(url.startsWith(CATALOGUE_URL) ? answers.catalogue() : answers.account());
    });
  }

  const healthy = { catalogue: () => json(catalogueBody), account: () => json(accountBody) };

  function lines(): Record<string, unknown>[] {
    return written.map((chunk) => JSON.parse(chunk) as Record<string, unknown>);
  }

  it('counts a healthy page as no error, and writes no degraded reason', async () => {
    stubUpstreams(healthy);
    const response = await handler(EVENT, CONTEXT);
    expect(response.statusCode).toBe(200);
    expect(lines()).toHaveLength(2);
    const [log, metric] = lines();
    expect(log).toMatchObject({ level: 'INFO', service: 'web', version: WEB_VERSION, route: 'GET /', status: 200 });
    expect(log).not.toHaveProperty('degraded');
    expect(metric).toMatchObject({ service: 'web', version: WEB_VERSION, requests: 1, errors: 0 });
  });

  it('counts a degraded page as an error, and logs it as a warning with the safe reason', async () => {
    // One API fails. The page is HTTP 200 with an error block. The user sees an error, so the release gate must see it.
    stubUpstreams({
      catalogue: () => json({ message: 'role secret-role is not allowed' }, 503),
      account: healthy.account,
    });
    const response = await handler(EVENT, CONTEXT);
    expect(response.statusCode).toBe(200);
    const [log, metric] = lines();
    expect(log).toMatchObject({ level: 'WARN', status: 200, degraded: 'catalogue: HTTP 503' });
    expect(metric).toMatchObject({ service: 'web', version: WEB_VERSION, requests: 1, errors: 1 });
    expect(written.join('')).not.toContain('secret-role');
  });

  it('counts a page with two failed APIs as an error with the level ERROR', async () => {
    stubUpstreams({ catalogue: () => json({}, 500), account: () => json({}, 500) });
    const response = await handler(EVENT, CONTEXT);
    expect(response.statusCode).toBe(502);
    const [log, metric] = lines();
    expect(log).toMatchObject({ level: 'ERROR', status: 502 });
    expect(metric).toMatchObject({ errors: 1 });
  });

  it('counts GET /health as no error, and calls no API', async () => {
    stubUpstreams({ catalogue: () => json({}, 500), account: () => json({}, 500) });
    const response = await handler(HEALTH_EVENT, CONTEXT);
    expect(response.statusCode).toBe(200);
    const [log, metric] = lines();
    expect(log).toMatchObject({ level: 'INFO', route: 'GET /health', status: 200 });
    expect(log).not.toHaveProperty('degraded');
    expect(metric).toMatchObject({ requests: 1, errors: 0 });
    expect(requested).toEqual([]);
  });

  it('marks only the call that was degraded, and not the next call', async () => {
    stubUpstreams({ catalogue: () => json({}, 500), account: healthy.account });
    await handler(EVENT, CONTEXT);
    stubUpstreams(healthy);
    await handler(EVENT, CONTEXT);
    const [firstLog, firstMetric, secondLog, secondMetric] = lines();
    expect(firstLog).toMatchObject({ degraded: 'catalogue: HTTP 500' });
    expect(firstMetric).toMatchObject({ errors: 1 });
    expect(secondLog).not.toHaveProperty('degraded');
    expect(secondMetric).toMatchObject({ errors: 0 });
  });
});

describe('the fault switch', () => {
  const EVENT = { rawPath: '/', routeKey: 'GET /' } as APIGatewayProxyEventV2;
  const HEALTH_EVENT = { rawPath: '/health', routeKey: 'GET /health' } as APIGatewayProxyEventV2;
  const CONTEXT = { awsRequestId: 'req-9' } as Context;

  let written: string[];

  beforeEach(() => {
    written = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    });
  });

  it.each([
    ['GET /', EVENT],
    ['GET /health', HEALTH_EVENT],
  ])('throws on %s when INJECT_FAULT is "true", so that Lambda counts an error', async (_route, event) => {
    // The release gate needs a failure that Lambda counts. /health fails too, because it is a route of the service.
    vi.stubEnv('INJECT_FAULT', 'true');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(handler(event, CONTEXT)).rejects.toThrow(/injected fault/);
    expect(JSON.parse(written[0] ?? '')).toMatchObject({ level: 'ERROR', status: 500 });
    expect(JSON.parse(written[1] ?? '')).toMatchObject({ errors: 1 });
    // The fault comes first: no API call.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('throws from createHandler too, for both routes', async () => {
    vi.stubEnv('INJECT_FAULT', 'true');
    const { handle } = handlerFor({ catalogue: json(catalogueBody), account: json(accountBody) });
    await expect(handle(page)).rejects.toThrow(/injected fault/);
    await expect(handle({ rawPath: '/health' })).rejects.toThrow(/injected fault/);
  });

  it.each([undefined, 'false', 'TRUE', '1', ''])('does not throw when INJECT_FAULT is %j', async (value) => {
    vi.stubEnv('INJECT_FAULT', value);
    const { handle } = handlerFor({ catalogue: json(catalogueBody), account: json(accountBody) });
    expect((await handle(page)).statusCode).toBe(200);
    expect((await handle({ rawPath: '/health' })).statusCode).toBe(200);
  });
});

describe('GET / with tracing', () => {
  const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
  const PARENT = '00f067aa0ba902b7';
  const TRACEPARENT = `00-${TRACE}-${PARENT}-01`;
  const healthy = { catalogue: json(catalogueBody), account: json(accountBody) };

  // A fake fetch that records the headers of each call and answers after a short pause.
  function tracedSetup(answers: { catalogue: Answer; account: Answer } = healthy) {
    const memory = new InMemorySpanExporter();
    const tracing = Tracing.create({ service: 'web', version: WEB_VERSION, exporter: memory });
    const requests: { url: string; traceparent: string | undefined }[] = [];
    const send: FetchLike = async (url, init) => {
      requests.push({ url, traceparent: init.headers?.traceparent });
      await new Promise((resolve) => setTimeout(resolve, 5));
      const answer = url.startsWith(ENV.CATALOGUE_URL) ? answers.catalogue : answers.account;
      if (answer instanceof Error) throw answer;
      if (answer === 'silent') {
        return new Promise<Response>((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(init.signal.reason));
        });
      }
      return answer.clone();
    };
    const handle = createHandler({ fetch: send, env: ENV, timeoutMs: 100, tracing });
    const spans = (kind: SpanKind): ReadableSpan[] => memory.getFinishedSpans().filter((span) => span.kind === kind);
    return { handle, memory, requests, spans, tracing };
  }

  it('records one server span and two client spans, and both client spans are children of the server span', async () => {
    const { handle, spans, tracing } = tracedSetup();
    await tracing.serve({ name: 'GET /', headers: { traceparent: TRACEPARENT } }, () => handle(page));
    expect(spans(SpanKind.SERVER)).toHaveLength(1);
    expect(spans(SpanKind.CLIENT)).toHaveLength(2);
    const server = spans(SpanKind.SERVER)[0] as ReadableSpan;
    // Promise.all starts both calls at the same time. Neither client span may become the parent of the other.
    for (const client of spans(SpanKind.CLIENT)) {
      expect(client.parentSpanContext?.spanId).toBe(server.spanContext().spanId);
      expect(client.spanContext().traceId).toBe(TRACE);
    }
    expect(
      spans(SpanKind.CLIENT)
        .map((span) => span.name)
        .sort(),
    ).toEqual(['GET account.example.test', 'GET catalogue.example.test']);
  });

  it('puts a traceparent with the same trace ID on both requests, each with the span ID of its own client span', async () => {
    const { handle, requests, spans, tracing } = tracedSetup();
    await tracing.serve({ name: 'GET /' }, () => handle(page));
    expect(requests).toHaveLength(2);
    const traceIds = requests.map((request) => request.traceparent?.split('-')[1]);
    expect(traceIds[0]).toMatch(/^[0-9a-f]{32}$/);
    expect(traceIds[1]).toBe(traceIds[0]);
    for (const request of requests) {
      const client = spans(SpanKind.CLIENT).find((span) => span.name === `GET ${new URL(request.url).host}`) as ReadableSpan;
      expect(request.traceparent).toBe(`00-${traceIds[0]}-${client.spanContext().spanId}-01`);
    }
    expect(requests[0]?.traceparent).not.toBe(requests[1]?.traceparent);
  });

  it('returns the same page as without tracing', async () => {
    const plain = handlerFor({ catalogue: json(catalogueBody), account: json(accountBody) });
    const { handle, tracing } = tracedSetup();
    const withTracing = await tracing.serve({ name: 'GET /' }, () => handle(page));
    expect(withTracing).toEqual(await plain.handle(page));
  });

  it('marks only the client span of the failed API as an error, and the page still has its error block', async () => {
    const { handle, spans, tracing } = tracedSetup({ catalogue: json({ error: 'boom' }, 503), account: json(accountBody) });
    const response = await tracing.serve({ name: 'GET /' }, () => handle(page));
    expect(response.statusCode).toBe(200);
    expect(textsOf(response.body, 'catalogue-error')[0]).toContain('HTTP 503');
    const status = (name: string): SpanStatusCode | undefined => spans(SpanKind.CLIENT).find((span) => span.name === name)?.status.code;
    expect(status('GET catalogue.example.test')).toBe(SpanStatusCode.ERROR);
    expect(status('GET account.example.test')).toBe(SpanStatusCode.UNSET);
  });

  it('records a call that times out as an error on its client span', async () => {
    const { handle, spans, tracing } = tracedSetup({ catalogue: json(catalogueBody), account: 'silent' });
    const response = await tracing.serve({ name: 'GET /' }, () => handle(page));
    expect(textsOf(response.body, 'account-error')[0]).toContain('the request timed out');
    expect(spans(SpanKind.CLIENT).find((span) => span.name === 'GET account.example.test')?.status.code).toBe(SpanStatusCode.ERROR);
  });

  it('makes no client span for GET /health', async () => {
    const { handle, requests, spans, tracing } = tracedSetup();
    await tracing.serve({ name: 'GET /health' }, () => handle({ rawPath: '/health' }));
    expect(spans(SpanKind.CLIENT)).toHaveLength(0);
    expect(requests).toEqual([]);
  });

  it('keeps the calls of two pages at the same time in their own traces', async () => {
    const { handle, requests, spans, tracing } = tracedSetup();
    const first = `00-${'a'.repeat(32)}-${PARENT}-01`;
    const second = `00-${'b'.repeat(32)}-${PARENT}-01`;
    await Promise.all([
      tracing.serve({ name: 'GET /', headers: { traceparent: first } }, () => handle(page)),
      tracing.serve({ name: 'GET /', headers: { traceparent: second } }, () => handle(page)),
    ]);
    expect(requests).toHaveLength(4);
    const clientsOf = (letter: string): ReadableSpan[] =>
      spans(SpanKind.CLIENT).filter((span) => span.spanContext().traceId === letter.repeat(32));
    expect(clientsOf('a')).toHaveLength(2);
    expect(clientsOf('b')).toHaveLength(2);
    expect(requests.filter((request) => request.traceparent?.includes(`-${'a'.repeat(32)}-`))).toHaveLength(2);
    expect(requests.filter((request) => request.traceparent?.includes(`-${'b'.repeat(32)}-`))).toHaveLength(2);
  });
});

describe('the exported handler with the tracing of Lambda', () => {
  const EVENT = {
    rawPath: '/',
    routeKey: 'GET /',
    headers: {},
    requestContext: { http: { method: 'GET' } },
  } as unknown as APIGatewayProxyEventV2;
  const CONTEXT = { awsRequestId: 'req-9' } as Context;

  interface SentSpan {
    readonly name: string;
    readonly traceId: string;
    readonly spanId: string;
    readonly parentSpanId?: string;
  }

  it('traces the two calls with the tracing that the wrapper makes, and exports the spans to X-Ray', async () => {
    // Lambda sets these variables. The tracing is on only when the function name is set.
    vi.stubEnv('AWS_LAMBDA_FUNCTION_NAME', 'lab-web-function');
    vi.stubEnv('AWS_REGION', 'eu-west-2');
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'AKIDEXAMPLE');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'secret');
    vi.stubEnv('VERSION', WEB_VERSION);
    vi.stubEnv('CATALOGUE_URL', ENV.CATALOGUE_URL);
    vi.stubEnv('ACCOUNT_URL', ENV.ACCOUNT_URL);
    const written: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    });
    const sent: { url: string; headers: Record<string, string>; body: string | undefined }[] = [];
    vi.stubGlobal('fetch', (url: string, init: { headers?: Record<string, string>; body?: string }): Promise<Response> => {
      sent.push({ url, headers: init.headers ?? {}, body: init.body });
      if (url.startsWith('https://xray.')) return Promise.resolve(new Response('{}'));
      return Promise.resolve(url.startsWith(ENV.CATALOGUE_URL) ? json(catalogueBody) : json(accountBody));
    });

    // The wrapper makes the tracing when the module loads, so load a new copy of the module now.
    vi.resetModules();
    const { handler: tracedHandler } = await import('../lib/web-handler.ts');
    const response = await tracedHandler(EVENT, CONTEXT);
    expect(response.statusCode).toBe(200);

    const upstream = sent.filter((call) => !call.url.startsWith('https://xray.'));
    const exports = sent.filter((call) => call.url === 'https://xray.eu-west-2.amazonaws.com/v1/traces');
    expect(upstream).toHaveLength(2);
    expect(exports).toHaveLength(1);

    const body = JSON.parse(exports[0]?.body ?? '') as { resourceSpans: { scopeSpans: { spans: SentSpan[] }[] }[] };
    const spans = body.resourceSpans.flatMap((resource) => resource.scopeSpans.flatMap((scope) => scope.spans));
    expect(spans.map((span) => span.name).sort()).toEqual(['GET /', 'GET account.example.test', 'GET catalogue.example.test']);
    const server = spans.find((span) => span.name === 'GET /');
    for (const call of upstream) {
      const [, traceId, spanId] = (call.headers.traceparent ?? '').split('-');
      const client = spans.find((span) => span.spanId === spanId);
      expect(traceId).toBe(server?.traceId);
      expect(client?.parentSpanId).toBe(server?.spanId);
    }
    // The two APIs are public, so their requests carry the header traceparent and nothing else.
    expect(upstream.map((call) => Object.keys(call.headers))).toEqual([['traceparent'], ['traceparent']]);

    const log = JSON.parse(written[0] ?? '') as { traceId: string };
    const id = server?.traceId ?? '';
    expect(log.traceId).toBe(`1-${id.slice(0, 8)}-${id.slice(8)}`);
  });
});
