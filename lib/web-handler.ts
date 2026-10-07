import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { instrument } from './instrument.ts';
import type { Signals } from './instrument.ts';
import { renderErrorPage, renderPage } from './page.tsx';
import { fetchAccount, fetchCatalogue, UpstreamError } from './upstream.ts';
import type { FetchLike, Section } from './upstream.ts';

type WebResponse = APIGatewayProxyStructuredResultV2 & { readonly statusCode: number; readonly body: string };

const SERVICE = 'web';
const TIMEOUT_MS = 5000;
const HTML = 'text/html; charset=utf-8';

export interface HandlerOptions {
  readonly fetch?: FetchLike;
  readonly env?: Record<string, string | undefined>;
  readonly timeoutMs?: number;
}

// The one place where the service fails on purpose. The stage config sets INJECT_FAULT for a stage.
// It is a device for the release drill, not a practice for production. See "The Production drill" in the README.
function failOnPurpose(): void {
  if (process.env.INJECT_FAULT === 'true') {
    throw new Error('injected fault: the stage config of this release sets injectFault');
  }
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

// The reason for a page that shows one error block. The reason is the safe text that the page shows.
// It never holds the body of an answer. The caller has handled the case of two failed APIs.
function degradedReason(catalogue: Section<unknown>, account: Section<unknown>): string | undefined {
  if (!catalogue.ok) return `catalogue: ${catalogue.reason}`;
  if (!account.ok) return `account: ${account.reason}`;
  return undefined;
}

// A test gives its own fetch and env, so it needs no network. The Lambda runtime uses the defaults.
// The caller can give `signals`. The handler then sets `signals.degraded` for a page with one error block.
// The page has the status 200, so the status alone does not show the failure. See Signals in instrument.ts.
export function createHandler(options: HandlerOptions = {}) {
  return async (event: Pick<APIGatewayProxyEventV2, 'rawPath'>, signals: Signals = {}): Promise<WebResponse> => {
    // This comes first, so an injected fault fails each route, also GET /health.
    failOnPurpose();
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
    // Exactly one API failed. The page has an error block, but the status is 200. Lambda sees no error.
    // The signal makes the wrapper log a warning and count an error, so the release gate sees what the user sees.
    const degraded = degradedReason(catalogue, account);
    if (degraded !== undefined) signals.degraded = degraded;
    return { statusCode: 200, headers, body: renderPage({ version, catalogue, account }) };
  };
}

// The wrapper writes one log line and one metric line for each request, and passes the signals to the handler.
const web = createHandler();
export const handler = instrument({ service: SERVICE }, (event, _context, signals) => web(event, signals));
