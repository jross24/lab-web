import { App } from 'aws-cdk-lib';
import { parseNamespace } from './namespace.ts';
import { WebStage } from './web-stage.ts';
import { DEV_STAGE, STAGES } from './stages.ts';

const DEFAULT_VERSION = '0.0.0-dev';
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/;

function readVersion(app: App): string {
  const version: unknown = app.node.tryGetContext('version') ?? DEFAULT_VERSION;
  if (typeof version !== 'string' || !VERSION.test(version)) {
    throw new Error(
      `Context value version must look like 1.2.3. Got ${JSON.stringify(version)}. Example: -c version=1.2.3`,
    );
  }
  return version;
}

function readDev(app: App): boolean {
  // The value is a string from the command line and a boolean from cdk.json.
  const dev: unknown = app.node.tryGetContext('dev') ?? false;
  if (dev === true || dev === 'true') return true;
  if (dev === false || dev === 'false') return false;
  throw new Error(`Context value dev must be true or false. Got ${JSON.stringify(dev)}. Example: -c dev=true`);
}

// Reads one of the namespace context values: namespace, catalogueNamespace or accountNamespace.
// The two provider values go through readProviderNamespace, which adds the rule about namespace.
function readNamespace(app: App, dev: boolean, contextValue: string): string | undefined {
  const namespace: unknown = app.node.tryGetContext(contextValue);
  if (namespace === undefined) return undefined;
  // A pipeline stage has fixed names and reads the baseline parameters. A namespace there would be an error that
  // nobody sees, so refuse it.
  if (!dev) {
    throw new Error(`Context value ${contextValue} works only with dev=true. Example: -c dev=true -c ${contextValue}=my-test`);
  }
  return parseNamespace(namespace, contextValue);
}

// Reads catalogueNamespace or accountNamespace.
function readProviderNamespace(app: App, dev: boolean, contextValue: string, namespace: string | undefined): string | undefined {
  const providerNamespace = readNamespace(app, dev, contextValue);
  // Without a namespace the copy is the baseline copy of the account. It must not point at a preview of a provider,
  // because the preview goes away when its pull request closes.
  if (providerNamespace !== undefined && namespace === undefined) {
    throw new Error(
      `Context value ${contextValue} works only together with namespace. Example: -c dev=true -c namespace=my-test -c ${contextValue}=pr-5`,
    );
  }
  return providerNamespace;
}

// Context values: version (default 0.0.0-dev), dev (default false), and only with dev=true these three:
// namespace (names of the copy, default none), catalogueNamespace and accountNamespace (which preview of a provider the
// copy reads, default none: the baseline copy of the provider). The two provider values need namespace too.
export function createApp(context?: Record<string, unknown>): App {
  const app = new App({ context });
  const version = readVersion(app);
  const dev = readDev(app);
  const namespace = readNamespace(app, dev, 'namespace');
  const catalogueNamespace = readProviderNamespace(app, dev, 'catalogueNamespace', namespace);
  const accountNamespace = readProviderNamespace(app, dev, 'accountNamespace', namespace);

  if (dev) {
    // Only the Dev stage, so a laptop cannot deploy a pipeline stage by accident.
    new WebStage(app, 'Dev', { version, config: DEV_STAGE, namespace, catalogueNamespace, accountNamespace });
    return app;
  }

  // One synth makes all three stages. The pipeline deploys each one from the same cdk.out.
  for (const [name, config] of Object.entries(STAGES)) {
    new WebStage(app, name, { version, config });
  }
  return app;
}
