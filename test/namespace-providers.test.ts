import { describe, expect, it } from 'vitest';
import { Template } from 'aws-cdk-lib/assertions';
import type { CloudFormationStackArtifact } from 'aws-cdk-lib/cx-api';
import { createApp } from '../lib/app.ts';
import { providerNamesFor } from '../lib/namespace.ts';

// The context values catalogueNamespace and accountNamespace point web at a preview of a provider.
// They change only what web reads. What web writes follows the context value namespace (namespace.test.ts).
// Each one needs namespace too: the baseline copy of web always reads the baseline providers.

interface TemplateShape {
  readonly Resources: Record<string, { readonly Type: string; readonly Properties?: Record<string, unknown> }>;
}

function synthDev(context: Record<string, unknown>): CloudFormationStackArtifact {
  const assembly = createApp({ dev: 'true', ...context }).synth();
  expect(assembly.stacksRecursively).toHaveLength(1);
  return assembly.stacksRecursively[0] as CloudFormationStackArtifact;
}

// The SSM parameters that the stack reads at deployment, by the logical ID of the template parameter.
function reads(stack: CloudFormationStackArtifact): Record<string, string> {
  const found = Template.fromJSON(stack.template as Record<string, unknown>).findParameters('*', {
    Type: 'AWS::SSM::Parameter::Value<String>',
  });
  const result: Record<string, string> = {};
  for (const [id, parameter] of Object.entries(found)) {
    const name = (parameter as { Default: string }).Default;
    // The bootstrap version is a parameter too. It is not an SSM parameter of the lab.
    if (name.startsWith('/lab/')) result[name] = id;
  }
  return result;
}

function writes(stack: CloudFormationStackArtifact): string[] {
  return Object.values((stack.template as TemplateShape).Resources)
    .filter((resource) => resource.Type === 'AWS::SSM::Parameter')
    .map((resource) => resource.Properties?.Name as string)
    .sort();
}

// The environment of the function: the two URLs come from the template parameters that read the SSM parameters.
function functionEnvironment(stack: CloudFormationStackArtifact): Record<string, unknown> {
  const functions = Object.values((stack.template as TemplateShape).Resources).filter((resource) => resource.Type === 'AWS::Lambda::Function');
  expect(functions).toHaveLength(1);
  return (functions[0]?.Properties?.Environment as { Variables: Record<string, unknown> }).Variables;
}

describe('providerNamesFor', () => {
  it('gives the baseline parameters when no provider has a namespace', () => {
    expect(providerNamesFor()).toEqual({
      catalogueUrlParameterName: '/lab/catalogue/url',
      accountUrlParameterName: '/lab/account/url',
    });
    expect(providerNamesFor({})).toEqual(providerNamesFor());
  });

  it('points one provider at its namespace and keeps the other at the baseline', () => {
    expect(providerNamesFor({ catalogueNamespace: 'pr-5' })).toEqual({
      catalogueUrlParameterName: '/lab/ns/pr-5/catalogue/url',
      accountUrlParameterName: '/lab/account/url',
    });
    expect(providerNamesFor({ accountNamespace: 'pr-7' })).toEqual({
      catalogueUrlParameterName: '/lab/catalogue/url',
      accountUrlParameterName: '/lab/ns/pr-7/account/url',
    });
  });

  it('points both providers at their own namespaces', () => {
    expect(providerNamesFor({ catalogueNamespace: 'pr-5', accountNamespace: 'laptop-test' })).toEqual({
      catalogueUrlParameterName: '/lab/ns/pr-5/catalogue/url',
      accountUrlParameterName: '/lab/ns/laptop-test/account/url',
    });
  });

  it('refuses a namespace that is not valid, and names the context value', () => {
    expect(() => providerNamesFor({ catalogueNamespace: 'Bad' })).toThrow(/Context value catalogueNamespace must be 1 to 20 characters/);
    expect(() => providerNamesFor({ accountNamespace: 'abc-' })).toThrow(/Context value accountNamespace must be 1 to 20 characters/);
  });
});

describe('the app with dev=true and no provider namespace', () => {
  it.each([
    ['no namespace', {}],
    ['a namespace', { namespace: 'pr-12' }],
  ])('reads catalogue and account from the baseline parameters with %s', (_label, context) => {
    expect(Object.keys(reads(synthDev(context))).sort()).toEqual(['/lab/account/url', '/lab/catalogue/url']);
  });
});

