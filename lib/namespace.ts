// The context value `namespace` lets several copies of this service live in one account.
// The Dev stage reads it. The pipeline stages never do. See "Namespaces" in the README.

// The tag that marks every resource of a namespaced copy. It helps to find the resources and the cost of a copy.
export const NAMESPACE_TAG = 'lab-namespace';

// A letter first, then letters a-z, digits and hyphens. At most 20 characters. The code also refuses a hyphen at the end.
// The limit keeps the longest stack name (lab-web-<namespace>) far below the limit of CloudFormation.
const NAMESPACE = /^[a-z][a-z0-9-]{0,19}$/;

// The name of the context value is a parameter, so the message of catalogueNamespace and accountNamespace names the right value.
export function parseNamespace(value: unknown, contextValue = 'namespace'): string {
  if (typeof value !== 'string' || !NAMESPACE.test(value) || value.endsWith('-')) {
    throw new Error(
      `Context value ${contextValue} must be 1 to 20 characters: a letter a-z first, then letters a-z, digits and -, and no - at the end. Got ${JSON.stringify(value)}. Example: -c ${contextValue}=my-test`,
    );
  }
  return value;
}

// The names that must be unique in an account. Everything else in the stack gets its name from CloudFormation,
// and that name holds the stack name, so it is unique too.
export interface ServiceNames {
  readonly stackName: string;
  // The SSM parameter that holds the base URL of the application. A later end-to-end test reads it.
  readonly urlParameterName: string;
  // The SSM parameter that holds the version that the stack runs. The release workflow reads the one of the baseline copy.
  readonly versionParameterName: string;
  // The shared dashboard code names the dashboard lab-svc-<service>, so the baseline name is lab-svc-web.
  readonly dashboardName: string;
}

// With no namespace the names are the names of the baseline copy of the account. They never change.
export function namesFor(namespace?: string): ServiceNames {
  if (namespace === undefined) {
    return {
      stackName: 'lab-web',
      urlParameterName: '/lab/web/url',
      versionParameterName: '/lab/web/version',
      dashboardName: 'lab-svc-web',
    };
  }
  const valid = parseNamespace(namespace);
  return {
    stackName: `lab-web-${valid}`,
    urlParameterName: `/lab/ns/${valid}/web/url`,
    versionParameterName: `/lab/ns/${valid}/web/version`,
    dashboardName: `lab-svc-web-${valid}`,
  };
}

// The context values catalogueNamespace and accountNamespace point this service at a preview of a provider.
// They change what the service reads. They never change what it writes.
export interface ProviderNamespaces {
  readonly catalogueNamespace?: string;
  readonly accountNamespace?: string;
}

// The SSM parameters that the stack reads. A provider with no namespace is the baseline copy of the account.
export interface ProviderNames {
  readonly catalogueUrlParameterName: string;
  readonly accountUrlParameterName: string;
}

export function providerNamesFor(providers: ProviderNamespaces = {}): ProviderNames {
  const read = (service: string, contextValue: string, namespace: string | undefined): string =>
    namespace === undefined ? `/lab/${service}/url` : `/lab/ns/${parseNamespace(namespace, contextValue)}/${service}/url`;
  return {
    catalogueUrlParameterName: read('catalogue', 'catalogueNamespace', providers.catalogueNamespace),
    accountUrlParameterName: read('account', 'accountNamespace', providers.accountNamespace),
  };
}
