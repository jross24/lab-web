import { fileURLToPath } from 'node:url';
import { CfnOutput, Duration, RemovalPolicy, Stack, Tags } from 'aws-cdk-lib';
import { CfnIntegration, HttpApi, HttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import type { CfnDashboard } from 'aws-cdk-lib/aws-cloudwatch';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { CfnPermission, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import type { BundlingOptions } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup } from 'aws-cdk-lib/aws-logs';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import { FUNCTION_BUNDLING, FUNCTION_MEMORY_MB, tracingEnvironment } from './function-defaults.ts';
import { GradualRelease } from './gradual-release.ts';
import { NAMESPACE_TAG, namesFor, providerNamesFor } from './namespace.ts';
import { ServiceDashboard } from './service-dashboard.ts';
import type { StageConfig } from './stages.ts';

const SERVICE = 'web';

// The function waits for two APIs. Each call has a limit of 5 seconds, so the page can take a little more than that.
// The latency alarm compares the p99 duration with a threshold far below this limit.
export const FUNCTION_TIMEOUT = Duration.seconds(10);

// The p99 duration of the function, for the alarm. The README section "Where the latency threshold comes from"
// has the numbers behind this value. With tracing and 512 MB, a warm page takes about 0.2 s and a cold chain
// takes about 2.2 s. An API that hangs makes a page take 5 s, which is the limit of each call.
// The value lies between the cold chain and the hung API, and below a third of the timeout.
// So a cold chain does not fire the alarm, and a real fault does.
export const LATENCY_P99_THRESHOLD_MS = 3000;

// The bundling options of web: the shared options and one more. React picks its development or its production build
// at run time from process.env.NODE_ENV. The define gives esbuild the value at build time, so esbuild keeps only the
// production build and drops the development build. This makes the bundle about 1 MB smaller (the README has the numbers).
// The value uses single quotes on purpose. CDK gives the define to esbuild as one argument of a command, and on Windows
// that command runs in Windows PowerShell 5.1. This shell removes the double quotes of the argument, so esbuild would
// read "production" as the name of a variable and the function would fail at run time. esbuild accepts 'production'
// as a string too, and no shell changes a single quote. On Linux, CDK starts esbuild without a shell. The test in
// test/app.test.ts reads the real bundle, so a define that does not reach esbuild fails the build.
export const WEB_BUNDLING: BundlingOptions = {
  ...FUNCTION_BUNDLING,
  define: { 'process.env.NODE_ENV': "'production'" },
};

export interface WebStackProps {
  readonly version: string;
  readonly config: StageConfig;
  // Only the Dev stage sets it (the context value `namespace`). It gives the stack, the two parameters that the stack
  // writes and the dashboard names of their own, so that several copies of the service can live in one account.
  // With no namespace the stack has the names of the baseline copy. See "Namespaces" in the README.
  readonly namespace?: string;
  // Only the Dev stage sets these two (the context values `catalogueNamespace` and `accountNamespace`). Each one makes
  // the stack read the URL of a preview of that provider and not the URL of the baseline copy of the account.
  // They change what the stack reads and never what it writes.
  readonly catalogueNamespace?: string;
  readonly accountNamespace?: string;
}

export class WebStack extends Stack {
  constructor(scope: Construct, id: string, props: WebStackProps) {
    const names = namesFor(props.namespace);
    const providers = providerNamesFor(props);
    // No env here: the stack takes the account and the region of the credentials that deploy it.
    super(scope, id, { stackName: names.stackName });

    // The tag goes to the stack and to every resource that can have a tag. A copy with no namespace has no tag.
    if (props.namespace !== undefined) Tags.of(this).add(NAMESPACE_TAG, props.namespace);

    // The catalogue stack and the account stack write these parameters in each account.
    // CloudFormation reads them at deployment, so one synth serves each account.
    // So both services must be in an account before this stack can go there.
    // By default a copy reads the parameters of the baseline copy of each provider. The context values
    // catalogueNamespace and accountNamespace point it at the parameters of a preview of that provider.
    const catalogueUrl = StringParameter.valueForStringParameter(this, providers.catalogueUrlParameterName);
    const accountUrl = StringParameter.valueForStringParameter(this, providers.accountUrlParameterName);

    const webFunction = new NodejsFunction(this, 'WebFunction', {
      entry: fileURLToPath(new URL('./web-handler.ts', import.meta.url)),
      runtime: Runtime.NODEJS_22_X,
      timeout: FUNCTION_TIMEOUT,
      memorySize: FUNCTION_MEMORY_MB,
      bundling: WEB_BUNDLING,
      // No active tracing of Lambda: OpenTelemetry makes the traces (lib/tracing.ts). The README explains why.
      environment: {
        // The version of the release is a part of the function, so each release publishes a new Lambda version.
        VERSION: props.version,
        // The share of the requests that make a trace. The setting of the stage is in stages.ts.
        ...tracingEnvironment(props.config.traceSampleRatio),
        ...(props.config.injectFault ? { INJECT_FAULT: 'true' } : {}),
        ...(props.config.forwardFlagOverride ? { FORWARD_FLAG_OVERRIDE: 'true' } : {}),
        CATALOGUE_URL: catalogueUrl,
        ACCOUNT_URL: accountUrl,
        // The bundle holds only the production build of React (WEB_BUNDLING), and esbuild replaces each
        // process.env.NODE_ENV in it. This value stays for code outside the bundle. Lambda does not set NODE_ENV.
        NODE_ENV: 'production',
      },
      logGroup: new LogGroup(this, 'WebFunctionLogs', {
        retention: props.config.logRetentionDays,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });

    // The function sends its spans to the OTLP endpoint of X-Ray. The endpoint checks this permission.
    // X-Ray actions do not support a resource, so the resource is *.
    // Core turns on CloudWatch Transaction Search, which the endpoint needs. This stack does not touch it.
    webFunction.addToRolePolicy(new PolicyStatement({ actions: ['xray:PutTraceSegments'], resources: ['*'] }));

    // The alias `live` is what the API calls. CodeDeploy moves the traffic of the alias to each new version.
    // The service counts a page with one error block as an error (see the README), so it sets serviceErrors.
    const release = new GradualRelease(this, 'Release', {
      function: webFunction,
      release: props.config.release,
      latencyP99ThresholdMs: LATENCY_P99_THRESHOLD_MS,
      serviceErrors: { service: SERVICE, version: props.version },
    });

    const api = new HttpApi(this, 'Api', { description: 'lab-web: mock server-rendered React application' });

    // No authoriser: both routes are public. The two routes share one integration, and it calls the alias, not the function.
    // The route and the API stay the same, so a visitor and the end-to-end suite need no change.
    const integration = new HttpLambdaIntegration('WebIntegration', release.alias);
    api.addRoutes({ path: '/', methods: [HttpMethod.GET], integration });
    api.addRoutes({ path: '/health', methods: [HttpMethod.GET], integration });

    // The first release with an alias updates a running API. The integration moves from the function to the alias,
    // and the invoke permissions move too. Each route has its own permission, so this stack has two.
    // All permissions must exist before the integration calls the alias.
    // Without this, CloudFormation may update the integration first, and one route fails for a few seconds.
    const permissions = api.node.findAll().filter((node): node is CfnPermission => node instanceof CfnPermission);
    const integrations = api.node.findAll().filter((node): node is CfnIntegration => node instanceof CfnIntegration);
    if (permissions.length === 0 || integrations.length === 0) {
      throw new Error('The API has no integration or no invoke permission.');
    }
    for (const apiIntegration of integrations) {
      for (const permission of permissions) {
        apiIntegration.addResourceDependency(permission, 'The alias needs the invoke permissions before the API calls it.');
      }
    }

    // The shared dashboard code names the dashboard lab-svc-<service>, so this one is lab-svc-web.
    const dashboard = new ServiceDashboard(this, 'Dashboard', { service: SERVICE, release, api });
    if (props.namespace !== undefined) {
      // That file is a copy of the file in lab-workflows, and it stays unchanged. So a copy with a namespace sets the
      // name in the template. The property dashboardName of the construct keeps the old name, and nothing here reads it.
      (dashboard.dashboard.node.defaultChild as CfnDashboard).addPropertyOverride('DashboardName', names.dashboardName);
    }

    // A later phase reads this parameter to find the application, for example in an end-to-end test.
    new StringParameter(this, 'UrlParameter', {
      parameterName: names.urlParameterName,
      description: 'Base URL of the web application',
      stringValue: api.apiEndpoint,
    });

    // The pipeline of the other services reads this parameter. It checks the deployment order and the set of tested versions.
    const versionParameter = new StringParameter(this, 'VersionParameter', {
      parameterName: names.versionParameterName,
      description: 'Version of web that this stack runs',
      stringValue: props.version,
    });
    // CloudFormation updates the alias, then waits for the CodeDeploy deployment (canary in Production), and only then
    // updates this parameter. So the parameter shows the new version when the release is complete.
    // A rollback of the traffic leaves the old version in the parameter.
    versionParameter.node.addDependency(release.alias);

    // The pipeline reads Version after a deployment. Do not add an output that contains the account ID:
    // the deploy job prints the outputs to a public log.
    new CfnOutput(this, 'Version', { value: props.version });
    new CfnOutput(this, 'ApiUrl', { value: api.apiEndpoint });
  }
}
