import { fileURLToPath } from 'node:url';
import { CfnOutput, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import { HttpApi, HttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup } from 'aws-cdk-lib/aws-logs';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import type { StageConfig } from './stages.ts';

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
      // The function waits for two APIs. Each call has its own limit of 5 seconds.
      timeout: Duration.seconds(10),
      environment: {
        VERSION: props.version,
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

    const api = new HttpApi(this, 'Api', { description: 'lab-web: mock server-rendered React application' });

    // No authoriser: both routes are public.
    const integration = new HttpLambdaIntegration('WebIntegration', webFunction);
    api.addRoutes({ path: '/', methods: [HttpMethod.GET], integration });
    api.addRoutes({ path: '/health', methods: [HttpMethod.GET], integration });

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
