# lab-web

This repository holds the mock "web" application of the pipeline lab.
It is an AWS CDK app in TypeScript. The pipeline in [lab-workflows](https://github.com/jross24/lab-workflows) releases it.

The application has the same shape as [lab-svc-catalogue](https://github.com/jross24/lab-svc-catalogue).
This README explains what is different. The lab-svc-core README explains the stages and the release steps in more detail.

The gradual release and the observability follow [lab-svc-core](https://github.com/jross24/lab-svc-core/blob/main/README.md).
The section "Gradual release and observability" lists what is the same and what is different.

## What the application is

The application is a server-side rendered React page. It is one Lambda function behind an API Gateway HTTP API.
The API is public. It has two routes, both with no authoriser.

| Route | What it returns |
| --- | --- |
| `GET /` | An HTML page. |
| `GET /health` | JSON: `{ "service": "web", "version": "0.1.0" }`. It calls no other service. |

For each request to `/`, the function does these steps:

1. It calls `GET /products` of the catalogue API and `GET /profile` of the account API at the same time. Each call has a limit of 5 seconds.
2. It renders a React component tree to an HTML string with `renderToStaticMarkup` from `react-dom/server`.
3. It returns the string as `text/html`.

The page has no JavaScript for the browser. React runs on the server only. There is no bundle and no hydration.

### What the page shows

- The list of products from the catalogue API.
- The name and the plan of the profile from the account API.
- A table of versions: web, catalogue, account and core.

Each catalogue and account answer has the version of core that it saw. The core row shows that version.
If the two answers differ, the row names both values.
So the page shows data that passed through all four services.

These test ids are stable. An end-to-end test can read them.

| `data-testid` | Content |
| --- | --- |
| `web-version` | The version of this application. |
| `catalogue-version` | The version of the catalogue service. |
| `account-version` | The version of the account service. |
| `core-version` | The version of core, as the two APIs report it. |
| `product` | One list item for each product. |
| `discount` | The discount of a product, for example `10% off`. Present only when the catalogue sends one. |
| `profile-name` | The name of the profile. |
| `catalogue-error`, `account-error` | The error block of a failed API. |

### What happens when an API fails

- If one API fails or times out, the page still returns HTTP 200. The section of that API shows an error block. The version of that API is `unavailable`.
- If both APIs fail, the application returns HTTP 502 with a short HTML error page.
- The error block shows a short reason, for example `HTTP 503` or `the request timed out`. It never copies the body of the failed answer, because that body can name a role or an account.
- The log of the function has the full error.
- React escapes all text in the page. A product name with HTML in it shows as text.

## How the application finds the two APIs

The catalogue stack and the account stack each write one SSM parameter in their account.

| Parameter | How this application uses it |
| --- | --- |
| `/lab/catalogue/url` | The stack gives it to the function as the environment variable `CATALOGUE_URL`. |
| `/lab/account/url` | The stack gives it to the function as the environment variable `ACCOUNT_URL`. |

CloudFormation reads the two parameters at deployment. The CDK does not read them at synth.
So the templates name no account, and one `cdk synth` still serves each account.

Both APIs are public, so the function sends plain requests to them. It signs nothing and needs no `execute-api` permission.
Its role has one statement, for the traces. See "Tracing".

The stack also writes its own address and its own version.

| Parameter | Value |
| --- | --- |
| `/lab/web/url` | The base URL of this application. A later end-to-end test reads it. |
| `/lab/web/version` | The version of web that the stack runs. The release workflow of lab-workflows reads it, to check the deployment order and the set of tested versions. |

The stack also sets `NODE_ENV=production` on the function. Lambda does not set it.
This value is for code outside the bundle. The bundle gets its own value at build time (see "What the stack adds" in the section "Tracing").

## Deployment order: core, then catalogue and account, then web

The services depend on each other in this order:

1. `lab-svc-core`
2. `lab-svc-catalogue` and `lab-svc-account`
3. `lab-web`

Deploy a service to an account only after the services before it are in that account.

CloudFormation reads `/lab/catalogue/url` and `/lab/account/url` when it deploys this stack.
If one of them does not exist, the deployment fails before it creates a resource.
The file `pipeline.json` names the services that this service needs: `catalogue >=0.3.0` and `account >=0.3.0`.
Before each deploy job changes an environment, the pipeline reads `/lab/catalogue/version` and `/lab/account/version` in that environment.
It stops the job with a clear message if one of them is missing or outside its range. The job fails before CloudFormation starts, so it changes nothing.
The pipeline also compares the set of versions that passed in Test with the environment. Core is not in `pipeline.json` of this service, so Production must run
at least the version of core that the E2E suite tested with this release. The README of [lab-workflows](https://github.com/jross24/lab-workflows) explains both checks.

CloudFormation reads the parameters again at each deployment of this stack.
If an API gets a new URL, release or redeploy this application to pick it up.

## Gradual release and observability

This service follows the pattern of [lab-svc-core](https://github.com/jross24/lab-svc-core/blob/main/README.md).
The core README explains the mechanics: the alias, the CodeDeploy deployment group, the alarms, the log line, the metrics, tracing and the drill.
This README does not copy them. It lists what is the same and what is different. The section "Tracing" below covers the traces of this service.

### What is the same as core

- Nine files are exact copies of the files in core. Change them in core, then copy them again.
  - The release and the observability: `lib/gradual-release.ts`, `lib/service-dashboard.ts`, `lib/instrument.ts`, `lib/logger.ts` and `lib/metrics.ts`.
  - The tracing: `lib/tracing.ts`, `lib/xray-exporter.ts`, `lib/sigv4.ts` and `lib/function-defaults.ts`.
  - The tests of the tracing files are copies too: `test/tracing.test.ts`, `test/xray-exporter.test.ts`, `test/sigv4.test.ts` and `test/function-defaults.test.ts`.
- The function has the alias `live`. The API calls the alias, and not the function.
- A CodeDeploy deployment group moves the traffic of the alias to each new version. If an alarm fires, it stops and rolls the traffic back.
- Each request writes one line of JSON to the log and one metric line (embedded metric format). The metric has the dimensions `service` and `version`.
- OpenTelemetry makes the traces, and Lambda active tracing is off. The log line carries the trace ID in the form of X-Ray. See "Tracing".
- The stage config has the settings `release`, `injectFault`, `forwardFlagOverride` and `traceSampleRatio`. A unit test compares the templates of the three stages.

### What is different from core

- **Two routes, two invoke permissions.** The routes `GET /` and `GET /health` share one integration. API Gateway needs one invoke permission for each route, so the stack has two.
  The integration must not call the alias before both permissions exist. So the stack makes the integration depend on every permission of the API. Core has one route and one permission.
  Two unit tests prove this: `is the only target of the two invoke permissions of the API, one for each route` and `has each of the two invoke permissions before the integration calls the alias`.
- **A third alarm.** Core throws when it fails, so Lambda `Errors` sees its failures. Web can handle a failure and still answer. So the stack sets `serviceErrors` and gets `ServiceErrorsAlarm`. See "What an error means for web".
- **A longer duration.** One page waits for two APIs, and each API waits for core. The latency threshold is 3000 ms, and not the 1000 ms of core. See "Where the latency threshold comes from".
- **A longer timeout.** The function times out after 10 seconds. Each call to an API has a limit of 5 seconds.
- **Two client spans at the same time.** A page calls two services in parallel, so one request has two client spans. Catalogue and account make one call to core in a request. See "Tracing".
- **No signed call to another service.** Web calls public APIs. The function signs only the export of its spans to X-Ray, and it needs no permission for the two APIs.
- **The dashboard name.** The shared dashboard code names a dashboard `lab-svc-<service>`, so this dashboard is `lab-svc-web`. A unit test checks the name.
  The dashboard has one more graph than core: "Errors that the service counted, by version".
- **The fault switch fails each route.** With `injectFault` on, `GET /health` throws too.

### The first release makes the alias

CodeDeploy needs an old version to move traffic from. The first release that holds this change creates the alias and starts no deployment.
So that release goes to each stage without a canary. The second release is the first gradual release.

Do not redeploy version `0.1.0`. It has no alias. A redeploy of it would remove the alias, the deployment group, the alarms and the dashboard.

### How to watch a release

Open CloudWatch in the console (region `eu-west-2`), then Dashboards, then `lab-svc-web`.
The core README shows the checks on the command line. Use the stack name `lab-web` in them.
The function has the name that `aws cloudformation list-stack-resources --stack-name lab-web` shows.

## Tracing

One trace follows a page request from web to catalogue or account, and then to core. OpenTelemetry makes the trace.
The SDK is in the bundle of the function. There is no Lambda layer, and Lambda active tracing is off.
The [Tracing section of the lab-svc-core README](https://github.com/jross24/lab-svc-core#tracing) has the decision, the measurements and the trade-off. This README does not repeat them.

### The export stays on the request path, and the sampling ratio

The owner decided that the export of the spans stays on the request path, with 512 MB of memory ([lab-platform#28](https://github.com/jross24/lab-platform/issues/28)).
The answer of a request waits for one signed call to X-Ray. At 512 MB this costs about 35 ms for a warm request, and about 450 ms for the first request of a new environment.
The lab accepts this cost, because the other ways cost more than they give here. The cost table for 128 to 1024 MB is in the [Tracing section of the lab-svc-core README](https://github.com/jross24/lab-svc-core#tracing).

What changed is the sampling. A request that is not sampled makes no call to X-Ray, so it does not pay the cost.

**How to set the ratio.** `traceSampleRatio` in `lib/stages.ts` is a number from 0 to 1 for each stage. The value 1 samples all requests, and every stage has it today.
`lib/web-stack.ts` writes the number into the variable `TRACE_SAMPLE_RATIO` of the function (`tracingEnvironment` in `lib/function-defaults.ts`). `lib/tracing.ts` reads it.
To change the ratio, edit the number and open a pull request. The pipeline deploys it like any other change. A number outside 0 to 1 stops `cdk synth`.

The sampler is parent based. A request with a `traceparent` header follows its caller: a sampled parent is always followed, and a parent that is not sampled never is.
A request with no parent is sampled by its trace ID, for the share that the ratio names. Web starts the trace of a page request, so the ratio of web decides for the whole chain. Catalogue, account and core follow the header that web sends.
The log line keeps the trace ID of a request that is not sampled, but X-Ray then has no trace for this ID.
The unit tests in `test/tracing.test.ts` prove the rules: ratio 0 gives no call to the exporter, and ratio 1 gives one.

### What the service records

- One server span for each request. It has the route key as its name, for example `GET /`. If the request has the header `traceparent`, the span continues the trace of the caller.
- One client span for each call to another service. A page request has two: `GET <catalogue host>` and `GET <account host>`. Both are children of the server span.
- `GET /health` calls no service, so its trace has the server span only.

A client span has the status `error` when the answer is HTTP 400 or more, or when the call throws.
The server span has the status `error` when the response is HTTP 500 or more, or when the page is degraded. See "What an error means for web".
The log line of the request carries the trace ID of the server span.

### How the trace reaches the next service

The function puts the header `traceparent` on each request to the catalogue API and the account API. Both services read it and continue the trace.
Web signs nothing for these two calls, because the APIs are public. So the header needs no special order here.
The catalogue service and the account service sign their call to core first and add the header after.
The signature lists only the host header and the `x-amz-` headers, so the extra header does not break it.

The page starts both calls at the same time with `Promise.all`. Each call reads the server span as its parent from the context of the request.
So neither client span becomes the parent of the other. A unit test proves this: `records one server span and two client spans, and both client spans are children of the server span`.
Another test sends two pages at the same time and checks that each page keeps its own trace.

### How to find a trace

1. Open a log line of the function in CloudWatch Logs. Copy the field `traceId`. It looks like `1-4bf92f35-77b34da6a3ce929d0e0e4736`.
2. Run this command with a read-only profile:
   ```
   aws xray batch-get-traces --trace-ids <traceId> --region eu-west-2 --profile <read-only-profile>
   ```

The result has the spans of web, of catalogue or account, and of core. They share one trace ID.
The OTLP endpoint of X-Ray needs CloudWatch Transaction Search. The stack of core turns it on for the account. This repository does not touch it.

### What the stack adds

- **One IAM statement.** The role of the function can call `xray:PutTraceSegments` on the resource `*`. The OTLP endpoint of X-Ray checks this action.
  It is the only X-Ray action. X-Ray actions do not support a resource, so the resource is `*`.
- **512 MB of memory.** Lambda gives CPU in proportion to memory. In the measurement of core, the first request spent 1.9 s on the connection to the trace endpoint at 128 MB, and 0.45 s at 512 MB.
  The constant `FUNCTION_MEMORY_MB` in `lib/function-defaults.ts` holds the value.
- **An ES module bundle.** esbuild writes `index.mjs`, and it reads the `module` entry of each package. So it removes the code that no request uses.
  The OpenTelemetry code in the bundle is about 97 KB.
- **Only the production build of React.** React picks its development build or its production build at run time, from `process.env.NODE_ENV`.
  esbuild cannot know the value, so it used to keep both builds. The bundle was 1.62 MB, and React was 1.50 MB of it.
  Now the constant `WEB_BUNDLING` in `lib/web-stack.ts` adds the esbuild option `define` for `process.env.NODE_ENV`.
  esbuild replaces each `process.env.NODE_ENV` with the string `'production'`, sees which branches never run, and drops the development build.
  The bundle is now 0.72 MB (722 KB), and React is 0.60 MB of it. The zip of the code went from 295 KB to about 132 KB.
  The measurement of the cold start is in [lab-platform#29](https://github.com/jross24/lab-platform/issues/29).
  - **Why the value has single quotes.** CDK gives each esbuild option to a command as one argument.
    On Windows, CDK runs that command in Windows PowerShell 5.1, and this shell removes the double quotes of an argument.
    With `'"production"'` esbuild then read `production` as the name of a variable. The build passed with a warning, and the function would fail at run time with a `ReferenceError`.
    esbuild accepts `'production'` as a string literal too, and no shell changes a single quote. On Linux, CDK starts esbuild without a shell, so the CI runner and a developer on Windows get the same bundle.
  - **How the build checks it.** The test `the bundled Lambda code` in `test/app.test.ts` reads the real `index.mjs`.
    It fails when a file `react*.development.js` is in the bundle, when no `.production.` file of React is in it, or when the bundle has the text that only the development build of React has.
    The test `the bundling options of the function` in `test/web-stack.test.ts` checks that esbuild turns the value into the string `production`, and that the value has no double quote and no backslash.
- **No Lambda layer and no Lambda active tracing.** A second, unlinked trace would appear for each call with active tracing.

The function sends the spans at the end of each request, because Lambda freezes the function when the handler returns.
So the request waits for the export. The longest wait is 2.5 seconds. A failed export never fails the request. The function writes one `WARN` line, `trace export failed`.

The tracing is off outside Lambda, and in Lambda when the environment variable `TRACING` is `off`. A unit test run needs no AWS credentials.

## What an error means for web

Web counts a call as an error in two cases:

1. The status is 500 or more. This happens when both APIs fail (HTTP 502), and when the function throws.
2. The page is degraded. Exactly one API failed, so the status is 200 and the page shows an error block.

| Case | Status | Log level | Metric `errors` | Field `degraded` |
| --- | --- | --- | --- | --- |
| Both APIs answer | 200 | `INFO` | 0 | not set |
| One API fails (degraded page) | 200 | `WARN` | 1 | `catalogue: <reason>` or `account: <reason>` |
| Both APIs fail | 502 | `ERROR` | 1 | not set |
| `GET /health` | 200 | `INFO` | 0 | not set |
| The function throws (also the fault switch) | Lambda error | `ERROR` | 1 | not set |

**The decision.** For the second case, the function that `createHandler` returns takes an optional second argument, `signals`. Its default is `{}`, so a caller can leave it out.
The handler sets `signals.degraded` to a short reason, for example `catalogue: the request timed out`.

The reason is the text that the error block shows. It never holds the body of an answer.
The wrapper in `lib/instrument.ts` then writes the log line with the level `WARN` and the field `degraded`. It writes the metric line with `errors` set to 1.

**Why.** The visitor sees an error block, so the release gate must see it too. Lambda counts a call as an error only when the function throws or times out.
A degraded page returns normally, so the alarm on Lambda `Errors` does not see it.

`ServiceErrorsAlarm` reads the metric `errors` of the version that the stack deploys.
So during a canary it sees the degraded pages of the new version, and not those of the old version.

**The downside.** While an API behind web is down, each page of the new version is degraded, so a release of web rolls back. This is acceptable.
A release during an upstream incident should not go on.

The rollback is cheap. Web stores no data, and CodeDeploy only moves the alias back to the old version.

The alarm cannot tell if web or an API caused the errors. The field `degraded` of the log line names the API. The full error is in the text line that `console.error` writes.

The lab proved the third alarm in `lab-dev` with catalogue, which uses the same shared code: see "What an error means here" in the README of lab-svc-catalogue. It did not run the degraded-page case of web in AWS.

## Where the latency threshold comes from

The latency alarm fires when the p99 duration of the alias `live` is over **3000 ms** in 2 periods of 1 minute in a row.
The constant `LATENCY_P99_THRESHOLD_MS` in `lib/web-stack.ts` holds the value. The function times out at 10 seconds, and a third of that is 3333 ms.

The duration of a page includes both calls to the APIs. The slower call sets the time. Each API call includes the call of that API to core.
So one page is a chain of three functions in a row: web, catalogue or account, and core.

**With tracing and 512 MB (the design now).** The lab deployed the four services to its own account `lab-dev` and loaded the page. A cold page means that all four functions started cold.
The core README has the full table for 128, 256, 512 and 1024 MB.

| What | Result |
| --- | --- |
| The first request of web after a deployment (a cold chain), two samples | 2.0 s and 2.2 s |
| A warm request of web, median | 223 ms |
| The page seen from a laptop, cold, two samples | 2.67 s and 2.62 s |
| The page seen from a laptop, warm, median of 5, two samples | 237 ms and 262 ms |
| A page with an API that hangs | about 5 s: the limit of each call |

**Before the tracing change (128 MB, Lambda active tracing).** The lab measured this with read-only calls in Test and Production on 2026-10-06 and 2026-10-07.
The times are UTC. The p50 and p99 of the single requests come from the `REPORT` lines of the function.

| Stage | When | What | Calls | p50 | p99 | Slowest |
| --- | --- | --- | --- | --- | --- | --- |
| Test | 24 hours to 21:57 | CloudWatch `AWS/Lambda` `Duration`, all calls (mostly end-to-end runs after a release) | 63 | 319 ms | 4195 ms | 4225 ms |
| Production | 24 hours to 21:57 | The same metric | 4 | 335 ms | 4261 ms | 4266 ms |
| Test | 21:58 | `GET /` 30 times, 2 s apart: the first call | 1 | | | 1198 ms |
| Test | 21:58 | The other 29 calls (a warm chain) | 29 | 90 ms | 397 ms | 397 ms |
| Production | 22:00 | `GET /` 8 times, 3 s apart: the first call (the function and the chain were cold) | 1 | | | 3952 ms |
| Production | 22:00 | The other 7 calls (a warm chain) | 7 | 298 ms | 709 ms | 709 ms |
| Test | 18:58 to 22:10 | All calls over 3.5 seconds (a cold chain, see lab-platform#17) | 7 | | | 3786 to 4235 ms |
| Production | 20:11 to 22:00 | The same | 3 | | | 3952 to 4266 ms |

In Test, 11 more calls took between 1.9 and 2.3 seconds. The lab did not trace them. They fit a chain where only some functions started cold.

How the value follows from the numbers:

- A cold chain takes 2.0 to 2.2 seconds in web. The value 3000 ms is above that, so one cold chain does not fire the alarm.
- A page with an API that hangs takes about 5 seconds. The value is below that, so a real fault fires the alarm.
- The value is below a third of the timeout. So the alarm fires long before the function times out.
- At 256 MB the cold chain takes 3.7 seconds, and it would fire the alarm. So the memory of 512 MB is part of this design.
- The lab-dev account showed the danger of a lower value. With the threshold of 1500 ms, the alarm stayed in the state `ALARM` after a series of cold tests, and it stopped the next deployment of web.

**Why the alarm still needs two periods in a row.**

- A cold chain is slow one time. The next calls find the functions running, so the next minute is under the threshold.
- If one period were enough, a release after an idle time could roll back with no fault.
- Two periods in a row ignore one cold minute. The alarm still fires when the page stays slow for two minutes, because then one cold start is probably not the cause.

Issue [lab-platform#17](https://github.com/jross24/lab-platform/issues/17) has the first observation of the cold chain (3.8 s before the tracing change).
The lab did not yet run a canary under this threshold in Production. Look at the graph "Duration of the alias live" after the first gradual releases, and adjust the value.

## What a canary means for a web application

A web page differs from an API. A person sees the result, and the browser asks for more files after it gets the HTML.

1. **Two versions at one time.** During the 5-minute canary in Production, 10 percent of the page loads come from the new version and 90 percent from the old version.
   There is no stickiness. One visitor can see both versions in two reloads. The table of versions on the page shows the version of web that served it.
2. **This lab has no assets to break.** The lab ships no static assets. The page has one inline `<style>` block and no script. So nothing can break between two versions.
3. **A real application breaks on hashed asset files.** A real server-side rendered application ships files with a hash in the name, for example `app.3f9a1c.js`.
   The HTML of version N+1 asks for `app.<new hash>.js`. A request for that file can reach a server of version N, or a CDN origin that has only the old files. The file is missing, and the page breaks.
   The same happens after the release is complete. A visitor who still holds old HTML asks for the old hashed files. The new deployment removed them.
4. **The usual fix.** Serve the assets from object storage and a CDN (S3 and CloudFront). Give each file a content hash in its name.
   Upload the new files **before** the code release. Keep the old files for some days or weeks, and do not delete them with the release. Then both HTML versions find their files.
   Frameworks also offer version skew protection. It pins a visitor to one version.
5. **What this lab does instead.** Nothing. The lab does not need it, because it has no assets. This is a limit of the lab. A canary here proves the traffic shift and the alarms, and not the safety of assets.

## The Production drill for web

The steps and the expected result are in the [core README](https://github.com/jross24/lab-svc-core/blob/main/README.md#the-production-drill). For web:

1. Make a branch. In `lib/stages.ts`, set `injectFault: true` in the `Production` block.
2. In `test/app.test.ts`, set `DRILL_STAGES` to `['Production']`. The guard test fails if you change only one of the two files.
3. Open the pull request with the title `fix: drill, inject a fault in production`. Merge it. The release waits at `deploy-production`.
4. Approve, and start this loop for 6 minutes. About one call in ten fails, because the canary gets 10 percent of the calls. With the fault on, `GET /health` fails too.
   ```
   WEB=$(aws ssm get-parameter --name /lab/web/url --profile lab-prod --query Parameter.Value --output text)
   for i in $(seq 1 180); do curl --silent --output /dev/null --write-out "%{http_code} " "$WEB/"; sleep 2; done
   ```
5. Expect the alarms to fire and CodeDeploy to roll back, as the core README describes. The job `deploy-production` fails. Do not re-run it.
   Revert with the title `fix: remove the drill fault`: `injectFault: false` and `DRILL_STAGES` set to `[]`.

A dry run with exactly these two edits passed lint, typecheck, all the tests and `cdk synth`. `INJECT_FAULT` appeared only in the Production template.
The lab has not run the drill in Production.

## What this lab leaves out

A real server-side rendered application does more. This lab keeps only the part that the pipeline needs to show.

- **No static assets.** A real application serves CSS, images and fonts from a CDN or an S3 bucket. This page has one small inline `<style>` block.
  See "What a canary means for a web application" for what this means for a release.
- **No client code.** A real application ships a JavaScript bundle. The bundle hydrates the HTML and makes the page interactive. This page has no script, so nothing runs in the browser.
- **No framework.** A real application often uses a framework such as Next.js for routing, data loading and the build. This lab calls `react-dom/server` directly.
- **No streaming and no cache.** The function waits for both APIs and sends the whole page at once. The response has `cache-control: no-store`.
- **No sign-in.** The profile is the same for each visitor, because the account API returns a fixed mock profile.

## Feature flags

The page shows a discount beside a product when the catalogue API sends one, for example `10% off`, with `data-testid="discount"`.
The catalogue sends a discount only while its flag `show-discounts` is on, so the page stays the same while the flag is off.
The stage setting `forwardFlagOverride` is true for Test and Dev and false for Staging and Production.
Where it is true, the page copies a valid `x-lab-flags` header of `GET /` to the catalogue request and drops any other value, so `curl -H 'x-lab-flags: show-discounts=on' "$TEST_URL"` shows the discounts of Test.

## Stages

One `cdk synth` makes three CDK stages: `Test`, `Staging` and `Production`.
Each stage holds one stack, `lab-web`. The file `lib/stages.ts` holds the settings that differ between stages.

| Setting | Test | Staging | Production |
| --- | --- | --- | --- |
| `logRetentionDays` | 7 | 7 | 30 |
| `release` | all at once | all at once | canary: 10 percent, then 100 percent after 5 minutes |
| `injectFault` | false | false | false |
| `forwardFlagOverride` | true | false | false |
| `traceSampleRatio` | 1 | 1 | 1 |

Every stage has the same resources: the same alias, the same deployment group, the same alarms and the same dashboard.
Only the values in the table differ. So Test runs what Production runs. A unit test checks this: it compares the three templates.

`injectFault` is a device for the release drill. See "The Production drill for web". No stage sets it in `main`.
`traceSampleRatio` is the share of new traces that are sampled. See "The export stays on the request path, and the sampling ratio" in the Tracing section.

The code names no AWS account and no region. A stack goes to the account of the credentials that deploy it.
All three stages use the same bundled Lambda code.

## How a change reaches Production

1. Open a pull request. The `pr` workflow runs lint, typecheck, the tests and `cdk synth`. It also scans the dependencies and the commits for secrets, and it checks the workflow files. It posts the `cdk diff` against Production as one comment. A delete or a replacement of a stateful resource fails the check until someone adds the label `destructive-change-approved`. The [README of lab-workflows](https://github.com/jross24/lab-workflows#the-cdk-diff-comment) explains the comment.
2. Merge the pull request with a squash. The `release` workflow starts.
3. The workflow works out the next version from the commit title and creates the tag, for example `v0.2.0`.
4. The workflow builds one time and stores the zipped `cdk.out` in a GitHub release.
5. The workflow takes the lock of Test. It checks the deployment order, deploys that same zip to Test, and runs the end-to-end suite. The suite also checks that Test reports the version of the release. The workflow records the four versions that passed as `tested-with.json` on the GitHub release.
6. The workflow checks the order and the tested set again in Staging, deploys the zip there, and runs the smoke subset of the suite. CodeDeploy moves the traffic at once in Test and in Staging.
7. The workflow waits. A reviewer approves the `production` environment in GitHub. A newer release that reaches this point cancels an older release that still waits. After the approval the workflow checks again, deploys the same zip to Production, and runs the smoke subset. CodeDeploy moves 10 percent of the traffic, waits 5 minutes and moves the rest.
   If the smoke subset fails, the job fails and a redeploy of the earlier version waits for the reviewer.

The README of [lab-workflows](https://github.com/jross24/lab-workflows) explains each step.

A title that starts with `feat:` gives a minor version. A title with `!` before the colon gives a major version. Any other title gives a patch version.

To go back to an old version, run the `redeploy` workflow. It deploys the stored zip of that release and does not build.

```
gh workflow run redeploy.yml -f version=0.1.0 -f environment=test
```

The three files in `.github/workflows/` are copies of the files in lab-svc-catalogue. This repository has no other pipeline code.

## The contract files

The file `expectations.json` lists the fields that the page reads from `GET /products` of catalogue and from `GET /profile` of account.
The application serves HTML to people and offers no API to another service, so it has no `contract.json`.
On each pull request, the job `pr / contracts` compares the file with the contracts in Production and fails if a field is missing.
The test `test/expectations.test.ts` runs the real parsers of `lib/upstream.ts` against the file, so the file and the code cannot drift apart.

## Run the checks locally

You need Node.js 22.18 or later. Node.js runs the TypeScript files directly, so there is no build step.
esbuild bundles the Lambda code during `cdk synth`. It writes one ES module, `index.mjs`, and it also compiles the JSX. You do not need Docker.

```
npm ci
npm run lint
npm run typecheck
npm test
npm run synth
```

The tests and the synthesis do not need AWS credentials or a network.
The tests of the bundle read the synthesized `index.mjs`. They check the file name, the size of the OpenTelemetry code in it, and that it holds the production build of React only.

## Deploy to a personal account

Do not deploy `Test`, `Staging` or `Production` from a laptop. Only the pipeline deploys them.

For your own experiments there is a fourth stage, `Dev`. The context value `dev=true` selects it.
With `dev=true` the app makes only the `Dev` stage, so the command cannot touch a pipeline stage by accident.

```
npx cdk deploy -c dev=true "Dev/*" --profile <your-dev-profile>
npx cdk destroy -c dev=true "Dev/*" --profile <your-dev-profile>
```

The deployment-order rule applies here too. Deploy the `Dev` stage of core, catalogue and account to the account first.
The `Dev` stage has the alias, the deployment group, the alarms and the dashboard too. It releases all at once.

## Layout

| Path | Content |
| --- | --- |
| `bin/app.ts` | The entry point that `cdk.json` names. |
| `lib/app.ts` | Reads the context values and makes the stages. |
| `lib/stages.ts` | The typed settings of each stage: log retention, the release type and the fault switch. |
| `lib/web-stage.ts` | The CDK stage. |
| `lib/web-stack.ts` | The stack: SSM lookups, function (512 MB, ES module bundle with the production build of React only, one X-Ray statement), alias and release, API, dashboard, SSM parameters, outputs. |
| `lib/gradual-release.ts` | **Copy of core.** The alias, the deployment group, the three alarms and the `Release` type. |
| `lib/service-dashboard.ts` | **Copy of core.** The dashboard of a stage. |
| `lib/instrument.ts`, `lib/logger.ts`, `lib/metrics.ts` | **Copy of core.** The wrapper of the handler (it makes the server span), the log line and the metric line. |
| `lib/tracing.ts` | **Copy of core.** The OpenTelemetry tracing: the server span, the client span, the header `traceparent` and the flush. |
| `lib/xray-exporter.ts` | **Copy of core.** Sends the spans to the OTLP endpoint of X-Ray. |
| `lib/sigv4.ts` | **Copy of core.** AWS Signature Version 4. Only the exporter uses it. |
| `lib/function-defaults.ts` | **Copy of core.** The memory (512 MB) and the esbuild settings (ES module) of the function. |
| `lib/web-handler.ts` | The Lambda handler. It routes the two requests, calls the two APIs, sets the signal `degraded` and holds the fault switch. |
| `lib/upstream.ts` | Calls the two APIs, with a time limit and a client span, and checks the answers. |
| `lib/page.tsx` | The React components. They are pure: data in, markup out. |
| `expectations.json` | The fields that the page reads from catalogue and account. `test/expectations.test.ts` checks that the parsers need exactly these fields. |
| `test/` | The unit tests (vitest). `tracing.test.ts`, `xray-exporter.test.ts`, `sigv4.test.ts`, `function-defaults.test.ts`, `contract-schema.test.ts` and `support/contract-schema.ts` are copies of the files of core. |
| `.github/workflows/` | Three small files that call the workflows in lab-workflows. |
