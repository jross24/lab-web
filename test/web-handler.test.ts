import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FetchLike } from '../lib/upstream.ts';
import { createHandler } from '../lib/web-handler.ts';
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
