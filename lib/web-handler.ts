import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { renderErrorPage, renderPage } from './page.tsx';
import { fetchAccount, fetchCatalogue, UpstreamError } from './upstream.ts';
import type { FetchLike, Section } from './upstream.ts';

type WebResponse = APIGatewayProxyStructuredResultV2 & { readonly body: string };

const SERVICE = 'web';
const TIMEOUT_MS = 5000;
const HTML = 'text/html; charset=utf-8';

export interface HandlerOptions {
  readonly fetch?: FetchLike;
  readonly env?: Record<string, string | undefined>;
  readonly timeoutMs?: number;
}

// Runs one call to an API. A failure becomes a section with a safe reason. The log has the full error.
async function section<T>(name: string, call: () => Promise<T>): Promise<Section<T>> {
  try {
    return { ok: true, data: await call() };
  } catch (error) {
    console.error(`The ${name} service failed.`, error);
    return { ok: false, reason: error instanceof UpstreamError ? error.message : 'unexpected error' };
  }
}

function urlOf(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (!value) throw new UpstreamError(`the environment variable ${name} is not set`);
  return value;
}

// A test gives its own fetch and env, so it needs no network. The Lambda runtime uses the defaults.
export function createHandler(options: HandlerOptions = {}) {
  return async (event: Pick<APIGatewayProxyEventV2, 'rawPath'>): Promise<WebResponse> => {
    const env = options.env ?? process.env;
    // The stack sets VERSION at synth time, so the response shows which release runs.
    const version = env.VERSION ?? 'unknown';

    if (event.rawPath === '/health') {
      return {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ service: SERVICE, version }),
      };
    }

    const upstream = { fetch: options.fetch ?? fetch, timeoutMs: options.timeoutMs ?? TIMEOUT_MS };
    // Both calls start at once, so the slower API sets the time of the request.
    const [catalogue, account] = await Promise.all([
      section('catalogue', () => fetchCatalogue(urlOf(env, 'CATALOGUE_URL'), upstream)),
      section('account', () => fetchAccount(urlOf(env, 'ACCOUNT_URL'), upstream)),
    ]);

    // The page shows live data, so no cache may keep it.
    const headers = { 'content-type': HTML, 'cache-control': 'no-store' };
    if (!catalogue.ok && !account.ok) {
      return { statusCode: 502, headers, body: renderErrorPage({ catalogue: catalogue.reason, account: account.reason }) };
    }
    return { statusCode: 200, headers, body: renderPage({ version, catalogue, account }) };
  };
}

export const handler = createHandler();
