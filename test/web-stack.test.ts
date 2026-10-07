import { describe, expect, it } from 'vitest';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { WebStack } from '../lib/web-stack.ts';

function synth(version = '1.2.3', logRetentionDays = 7) {
  const stack = new WebStack(new App(), 'Web', { version, config: { logRetentionDays, gradualRelease: false } });
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

  it('gives the function no permission beyond its own logs', () => {
    // The two APIs are public, so the function needs no execute-api permission.
    template.resourceCountIs('AWS::IAM::Policy', 0);
    template.resourceCountIs('AWS::IAM::Role', 1);
  });

  it('keeps the logs for the number of days in the stage config', () => {
    template.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 7 });
    synth('1.2.3', 30).template.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 30 });
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
    template.resourceCountIs('AWS::SSM::Parameter', 1);
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
