import { describe, expect, it } from 'vitest';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { FUNCTION_MEMORY_MB } from '../lib/function-defaults.ts';
import { FUNCTION_TIMEOUT, LATENCY_P99_THRESHOLD_MS, WebStack } from '../lib/web-stack.ts';
import type { StageConfig } from '../lib/stages.ts';

const ALL_AT_ONCE: StageConfig['release'] = { kind: 'allAtOnce' };
const CANARY: StageConfig['release'] = { kind: 'canary', percent: 10, minutes: 5 };

function synth(version = '1.2.3', config: Partial<StageConfig> = {}) {
  const stack = new WebStack(new App(), 'Web', {
    version,
    config: { logRetentionDays: RetentionDays.ONE_WEEK, release: ALL_AT_ONCE, injectFault: false, forwardFlagOverride: false, ...config },
  });
  return { stack, template: Template.fromStack(stack) };
}

// The logical ID of the CloudFormation parameter that reads one SSM parameter at deployment.
function ssmParameterId(template: Template, name: string): string {
  const ids = Object.keys(
    template.findParameters('*', { Type: 'AWS::SSM::Parameter::Value<String>', Default: name }),
  );
  expect(ids).toHaveLength(1);
  return ids[0] as string;
}

function onlyKey(resources: Record<string, unknown>): string {
  const keys = Object.keys(resources);
  expect(keys).toHaveLength(1);
  return keys[0] ?? '';
}

describe('WebStack', () => {
  const { stack, template } = synth();

  it('has a fixed stack name and no fixed account or region', () => {
    expect(stack.stackName).toBe('lab-web');
    expect(stack.resolve(stack.account)).toEqual({ Ref: 'AWS::AccountId' });
    expect(stack.resolve(stack.region)).toEqual({ Ref: 'AWS::Region' });
  });

  it('reads the two API URLs from SSM parameters at deployment, not at synth', () => {
    ssmParameterId(template, '/lab/catalogue/url');
    ssmParameterId(template, '/lab/account/url');
    // A synth-time lookup writes the value in the template. These two do not.
    expect(JSON.stringify(template.toJSON())).not.toContain('dummy-value-for');
  });

  it('has one Node.js 22 function that gets the version and the two URLs from the environment', () => {
    template.resourceCountIs('AWS::Lambda::Function', 1);
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      Timeout: 10,
      Environment: {
        Variables: {
          VERSION: '1.2.3',
          // Without it, React runs its slow development build.
          NODE_ENV: 'production',
          CATALOGUE_URL: { Ref: ssmParameterId(template, '/lab/catalogue/url') },
          ACCOUNT_URL: { Ref: ssmParameterId(template, '/lab/account/url') },
        },
      },
    });
  });

  it('gives the function no permission beyond its own logs and the one X-Ray action for its spans', () => {
    // The two APIs are public, so the function needs no execute-api permission.
    // The second role belongs to CodeDeploy.
    template.resourceCountIs('AWS::IAM::Role', 2);
    template.resourceCountIs('AWS::IAM::Policy', 1);
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: [{ Action: 'xray:PutTraceSegments', Effect: 'Allow', Resource: '*' }],
      },
    });
  });

  it('keeps the logs for the number of days in the stage config', () => {
    template.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 7 });
    synth('1.2.3', { logRetentionDays: RetentionDays.ONE_MONTH }).template.hasResourceProperties(
      'AWS::Logs::LogGroup',
      { RetentionInDays: 30 },
    );
  });

  it('has two public routes, GET / and GET /health, with no authoriser', () => {
    template.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
    template.hasResourceProperties('AWS::ApiGatewayV2::Api', { ProtocolType: 'HTTP' });
    template.resourceCountIs('AWS::ApiGatewayV2::Route', 2);
    for (const routeKey of ['GET /', 'GET /health']) {
      template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
        RouteKey: routeKey,
        AuthorizationType: 'NONE',
        AuthorizerId: Match.absent(),
      });
    }
    template.resourceCountIs('AWS::ApiGatewayV2::Authorizer', 0);
  });

  it('writes its own API URL to the SSM parameter /lab/web/url', () => {
    const apiId = Object.keys(template.findResources('AWS::ApiGatewayV2::Api'))[0];
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/lab/web/url',
      Type: 'String',
      Value: { 'Fn::GetAtt': [apiId, 'ApiEndpoint'] },
    });
    template.resourceCountIs('AWS::SSM::Parameter', 2);
  });

  it('writes the version to the SSM parameter /lab/web/version', () => {
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/lab/web/version',
      Type: 'String',
      Value: '1.2.3',
    });
  });

  it('waits for the alias before it writes the version, so the parameter shows the version of a complete release', () => {
    // CloudFormation waits for the CodeDeploy deployment of the alias. Then it updates the parameter.
    const aliasId = onlyKey(template.findResources('AWS::Lambda::Alias'));
    template.hasResource('AWS::SSM::Parameter', {
      Properties: { Name: '/lab/web/version' },
      DependsOn: Match.arrayWith([aliasId]),
    });
  });

  it('writes a new version to the SSM parameter /lab/web/version when the version changes', () => {
    synth('1.2.4').template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/lab/web/version',
      Value: '1.2.4',
    });
  });

  it('reports the version and the API URL as stack outputs', () => {
    template.hasOutput('Version', { Value: '1.2.3' });
    template.hasOutput('ApiUrl', { Value: Match.anyValue() });
  });

  it('has no output that contains the account ID', () => {
    // The deploy job prints the outputs to a public log.
    expect(JSON.stringify(template.findOutputs('*'))).not.toContain('AWS::AccountId');
  });
});

