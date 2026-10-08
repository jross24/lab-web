import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CloudAssembly, CloudFormationStackArtifact } from 'aws-cdk-lib/cx-api';
import { createApp } from '../lib/app.ts';
import { DEV_STAGE, STAGES } from '../lib/stages.ts';

// The stages that inject a fault on purpose. Only the release drill changes it.
const DRILL_STAGES: readonly string[] = [];

// Twelve digits that are not a part of a longer number or of a hex hash.
const ACCOUNT_ID = /(?<![0-9a-f])[0-9]{12}(?![0-9a-f])/i;

interface TemplateShape {
  readonly Resources: Record<string, { readonly Type: string; readonly Properties?: { readonly Code?: unknown } }>;
  readonly Outputs: { readonly Version: { readonly Value: unknown } };
}

function templateOf(stack: CloudFormationStackArtifact): TemplateShape {
  return stack.template as TemplateShape;
}

function stageNames(assembly: CloudAssembly): string[] {
  // The cloud assembly lists the stages in alphabetical order.
  return assembly.nestedAssemblies.map((nested) => nested.displayName).sort();
}

function stackIds(assembly: CloudAssembly): string[] {
  return assembly.stacksRecursively.map((stack) => stack.hierarchicalId).sort();
}

function lambdaCode(assembly: CloudAssembly): unknown[] {
  return assembly.stacksRecursively.flatMap((stack) =>
    Object.values(templateOf(stack).Resources)
      .filter((resource) => resource.Type === 'AWS::Lambda::Function')
      .map((resource) => resource.Properties?.Code),
  );
}

function versions(assembly: CloudAssembly): unknown[] {
  return assembly.stacksRecursively.map((stack) => templateOf(stack).Outputs.Version.Value);
}

describe('the app with no context', () => {
  const assembly = createApp().synth();

  it('has the three stages Test, Staging and Production, and no other stage', () => {
    expect(stageNames(assembly)).toEqual(['Production', 'Staging', 'Test']);
  });

  it('has one stack in each stage', () => {
    expect(stackIds(assembly)).toEqual(['Production/Web', 'Staging/Web', 'Test/Web']);
  });

  it('has no account and no region in any stack', () => {
    for (const stack of assembly.stacksRecursively) {
      expect(stack.environment.name).toBe('aws://unknown-account/unknown-region');
    }
  });

  it('needs no lookup in an AWS account at synth', () => {
    // The stack reads the SSM parameters of the two APIs at deployment. A synth-time lookup shows as missing context.
    expect(assembly.manifest.missing ?? []).toEqual([]);
  });

  it('has no account ID in any template', () => {
    for (const stack of assembly.stacksRecursively) {
      expect(JSON.stringify(stack.template)).not.toMatch(ACCOUNT_ID);
    }
  });

  it('uses the same Lambda code asset in all three stages', () => {
    const code = lambdaCode(assembly);
    expect(code).toHaveLength(3);
    expect(code[0]).toBeDefined();
    expect(code[1]).toEqual(code[0]);
    expect(code[2]).toEqual(code[0]);
  });

  it('uses the version 0.0.0-dev', () => {
    expect(versions(assembly)).toEqual(['0.0.0-dev', '0.0.0-dev', '0.0.0-dev']);
  });
});

// The number of bytes in the bundle that come from files whose path starts with the prefix.
// esbuild writes a comment "// node_modules/<package>/<file>" before the code of each file of the bundle.
function bytesFrom(bundle: string, prefix: string): number {
  let source = '';
  let bytes = 0;
  for (const line of bundle.split('\n')) {
    source = /^\/\/ ((?:node_modules|lib)\/\S+)$/.exec(line)?.[1] ?? source;
    if (source.startsWith(prefix)) bytes += Buffer.byteLength(line) + 1;
  }
  return bytes;
}

