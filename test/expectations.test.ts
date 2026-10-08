import { describe, expect, it } from 'vitest';
import { fetchAccount, fetchCatalogue, UpstreamError } from '../lib/upstream.ts';
import { readJsonFile, requiredPaths, sample, validate, withoutPath } from './support/contract-schema.ts';
import type { Expectations, Schema } from './support/contract-schema.ts';

// What this service reads from the two APIs is the file expectations.json. The pull request check of the pipeline compares it
// with the contracts of catalogue and account that run in Production. These tests keep the file true: the parsers in
// lib/upstream.ts need exactly the fields that the file lists as required, and no other field.

const expectations = readJsonFile<Expectations>(new URL('../expectations.json', import.meta.url));
const pipeline = readJsonFile<{ service: string; requires: Record<string, string> }>(new URL('../pipeline.json', import.meta.url));

const ALLOWED_KEYS = ['type', 'properties', 'required', 'items', 'description'];

const options = (body: unknown) => ({ fetch: async () => Response.json(body), timeoutMs: 1000 });

// One row for each provider. The call is the code that parses the answer of the provider.
const CASES = [
  {
    provider: 'catalogue',
    endpoint: 'GET /products',
    call: (body: unknown) => fetchCatalogue('https://catalogue.example.test', options(body)),
    required: [
      ['version'],
      ['core'],
      ['products'],
      ['core', 'version'],
      ['core', 'itemCount'],
      ['products', '[]', 'id'],
      ['products', '[]', 'name'],
      ['products', '[]', 'price'],
    ],
    parsed: {
      version: 'text',
      core: { version: 'text', itemCount: 1.5 },
      products: [{ id: 'text', name: 'text', price: 1.5 }],
    },
  },
  {
    provider: 'account',
    endpoint: 'GET /profile',
    call: (body: unknown) => fetchAccount('https://account.example.test', options(body)),
    required: [
      ['version'],
      ['core'],
      ['profile'],
      ['core', 'version'],
      ['core', 'itemCount'],
      ['profile', 'id'],
      ['profile', 'name'],
      ['profile', 'plan'],
    ],
    parsed: {
      version: 'text',
      core: { version: 'text', itemCount: 1.5 },
      profile: { id: 'text', name: 'text', plan: 'text' },
    },
  },
] as const;

function schemaOf(provider: string, endpoint: string): Schema {
  return expectations.expects[provider]?.[endpoint]?.responses['200'] as Schema;
}

// The pipeline refuses any other keyword, so nobody thinks that it is checked.
function keywordProblems(node: Schema, path: string): string[] {
  const problems = Object.keys(node)
    .filter((key) => !ALLOWED_KEYS.includes(key))
    .map((key) => `${path}: unsupported keyword ${key}`);
  for (const [name, child] of Object.entries(node.properties ?? {})) problems.push(...keywordProblems(child, `${path}.${name}`));
  if (node.items) problems.push(...keywordProblems(node.items, `${path}[]`));
  for (const name of node.required ?? []) {
    if (!(name in (node.properties ?? {}))) problems.push(`${path}: required name ${name} is not in properties`);
  }
  return problems;
}

describe('expectations.json', () => {
  it('names this service, the same name as pipeline.json', () => {
    expect(expectations.service).toBe(pipeline.service);
  });

  it('expects only the providers that pipeline.json requires', () => {
    expect(Object.keys(expectations.expects).sort()).toEqual(Object.keys(pipeline.requires).sort());
  });

  describe.each(CASES)('$provider $endpoint', ({ provider, endpoint, required }) => {
    const schema = schemaOf(provider, endpoint);

    it('is the only call to the provider, and it sends no request input', () => {
      expect(Object.keys(expectations.expects[provider] ?? {})).toEqual([endpoint]);
      expect(expectations.expects[provider]?.[endpoint]?.sends).toEqual([]);
    });

    it('uses only the keywords that the pipeline understands', () => {
      expect(keywordProblems(schema, `${endpoint} 200`)).toEqual([]);
    });

    it('lists the fields that the parser reads, and every one of them is required', () => {
      expect(requiredPaths(schema)).toEqual(required);
    });
  });
});

describe('the parsers of the page against the expectations', () => {
  describe.each(CASES)('$provider $endpoint', ({ provider, endpoint, call, parsed }) => {
    const schema = schemaOf(provider, endpoint);

    it('copes with an answer that has exactly the listed fields', async () => {
      expect(validate(schema, sample(schema))).toEqual([]);
      await expect(call(sample(schema))).resolves.toEqual(parsed);
    });

    it.each(requiredPaths(schema).map((path) => [path.join('.'), path] as const))(
      'fails when the required field %s is missing (the field is really needed)',
      async (_name, path) => {
        await expect(call(withoutPath(sample(schema), path))).rejects.toBeInstanceOf(UpstreamError);
      },
    );
  });
});