describe('the alias live', () => {
  const { template } = synth();
  const versionId = onlyKey(template.findResources('AWS::Lambda::Version'));
  const aliasId = onlyKey(template.findResources('AWS::Lambda::Alias'));

  it('points at one published version of the function', () => {
    const functionId = onlyKey(template.findResources('AWS::Lambda::Function'));
    template.hasResourceProperties('AWS::Lambda::Version', { FunctionName: { Ref: functionId } });
    template.hasResourceProperties('AWS::Lambda::Alias', {
      Name: 'live',
      FunctionName: { Ref: functionId },
      FunctionVersion: { 'Fn::GetAtt': [versionId, 'Version'] },
    });
  });

  it('is the target of the one API integration, so the API calls the alias and not the function', () => {
    // Both routes share this integration.
    template.resourceCountIs('AWS::ApiGatewayV2::Integration', 1);
    template.hasResourceProperties('AWS::ApiGatewayV2::Integration', {
      IntegrationType: 'AWS_PROXY',
      IntegrationUri: { Ref: aliasId },
    });
  });

  it('is the only target of the two invoke permissions of the API, one for each route', () => {
    const permissions = Object.values(template.findResources('AWS::Lambda::Permission')) as {
      Properties: { Action: string; FunctionName: unknown; Principal: string; SourceArn: unknown };
    }[];
    expect(permissions).toHaveLength(2);
    for (const permission of permissions) {
      expect(permission.Properties).toMatchObject({
        Action: 'lambda:InvokeFunction',
        FunctionName: { Ref: aliasId },
        Principal: 'apigateway.amazonaws.com',
      });
    }
    // One permission names the path /health. The other names the path /. The ARN ends with the method and the path.
    const lastPart = (arn: unknown): unknown => {
      const parts = (arn as { 'Fn::Join': [string, unknown[]] })['Fn::Join'][1];
      return parts[parts.length - 1];
    };
    expect(permissions.map((permission) => lastPart(permission.Properties.SourceArn)).sort()).toEqual([
      '/*/*/',
      '/*/*/health',
    ]);
  });

  it('has each of the two invoke permissions before the integration calls the alias', () => {
    // The update of a running stack must not leave a moment where the API calls the alias without a permission.
    // A route with a missing permission would answer with an error until the permission exists.
    const permissionIds = Object.keys(template.findResources('AWS::Lambda::Permission'));
    expect(permissionIds).toHaveLength(2);
    for (const permissionId of permissionIds) {
      template.hasResource('AWS::ApiGatewayV2::Integration', { DependsOn: Match.arrayWith([permissionId]) });
    }
  });

  it('gets a new published version for each release', () => {
    const versionOf = (version: string): string[] =>
      Object.keys(synth(version).template.findResources('AWS::Lambda::Version'));
    expect(versionOf('1.2.4')).not.toEqual(versionOf('1.2.3'));
    expect(versionOf('1.2.3')).toEqual(versionOf('1.2.3'));
  });

  it('keeps the same published version when nothing changes', () => {
    expect(Object.keys(synth('1.2.3').template.findResources('AWS::Lambda::Version'))).toEqual([versionId]);
  });
});