describe('the bundled Lambda code', () => {
  const assembly = createApp().synth();

  // The S3 key of the code is the hash of the asset, and the asset is the directory asset.<hash> in the cloud assembly.
  function bundleDirectory(): string {
    const [code] = lambdaCode(assembly) as { S3Key?: string }[];
    return join(assembly.directory, `asset.${(code?.S3Key ?? '').replace(/.zip$/, '')}`);
  }

  it('is one ES module, index.mjs, and not a CommonJS file', () => {
    const files = readdirSync(bundleDirectory());
    expect(files).toContain('index.mjs');
    expect(files).not.toContain('index.js');
  });

  it('has little OpenTelemetry code, because esbuild removed the code that no request uses', () => {
    // As CommonJS, the OpenTelemetry packages alone are 641 KB. The module entries of the packages let esbuild remove most of it.
    // The test does not measure the whole file. React is in the file too. It is large, but the next test checks that
    // it is the production build only.
    const bundle = readFileSync(join(bundleDirectory(), 'index.mjs'), 'utf8');
    const openTelemetry = bytesFrom(bundle, 'node_modules/@opentelemetry/');
    expect(openTelemetry, 'the comments that name the files of the bundle').toBeGreaterThan(0);
    expect(openTelemetry).toBeLessThan(200_000);
  });

  // React picks its development or its production build at run time from process.env.NODE_ENV. The development build
  // is large and slow. A define of process.env.NODE_ENV at build time lets esbuild drop it. The stack sets the define
  // (WEB_BUNDLING in lib/web-stack.ts). When the define does not reach esbuild, the bundle keeps both builds.
  it('holds the production build of React and not the development build', () => {
    const bundle = readFileSync(join(bundleDirectory(), 'index.mjs'), 'utf8');
    // esbuild writes a comment with the path before the code of each file. A development build has "development" in its name.
    const files = bundle.split('\n').filter((line) => /^\/\/ node_modules\/\S+\.js$/.test(line));
    const production = files.filter((line) => line.includes('.production.'));
    const development = files.filter((line) => line.includes('.development.'));
    expect(production, 'the comments that name the production files of React').not.toEqual([]);
    expect(development).toEqual([]);
    // Only the development build of React has this warning. The production build has error codes instead of text.
    expect(bundle).not.toContain('Each child in a list should have a unique');
  });
});

describe('the app with a version in the context', () => {
  it('uses that version in each stage', () => {
    expect(versions(createApp({ version: '1.4.0' }).synth())).toEqual(['1.4.0', '1.4.0', '1.4.0']);
  });

  it.each(['', 'v1.4.0', '1.4', 'latest', '1.4.0 ', 140])('rejects the version %j', (version) => {
    expect(() => createApp({ version })).toThrow(/version must look like 1\.2\.3/);
  });
});

describe('the app with dev=true in the context', () => {
  const assembly = createApp({ dev: 'true' }).synth();

  it('has only the stage Dev', () => {
    expect(stageNames(assembly)).toEqual(['Dev']);
    expect(stackIds(assembly)).toEqual(['Dev/Web']);
  });

  it('has no account, no region and no account ID', () => {
    for (const stack of assembly.stacksRecursively) {
      expect(stack.environment.name).toBe('aws://unknown-account/unknown-region');
      expect(JSON.stringify(stack.template)).not.toMatch(ACCOUNT_ID);
    }
  });

  it('accepts dev=false and makes the three stages', () => {
    expect(stageNames(createApp({ dev: 'false' }).synth())).toEqual(['Production', 'Staging', 'Test']);
  });

  it('rejects a value of dev that is not true or false', () => {
    expect(() => createApp({ dev: 'yes' })).toThrow(/dev must be true or false/);
  });
});