describe('the app with catalogueNamespace', () => {
  const stack = synthDev({ namespace: 'pr-12', catalogueNamespace: 'pr-5' });

  it('reads the URL of catalogue from the namespace of that preview and the URL of account from the baseline', () => {
    expect(Object.keys(reads(stack)).sort()).toEqual(['/lab/account/url', '/lab/ns/pr-5/catalogue/url']);
  });

  it('gives the function the value of that parameter in CATALOGUE_URL, and the baseline value in ACCOUNT_URL', () => {
    const ids = reads(stack);
    const environment = functionEnvironment(stack);
    expect(environment.CATALOGUE_URL).toEqual({ Ref: ids['/lab/ns/pr-5/catalogue/url'] });
    expect(environment.ACCOUNT_URL).toEqual({ Ref: ids['/lab/account/url'] });
  });

  it('writes only under its own namespace, and never under the namespace of a provider', () => {
    expect(writes(stack)).toEqual(['/lab/ns/pr-12/web/url', '/lab/ns/pr-12/web/version']);
  });
});

describe('the app with accountNamespace', () => {
  const stack = synthDev({ namespace: 'pr-12', accountNamespace: 'pr-7' });

  it('reads the URL of account from the namespace of that preview and the URL of catalogue from the baseline', () => {
    expect(Object.keys(reads(stack)).sort()).toEqual(['/lab/catalogue/url', '/lab/ns/pr-7/account/url']);
  });

  it('gives the function the value of that parameter in ACCOUNT_URL, and the baseline value in CATALOGUE_URL', () => {
    const ids = reads(stack);
    const environment = functionEnvironment(stack);
    expect(environment.ACCOUNT_URL).toEqual({ Ref: ids['/lab/ns/pr-7/account/url'] });
    expect(environment.CATALOGUE_URL).toEqual({ Ref: ids['/lab/catalogue/url'] });
  });
});

describe('the app with both provider namespaces', () => {
  it('reads both URLs from the namespaces of the providers', () => {
    const stack = synthDev({ namespace: 'pr-12', catalogueNamespace: 'pr-5', accountNamespace: 'pr-7' });
    expect(Object.keys(reads(stack)).sort()).toEqual(['/lab/ns/pr-5/catalogue/url', '/lab/ns/pr-7/account/url']);
    expect(JSON.stringify(stack.template)).not.toContain('/lab/catalogue/url');
    expect(JSON.stringify(stack.template)).not.toContain('/lab/account/url');
  });

  it('accepts the same namespace for both providers and for the copy itself', () => {
    const stack = synthDev({ namespace: 'pr-5', catalogueNamespace: 'pr-5', accountNamespace: 'pr-5' });
    expect(Object.keys(reads(stack)).sort()).toEqual(['/lab/ns/pr-5/account/url', '/lab/ns/pr-5/catalogue/url']);
    expect(writes(stack)).toEqual(['/lab/ns/pr-5/web/url', '/lab/ns/pr-5/web/version']);
  });
});

describe('a provider namespace on the baseline copy of web', () => {
  // The baseline copy has no namespace. A preview of a provider goes away when its pull request closes,
  // so a baseline copy that read it would call a dead URL. The app refuses the combination.
  it.each(['catalogueNamespace', 'accountNamespace'])('stops the app when %s is set without namespace', (name) => {
    expect(() => createApp({ dev: 'true', [name]: 'pr-5' })).toThrow(
      new RegExp(`Context value ${name} works only together with namespace`),
    );
  });

  it('stops the app when both provider namespaces are set without namespace', () => {
    expect(() => createApp({ dev: 'true', catalogueNamespace: 'pr-5', accountNamespace: 'pr-7' })).toThrow(
      /works only together with namespace/,
    );
  });

  it('names the fix in the message: set namespace too', () => {
    expect(() => createApp({ dev: 'true', catalogueNamespace: 'pr-5' })).toThrow(
      /Example: -c dev=true -c namespace=my-test -c catalogueNamespace=pr-5/,
    );
  });
});

describe('an invalid provider namespace', () => {
  it.each(['catalogueNamespace', 'accountNamespace'])('stops the app when %s is not valid', (name) => {
    for (const value of ['', 'A', 'Pr-12', '1abc', '-abc', 'abc-', 'a_b', 'abcdefghijklmnopqrstu', 12, true, null]) {
      expect(() => createApp({ dev: 'true', [name]: value }), `${name}=${JSON.stringify(value)}`).toThrow(
        new RegExp(`Context value ${name} must be 1 to 20 characters`),
      );
    }
  });

  it.each(['catalogueNamespace', 'accountNamespace'])('stops the app when %s is set without dev=true', (name) => {
    expect(() => createApp({ [name]: 'pr-5' })).toThrow(new RegExp(`${name} works only with dev=true`));
    expect(() => createApp({ dev: 'false', [name]: 'pr-5' })).toThrow(new RegExp(`${name} works only with dev=true`));
  });
});

describe('the pipeline stages', () => {
  it('read the baseline parameters and no other, because they never read a provider namespace', () => {
    const assembly = createApp().synth();
    const stacks = assembly.stacksRecursively;
    expect(stacks).toHaveLength(3);
    for (const stack of stacks) {
      expect(Object.keys(reads(stack)).sort(), stack.hierarchicalId).toEqual(['/lab/account/url', '/lab/catalogue/url']);
    }
  });
});