describe('the deployment group', () => {
  const { template } = synth();

  it('is one CodeDeploy application and one deployment group on the Lambda platform', () => {
    template.resourceCountIs('AWS::CodeDeploy::Application', 1);
    template.hasResourceProperties('AWS::CodeDeploy::Application', { ComputePlatform: 'Lambda' });
    template.resourceCountIs('AWS::CodeDeploy::DeploymentGroup', 1);
    template.hasResourceProperties('AWS::CodeDeploy::DeploymentGroup', {
      DeploymentStyle: { DeploymentOption: 'WITH_TRAFFIC_CONTROL', DeploymentType: 'BLUE_GREEN' },
    });
  });

  it('is the update policy of the alias, so each new version of the alias starts a deployment', () => {
    const groupId = onlyKey(template.findResources('AWS::CodeDeploy::DeploymentGroup'));
    const applicationId = onlyKey(template.findResources('AWS::CodeDeploy::Application'));
    template.hasResource('AWS::Lambda::Alias', {
      UpdatePolicy: {
        CodeDeployLambdaAliasUpdate: {
          ApplicationName: { Ref: applicationId },
          DeploymentGroupName: { Ref: groupId },
        },
      },
    });
  });

  it('uses the all-at-once configuration for the release all at once', () => {
    template.hasResourceProperties('AWS::CodeDeploy::DeploymentGroup', {
      DeploymentConfigName: 'CodeDeployDefault.LambdaAllAtOnce',
    });
  });

  it('uses the canary configuration for the release canary 10 percent, 5 minutes', () => {
    synth('1.2.3', { release: CANARY }).template.hasResourceProperties('AWS::CodeDeploy::DeploymentGroup', {
      DeploymentConfigName: 'CodeDeployDefault.LambdaCanary10Percent5Minutes',
    });
  });

  it('creates no extra deployment configuration', () => {
    synth('1.2.3', { release: CANARY }).template.resourceCountIs('AWS::CodeDeploy::DeploymentConfig', 0);
  });

  it('rolls back when the deployment fails and when an alarm fires', () => {
    template.hasResourceProperties('AWS::CodeDeploy::DeploymentGroup', {
      AutoRollbackConfiguration: {
        Enabled: true,
        Events: Match.arrayWith(['DEPLOYMENT_FAILURE', 'DEPLOYMENT_STOP_ON_ALARM']),
      },
    });
  });

  it('watches all three alarms and stops when it cannot read an alarm', () => {
    const errorsId = Object.keys(template.findResources('AWS::CloudWatch::Alarm', { Properties: { MetricName: 'Errors' } }));
    const latencyId = Object.keys(template.findResources('AWS::CloudWatch::Alarm', { Properties: { MetricName: 'Duration' } }));
    const serviceErrorsId = Object.keys(
      template.findResources('AWS::CloudWatch::Alarm', { Properties: { MetricName: 'errors' } }),
    );
    expect(errorsId).toHaveLength(1);
    expect(latencyId).toHaveLength(1);
    expect(serviceErrorsId).toHaveLength(1);
    template.hasResourceProperties('AWS::CodeDeploy::DeploymentGroup', {
      AlarmConfiguration: {
        Enabled: true,
        // The default is false: CodeDeploy stops the deployment when it cannot read an alarm.
        IgnorePollAlarmFailure: Match.absent(),
        Alarms: Match.arrayEquals([
          { Name: { Ref: errorsId[0] } },
          { Name: { Ref: latencyId[0] } },
          { Name: { Ref: serviceErrorsId[0] } },
        ]),
      },
    });
  });
});

