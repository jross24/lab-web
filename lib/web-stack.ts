import { fileURLToPath } from 'node:url';
import { CfnOutput, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import { CfnIntegration, HttpApi, HttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { CfnDashboard } from 'aws-cdk-lib/aws-cloudwatch';
import { CfnPermission, Runtime, Tracing } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup } from 'aws-cdk-lib/aws-logs';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import { GradualRelease } from './gradual-release.ts';
import { ServiceDashboard } from './service-dashboard.ts';
import type { StageConfig } from './stages.ts';

const SERVICE = 'web';

// The function waits for two APIs. Each call has a limit of 5 seconds, so the page can take a little more than that.
// The latency alarm compares the p99 duration with a threshold far below this limit.
export const FUNCTION_TIMEOUT = Duration.seconds(10);

// The p99 duration of the function, for the alarm. The README section "Where the latency threshold comes from"
// has the numbers behind this value. A warm page took 54 to 709 ms. A cold chain took 3.8 to 4.3 seconds.
// The value is about 3 times a warm page, and below a third of the timeout. So the alarm fires on a real
// fault, and one cold chain fires it for one minute only. The alarm needs two minutes in a row.
export const LATENCY_P99_THRESHOLD_MS = 1500;

export interface WebStackProps {
  readonly version: string;
  readonly config: StageConfig;
}

export class WebStack extends Stack {
  constructor(scope: Construct, id: string, props: WebStackProps) {
    // No env here: the stack takes the account and the region of the credentials that deploy it.
    super(scope, id, { stackName: 'lab-web' });

    // The catalogue stack and the account stack write these parameters in each account.
    // CloudFormation reads them at deployment, so one synth serves each account.
    // So both services must be in an account before this stack can go there.
    const catalogueUrl = StringParameter.valueForStringParameter(this, '/lab/catalogue/url');
    const accountUrl = StringParameter.valueForStringParameter(this, '/lab/account/url');

    const webFunction = new NodejsFunction(this, 'WebFunction', {
      entry: fileURLToPath(new URL('./web-handler.ts', import.meta.url)),
      runtime: Runtime.NODEJS_22_X,
      timeout: FUNCTION_TIMEOUT,
      // Lambda sends a segment to X-Ray for each call. The README of lab-svc-core explains why this is the tracing choice.
      tracing: Tracing.ACTIVE,
      environment: {
        // The version of the release is a part of the function, so each release publishes a new Lambda version.
        VERSION: props.version,
        ...(props.config.injectFault ? { INJECT_FAULT: 'true' } : {}),
        CATALOGUE_URL: catalogueUrl,
        ACCOUNT_URL: accountUrl,
        // React picks its development or production build from NODE_ENV at run time. Lambda does not set it.
        // The development build is much slower. (A build-time esbuild define would do the same,
        // but CDK passes it through a shell, and the shell removes the quotes of the value.)
        NODE_ENV: 'production',
      },
      logGroup: new LogGroup(this, 'WebFunctionLogs', {
        retention: props.config.logRetentionDays,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });

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

    // The shared dashboard is named lab-svc-<service>. The stack of this service is lab-web, so the dashboard is too.
    const { dashboard } = new ServiceDashboard(this, 'Dashboard', { service: SERVICE, release, api });
    (dashboard.node.defaultChild as CfnDashboard).dashboardName = 'lab-web';

    // A later phase reads this parameter to find the application, for example in an end-to-end test.
    new StringParameter(this, 'UrlParameter', {
      parameterName: '/lab/web/url',
      description: 'Base URL of the web application',
      stringValue: api.apiEndpoint,
    });

    // The pipeline reads Version after a deployment. Do not add an output that contains the account ID:
    // the deploy job prints the outputs to a public log.
    new CfnOutput(this, 'Version', { value: props.version });
    new CfnOutput(this, 'ApiUrl', { value: api.apiEndpoint });
  }
}
