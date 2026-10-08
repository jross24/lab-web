import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import type { Release } from './gradual-release.ts';

// The settings that can differ between stages. All other things are the same in each stage.
export interface StageConfig {
  readonly logRetentionDays: RetentionDays;
  readonly release: Release;
  // A device for the release drill. When it is true, the function throws on each call, also on GET /health.
  // Do not use it as a production practice. See "The Production drill" in the README.
  readonly injectFault: boolean;
  // When it is true, the page passes the request header x-lab-flags to the catalogue request. That header overrides
  // a feature flag for one request, and only the catalogue of Test accepts it. See "Feature flags" in the README.
  readonly forwardFlagOverride: boolean;
}

// The pipeline deploys these stages. Each stage goes to its own AWS account.
export const STAGES = {
  Test: {
    logRetentionDays: RetentionDays.ONE_WEEK,
    release: { kind: 'allAtOnce' },
    injectFault: false,
    forwardFlagOverride: true,
  },
  Staging: {
    logRetentionDays: RetentionDays.ONE_WEEK,
    release: { kind: 'allAtOnce' },
    injectFault: false,
    forwardFlagOverride: false,
  },
  Production: {
    logRetentionDays: RetentionDays.ONE_MONTH,
    release: { kind: 'canary', percent: 10, minutes: 5 },
    injectFault: false,
    forwardFlagOverride: false,
  },
} as const satisfies Record<string, StageConfig>;

// A developer deploys this stage from a laptop to a personal account. The pipeline does not use it.
export const DEV_STAGE: StageConfig = {
  logRetentionDays: RetentionDays.THREE_DAYS,
  release: { kind: 'allAtOnce' },
  injectFault: false,
  forwardFlagOverride: true,
};