describe('the alarms', () => {
  const { template } = synth();

  it('has exactly three alarms, errors, latency and the errors that the service counts', () => {
    template.resourceCountIs('AWS::CloudWatch::Alarm', 3);
  });

  it('fires on any error in a period of one minute, and a quiet service does not fire it', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Namespace: 'AWS/Lambda',
      MetricName: 'Errors',
      Statistic: 'Sum',
      Period: 60,
      EvaluationPeriods: 1,
      Threshold: 1,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      TreatMissingData: 'notBreaching',
    });
  });

  it('fires when the p99 duration is over the threshold in two periods in a row', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Namespace: 'AWS/Lambda',
      MetricName: 'Duration',
      ExtendedStatistic: 'p99',
      Period: 60,
      EvaluationPeriods: 2,
      DatapointsToAlarm: 2,
      Threshold: LATENCY_P99_THRESHOLD_MS,
      ComparisonOperator: 'GreaterThanThreshold',
      TreatMissingData: 'notBreaching',
    });
  });

  it('keeps the latency threshold below a third of the timeout, and above the time of a warm page', () => {
    synth().template.hasResourceProperties('AWS::Lambda::Function', { Timeout: FUNCTION_TIMEOUT.toSeconds() });
    expect(FUNCTION_TIMEOUT.toSeconds()).toBe(10);
    // The slowest cold chain that the lab measured with tracing and 512 MB took 2.2 s. A page with a hung API takes 5 s.
    // See "Where the latency threshold comes from".
    expect(LATENCY_P99_THRESHOLD_MS).toBeGreaterThanOrEqual(2500);
    expect(LATENCY_P99_THRESHOLD_MS).toBeLessThanOrEqual(FUNCTION_TIMEOUT.toMilliseconds() / 3);
  });

  it('fires on an error that the service counts, in the metric of the version that this stack deploys', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Namespace: 'Lab/Service',
      MetricName: 'errors',
      Dimensions: Match.arrayEquals([
        { Name: 'service', Value: 'web' },
        { Name: 'version', Value: '1.2.3' },
      ]),
      Statistic: 'Sum',
      Period: 60,
      EvaluationPeriods: 1,
      Threshold: 1,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      TreatMissingData: 'notBreaching',
    });
  });

  it('watches the next version in the next release, so a canary sees its own errors and not the old ones', () => {
    synth('1.2.4').template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'errors',
      Dimensions: Match.arrayWith([{ Name: 'version', Value: '1.2.4' }]),
    });
  });

  it('watches the alias live with the two Lambda alarms, so they see live traffic and not the other versions', () => {
    const alarms = Object.values(template.findResources('AWS::CloudWatch::Alarm', { Properties: { Namespace: 'AWS/Lambda' } })) as {
      Properties: { Dimensions: { Name: string; Value: unknown }[] };
    }[];
    expect(alarms).toHaveLength(2);
    for (const alarm of alarms) {
      const names = alarm.Properties.Dimensions.map((dimension) => dimension.Name).sort();
      expect(names).toEqual(['FunctionName', 'Resource']);
      const resource = alarm.Properties.Dimensions.find((dimension) => dimension.Name === 'Resource');
      expect(JSON.stringify(resource?.Value)).toContain(':live');
    }
  });

  it('has no notification target in the lab', () => {
    const alarms = Object.values(template.findResources('AWS::CloudWatch::Alarm')) as {
      Properties: { AlarmActions?: unknown; OKActions?: unknown; InsufficientDataActions?: unknown };
    }[];
    for (const alarm of alarms) {
      expect(alarm.Properties.AlarmActions).toBeUndefined();
      expect(alarm.Properties.OKActions).toBeUndefined();
      expect(alarm.Properties.InsufficientDataActions).toBeUndefined();
    }
    template.resourceCountIs('AWS::SNS::Topic', 0);
  });
});

describe('the function settings', () => {
  const { template } = synth();

  it('has 512 MB of memory, so the first request does not wait for the trace export for long', () => {
    template.hasResourceProperties('AWS::Lambda::Function', { MemorySize: FUNCTION_MEMORY_MB });
    expect(FUNCTION_MEMORY_MB).toBe(512);
  });

  it('uses the handler index.handler of an ES module', () => {
    template.hasResourceProperties('AWS::Lambda::Function', { Handler: 'index.handler' });
  });
});

describe('tracing', () => {
  const { template } = synth();

  it('does not turn on active tracing of Lambda, because OpenTelemetry makes the traces', () => {
    // Active tracing would make a second trace for each call, with another trace ID.
    const [fn] = Object.values(template.findResources('AWS::Lambda::Function')) as { Properties: { TracingConfig?: unknown } }[];
    expect(fn?.Properties.TracingConfig).toBeUndefined();
  });

  it('lets the function role send spans to X-Ray, and nothing else of X-Ray', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([Match.objectLike({ Action: 'xray:PutTraceSegments', Effect: 'Allow', Resource: '*' })]),
      },
    });
    expect(JSON.stringify(template.toJSON())).not.toContain('xray:PutTelemetryRecords');
  });

  it('has exactly one X-Ray statement with exactly one action in the policies of the stack', () => {
    type Statement = { Action: string | string[] };
    const statements = Object.values(template.findResources('AWS::IAM::Policy')).flatMap(
      (policy) => (policy as { Properties: { PolicyDocument: { Statement: Statement[] } } }).Properties.PolicyDocument.Statement,
    );
    const xray = statements.filter((statement) => [statement.Action].flat().some((action) => action.startsWith('xray:')));
    expect(xray).toHaveLength(1);
    expect(xray.flatMap((statement) => [statement.Action].flat())).toEqual(['xray:PutTraceSegments']);
  });

  it('uses no Lambda layer, so no account ID of another publisher is in the template', () => {
    const functions = Object.values(template.findResources('AWS::Lambda::Function')) as {
      Properties: { Layers?: unknown };
    }[];
    expect(functions[0]?.Properties.Layers).toBeUndefined();
  });

  it('does not touch CloudWatch Transaction Search, which is a setting of the whole account and belongs to core', () => {
    template.resourceCountIs('AWS::XRay::TransactionSearchConfig', 0);
    template.resourceCountIs('AWS::Logs::ResourcePolicy', 0);
  });
});

