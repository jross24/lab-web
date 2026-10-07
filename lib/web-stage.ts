import { Stage } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { WebStack } from './web-stack.ts';
import type { WebStackProps } from './web-stack.ts';

// One deployable copy of the service. `cdk deploy "<id>/*"` deploys all the stacks of one stage.
export class WebStage extends Stage {
  constructor(scope: Construct, id: string, props: WebStackProps) {
    super(scope, id);
    new WebStack(this, 'Web', props);
  }
}
