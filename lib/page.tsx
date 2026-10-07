import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AccountData, CatalogueData, Section } from './upstream.ts';

// The page is pure: data in, markup out. It does no network call and reads no environment variable.
// renderToStaticMarkup makes plain HTML with no React marker, because no client code takes over the page.

const UNAVAILABLE = 'unavailable';

const STYLE = `
body { font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 40rem; padding: 0 1rem; line-height: 1.5; }
section { margin-bottom: 1.5rem; }
table { border-collapse: collapse; }
th, td { border: 1px solid #888; padding: 0.25rem 0.75rem; text-align: left; }
.error { border: 1px solid #b00020; color: #b00020; padding: 0.5rem 0.75rem; }
`;

export interface PageProps {
  readonly version: string;
  readonly catalogue: Section<CatalogueData>;
  readonly account: Section<AccountData>;
}

export interface ErrorPageProps {
  // The reason that each API failed. It is a safe text from lib/upstream.ts.
  readonly catalogue: string;
  readonly account: string;
}

function Document({ title, children }: { title: string; children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title}</title>
        <style>{STYLE}</style>
      </head>
      <body>
        <main>{children}</main>
      </body>
    </html>
  );
}

function ErrorBlock({ testId, service, reason }: { testId: string; service: string; reason: string }) {
  return (
    <p className="error" role="alert" data-testid={testId}>
      The {service} service is not available: {reason}.
    </p>
  );
}

function Products({ catalogue }: { catalogue: Section<CatalogueData> }) {
  return (
    <section>
      <h2>Products</h2>
      {catalogue.ok ? (
        <ul>
          {catalogue.data.products.map((product) => (
            <li key={product.id} data-testid="product">
              <span>{product.name}</span> <span>{product.price}</span>
            </li>
          ))}
        </ul>
      ) : (
        <ErrorBlock testId="catalogue-error" service="catalogue" reason={catalogue.reason} />
      )}
    </section>
  );
}

function ProfileSection({ account }: { account: Section<AccountData> }) {
  return (
    <section>
      <h2>Profile</h2>
      {account.ok ? (
        <p>
          <span data-testid="profile-name">{account.data.profile.name}</span> <span>({account.data.profile.plan})</span>
        </p>
      ) : (
        <ErrorBlock testId="account-error" service="account" reason={account.reason} />
      )}
    </section>
  );
}

// Both APIs report the version of core. Show one value when they agree, and both when they differ.
function coreVersion(catalogue: Section<CatalogueData>, account: Section<AccountData>): string {
  const viaCatalogue = catalogue.ok ? catalogue.data.core.version : undefined;
  const viaAccount = account.ok ? account.data.core.version : undefined;
  if (viaCatalogue !== undefined && viaAccount !== undefined && viaCatalogue !== viaAccount) {
    return `catalogue: ${viaCatalogue}, account: ${viaAccount}`;
  }
  return viaCatalogue ?? viaAccount ?? UNAVAILABLE;
}

function Versions({ version, catalogue, account }: PageProps) {
  const rows = [
    ['web', 'web-version', version],
    ['catalogue', 'catalogue-version', catalogue.ok ? catalogue.data.version : UNAVAILABLE],
    ['account', 'account-version', account.ok ? account.data.version : UNAVAILABLE],
    ['core', 'core-version', coreVersion(catalogue, account)],
  ] as const;
  return (
    <section>
      <h2>Versions</h2>
      <table>
        <tbody>
          {rows.map(([service, testId, value]) => (
            <tr key={service}>
              <th scope="row">{service}</th>
              <td data-testid={testId}>{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function render(element: ReactElement): string {
  // React 19 does not write the doctype for renderToStaticMarkup, so the page adds it.
  return `<!DOCTYPE html>${renderToStaticMarkup(element)}`;
}

// The page for a request where at least one API answered.
export function renderPage(props: PageProps): string {
  return render(
    <Document title="lab web">
      <h1>lab web</h1>
      <Products catalogue={props.catalogue} />
      <ProfileSection account={props.account} />
      <Versions {...props} />
    </Document>,
  );
}

// The page for a request where both APIs failed. The handler sends it with HTTP 502.
export function renderErrorPage(props: ErrorPageProps): string {
  return render(
    <Document title="502 Bad gateway">
      <h1>502 Bad gateway</h1>
      <ErrorBlock testId="catalogue-error" service="catalogue" reason={props.catalogue} />
      <ErrorBlock testId="account-error" service="account" reason={props.account} />
    </Document>,
  );
}