describe('the flag override switch', () => {
  const variablesOf = (template: Template) =>
    (
      Object.values(template.findResources('AWS::Lambda::Function')) as {
        Properties: { Environment: { Variables: Record<string, unknown> } };
      }[]
    )[0]?.Properties.Environment.Variables;

  it('sets no FORWARD_FLAG_OVERRIDE variable when the stage config does not forward the override', () => {
    expect(variablesOf(synth().template)).not.toHaveProperty('FORWARD_FLAG_OVERRIDE');
  });

  it('sets FORWARD_FLAG_OVERRIDE to true when the stage config forwards the override, and keeps the other variables', () => {
    synth('1.2.3', { forwardFlagOverride: true }).template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: {
          FORWARD_FLAG_OVERRIDE: 'true',
          VERSION: '1.2.3',
          NODE_ENV: 'production',
          CATALOGUE_URL: Match.anyValue(),
          ACCOUNT_URL: Match.anyValue(),
        },
      },
    });
  });
});

describe('the fault switch', () => {
  it('sets no INJECT_FAULT variable when the stage config does not inject a fault', () => {
    const functions = Object.values(synth().template.findResources('AWS::Lambda::Function')) as {
      Properties: { Environment: { Variables: Record<string, unknown> } };
    }[];
    expect(functions[0]?.Properties.Environment.Variables).not.toHaveProperty('INJECT_FAULT');
  });

  it('sets INJECT_FAULT to true when the stage config injects a fault, and keeps the other variables', () => {
    synth('1.2.3', { injectFault: true }).template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: {
          INJECT_FAULT: 'true',
          VERSION: '1.2.3',
          NODE_ENV: 'production',
          CATALOGUE_URL: Match.anyValue(),
          ACCOUNT_URL: Match.anyValue(),
        },
      },
    });
  });

  it('publishes a new version when the stage config turns the fault on', () => {
    const off = Object.keys(synth().template.findResources('AWS::Lambda::Version'));
    const on = Object.keys(synth('1.2.3', { injectFault: true }).template.findResources('AWS::Lambda::Version'));
    expect(on).not.toEqual(off);
  });
});

interface Widget {
  readonly type: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly properties: {
    readonly title?: string;
    readonly stacked?: boolean;
    readonly metrics?: readonly (readonly unknown[])[];
    readonly alarms?: readonly string[];
    readonly annotations?: { readonly horizontal?: readonly { readonly value: number }[] };
  };
}

// CloudFormation fills the tokens of the dashboard body (Ref and GetAtt) when it deploys. In the test, each
// token becomes a marker such as <Ref:Name> or <GetAtt:Name.Arn>. Then the body is a plain JSON text.
function dashboardWidgets(template: Template): Widget[] {
  const [dashboard] = Object.values(template.findResources('AWS::CloudWatch::Dashboard')) as {
    Properties: { DashboardBody: { 'Fn::Join': [string, unknown[]] } };
  }[];
  const parts = dashboard?.Properties.DashboardBody['Fn::Join'][1] ?? [];
  const text = parts
    .map((part) => {
      if (typeof part === 'string') return part;
      const token = part as { Ref?: string; 'Fn::GetAtt'?: string[] };
      return token.Ref ? `<Ref:${token.Ref}>` : `<GetAtt:${(token['Fn::GetAtt'] ?? []).join('.')}>`;
    })
    .join('');
  return (JSON.parse(text) as { widgets: Widget[] }).widgets;
}