describe('the stage config', () => {
  it('releases Test and Staging all at once, and Production as a canary of 10 percent for 5 minutes', () => {
    expect(STAGES.Test.release).toEqual({ kind: 'allAtOnce' });
    expect(STAGES.Staging.release).toEqual({ kind: 'allAtOnce' });
    expect(STAGES.Production.release).toEqual({ kind: 'canary', percent: 10, minutes: 5 });
    expect(DEV_STAGE.release).toEqual({ kind: 'allAtOnce' });
  });

  it('injects a fault only in the stages that the list DRILL_STAGES names', () => {
    // The fault switch is a device for the release drill. A fault in the main branch is a mistake.
    // So a stage must be in the list and must set injectFault. One of the two alone fails this test.
    // The drill changes both in one pull request. See "The Production drill" in the README.
    for (const [name, config] of Object.entries(STAGES)) {
      expect(config.injectFault, name).toBe(DRILL_STAGES.includes(name));
    }
    expect(DEV_STAGE.injectFault).toBe(false);
  });

  it('forwards the flag override header in Test and Dev, and in no other stage', () => {
    expect(STAGES.Test.forwardFlagOverride).toBe(true);
    expect(STAGES.Staging.forwardFlagOverride).toBe(false);
    expect(STAGES.Production.forwardFlagOverride).toBe(false);
    expect(DEV_STAGE.forwardFlagOverride).toBe(true);
  });
});

describe('the deployment configuration of each stage', () => {
  const assembly = createApp().synth();

  function stackOf(stage: string): CloudFormationStackArtifact {
    const stack = assembly.stacksRecursively.find((candidate) => candidate.hierarchicalId === `${stage}/Web`);
    expect(stack, stage).toBeDefined();
    return stack as CloudFormationStackArtifact;
  }

  function groupOf(stage: string): { readonly Properties: { readonly DeploymentConfigName: string } } {
    const groups = Object.values(templateOf(stackOf(stage)).Resources).filter(
      (resource) => resource.Type === 'AWS::CodeDeploy::DeploymentGroup',
    );
    expect(groups).toHaveLength(1);
    return groups[0] as unknown as { readonly Properties: { readonly DeploymentConfigName: string } };
  }

  it('is all at once in Test and Staging, and a canary of 10 percent for 5 minutes in Production', () => {
    expect(groupOf('Test').Properties.DeploymentConfigName).toBe('CodeDeployDefault.LambdaAllAtOnce');
    expect(groupOf('Staging').Properties.DeploymentConfigName).toBe('CodeDeployDefault.LambdaAllAtOnce');
    expect(groupOf('Production').Properties.DeploymentConfigName).toBe(
      'CodeDeployDefault.LambdaCanary10Percent5Minutes',
    );
  });

  it('is the only difference between the templates of the stages, apart from the stage config', () => {
    // Test must exercise the resources that Production runs. So the stages must differ only in the stage config:
    // the log retention, the deployment configuration, the switch of the flag override, and the fault switch of the drill with the id of the
    // Lambda version that the switch changes.
    const normalised = (stage: string): string =>
      JSON.stringify(stackOf(stage).template)
        .replace(/"RetentionInDays":[0-9]+/g, '"RetentionInDays":0')
        .replace(/CodeDeployDefault\.Lambda[A-Za-z0-9]+/g, 'CodeDeployDefault.Lambda')
        .replace(/"INJECT_FAULT":"true",/g, '')
        .replace(/"FORWARD_FLAG_OVERRIDE":"true",/g, '')
        .replace(/CurrentVersion[0-9A-F]{8}[0-9a-f]{32}/g, 'CurrentVersion');
    expect(normalised('Staging')).toBe(normalised('Test'));
    expect(normalised('Production')).toBe(normalised('Test'));
  });

  it('has the same three alarms and one dashboard in each stage', () => {
    for (const stage of ['Test', 'Staging', 'Production']) {
      const resources = Object.values(templateOf(stackOf(stage)).Resources);
      expect(resources.filter((resource) => resource.Type === 'AWS::CloudWatch::Alarm'), stage).toHaveLength(3);
      expect(resources.filter((resource) => resource.Type === 'AWS::CloudWatch::Dashboard'), stage).toHaveLength(1);
    }
  });
});