describe('the dashboard', () => {
  const { template } = synth();
  const widgets = dashboardWidgets(template);
  const widget = (title: string): Widget => {
    const found = widgets.find((candidate) => candidate.properties.title === title);
    expect(found, title).toBeDefined();
    return found as Widget;
  };
  const functionId = onlyKey(template.findResources('AWS::Lambda::Function'));
  const apiId = onlyKey(template.findResources('AWS::ApiGatewayV2::Api'));

  it('is one dashboard with the fixed name lab-svc-web', () => {
    template.resourceCountIs('AWS::CloudWatch::Dashboard', 1);
    template.hasResourceProperties('AWS::CloudWatch::Dashboard', { DashboardName: 'lab-svc-web' });
  });

  it('has a text widget, five metric widgets and an alarm widget, all inside the 24 columns of the grid', () => {
    expect(widgets.map((candidate) => candidate.type).sort()).toEqual([
      'alarm',
      'metric',
      'metric',
      'metric',
      'metric',
      'metric',
      'text',
    ]);
    for (const candidate of widgets) {
      expect(candidate.x).toBeGreaterThanOrEqual(0);
      expect(candidate.x + candidate.width).toBeLessThanOrEqual(24);
      expect(candidate.height).toBeGreaterThan(0);
    }
  });

  it('shows the requests by version from the embedded metrics, one line for each version', () => {
    const requests = widget('Requests by version');
    expect(requests.properties.stacked).toBe(true);
    expect(requests.properties.metrics).toEqual([
      [
        {
          expression: `SEARCH('{Lab/Service,service,version} service="web" MetricName="requests"', 'Sum', 60)`,
          period: 60,
        },
      ],
    ]);
  });

  it('shows the errors that the service counted, one line for each version', () => {
    const errors = widget('Errors that the service counted, by version');
    expect(errors.properties.stacked).toBe(true);
    expect(errors.properties.metrics).toEqual([
      [
        {
          expression: `SEARCH('{Lab/Service,service,version} service="web" MetricName="errors"', 'Sum', 60)`,
          period: 60,
        },
      ],
    ]);
  });

  it('shows the errors of the alias live, with the line of the alarm', () => {
    const errors = widget('Errors of the alias live');
    expect(errors.properties.metrics).toEqual([
      [
        'AWS/Lambda',
        'Errors',
        'FunctionName',
        `<Ref:${functionId}>`,
        'Resource',
        `<Ref:${functionId}>:live`,
        { label: 'Lambda errors', period: 60, stat: 'Sum' },
      ],
    ]);
    expect(errors.properties.annotations?.horizontal?.map((line) => line.value)).toEqual([1]);
  });

  it('shows the p50 and the p99 duration of the alias live, with the line of the alarm', () => {
    const duration = widget('Duration of the alias live');
    expect(duration.properties.metrics?.map((metric) => metric.slice(0, 6))).toEqual([
      ['AWS/Lambda', 'Duration', 'FunctionName', `<Ref:${functionId}>`, 'Resource', `<Ref:${functionId}>:live`],
      ['AWS/Lambda', 'Duration', 'FunctionName', `<Ref:${functionId}>`, 'Resource', `<Ref:${functionId}>:live`],
    ]);
    expect(duration.properties.metrics?.map((metric) => (metric[6] as { stat: string }).stat)).toEqual(['p50', 'p99']);
    expect(duration.properties.annotations?.horizontal?.map((line) => line.value)).toEqual([LATENCY_P99_THRESHOLD_MS]);
  });

  it('shows the 4xx and the 5xx of API Gateway for this API', () => {
    const gateway = widget('API Gateway 4xx and 5xx');
    expect(gateway.properties.metrics?.map((metric) => metric.slice(0, 4))).toEqual([
      ['AWS/ApiGateway', '4xx', 'ApiId', `<Ref:${apiId}>`],
      ['AWS/ApiGateway', '5xx', 'ApiId', `<Ref:${apiId}>`],
    ]);
  });

  it('shows the state of all three alarms, errors, latency and then the errors that the service counted', () => {
    const idOf = (metricName: string): string | undefined =>
      Object.keys(template.findResources('AWS::CloudWatch::Alarm', { Properties: { MetricName: metricName } }))[0];
    const alarmWidget = widgets.find((candidate) => candidate.type === 'alarm');
    expect(alarmWidget?.properties.alarms).toEqual([
      `<GetAtt:${idOf('Errors')}.Arn>`,
      `<GetAtt:${idOf('Duration')}.Arn>`,
      `<GetAtt:${idOf('errors')}.Arn>`,
    ]);
  });
});
