# lab-web

This repository holds the mock "web" application of the pipeline lab.
It is an AWS CDK app in TypeScript. The pipeline in [lab-workflows](https://github.com/jross24/lab-workflows) releases it.

The application has the same shape as [lab-svc-catalogue](https://github.com/jross24/lab-svc-catalogue).
This README explains what is different. The lab-svc-core README explains the stages and the release steps in more detail.

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

Both APIs are public, so the function sends plain requests. It signs nothing and needs no IAM permission.

The stack also writes its own address.

| Parameter | Value |
| --- | --- |
| `/lab/web/url` | The base URL of this application. A later end-to-end test reads it. |

The stack also sets `NODE_ENV=production` on the function. Lambda does not set it.
Without it, React runs its slow development build.

## Deployment order: core, then catalogue and account, then web

The services depend on each other in this order:

1. `lab-svc-core`
2. `lab-svc-catalogue` and `lab-svc-account`
3. `lab-web`

Deploy a service to an account only after the services before it are in that account.

CloudFormation reads `/lab/catalogue/url` and `/lab/account/url` when it deploys this stack.
If one of them does not exist, the deployment fails before it creates a resource.
The pipeline deploys each service on its own, so it does not enforce this order. You must keep it.

CloudFormation reads the parameters again at each deployment of this stack.
If an API gets a new URL, release or redeploy this application to pick it up.

## What this lab leaves out

A real server-side rendered application does more. This lab keeps only the part that the pipeline needs to show.

- **No static assets.** A real application serves CSS, images and fonts from a CDN or an S3 bucket. This page has one small inline `<style>` block.
- **No client code.** A real application ships a JavaScript bundle. The bundle hydrates the HTML and makes the page interactive. This page has no script, so nothing runs in the browser.
- **No framework.** A real application often uses a framework such as Next.js for routing, data loading and the build. This lab calls `react-dom/server` directly.
- **No streaming and no cache.** The function waits for both APIs and sends the whole page at once. The response has `cache-control: no-store`.
- **No sign-in.** The profile is the same for each visitor, because the account API returns a fixed mock profile.

## Stages

One `cdk synth` makes three CDK stages: `Test`, `Staging` and `Production`.
Each stage holds one stack, `lab-web`. The file `lib/stages.ts` holds the settings that differ between stages.

| Setting | Test | Staging | Production |
| --- | --- | --- | --- |
| `logRetentionDays` | 7 | 7 | 30 |
| `gradualRelease` | false | false | true |

`gradualRelease` is a placeholder. No code uses it yet.

The code names no AWS account and no region. A stack goes to the account of the credentials that deploy it.
All three stages use the same bundled Lambda code.

## How a change reaches Production

1. Open a pull request. The `pr` workflow runs lint, typecheck, the tests and `cdk synth`.
2. Merge the pull request with a squash. The `release` workflow starts.
3. The workflow works out the next version from the commit title and creates the tag, for example `v0.2.0`.
4. The workflow builds one time and stores the zipped `cdk.out` in a GitHub release.
5. The workflow deploys that same zip to Test, then to Staging.
6. The workflow waits. A reviewer approves the `production` environment in GitHub. Then the workflow deploys the same zip to Production.

A title that starts with `feat:` gives a minor version. A title with `!` before the colon gives a major version. Any other title gives a patch version.

To go back to an old version, run the `redeploy` workflow. It deploys the stored zip of that release and does not build.

```
gh workflow run redeploy.yml -f version=0.1.0 -f environment=test
```

The three files in `.github/workflows/` are copies of the files in lab-svc-catalogue. This repository has no other pipeline code.

## Run the checks locally

You need Node.js 22.18 or later. Node.js runs the TypeScript files directly, so there is no build step.
esbuild bundles the Lambda code during `cdk synth`. It also compiles the JSX. You do not need Docker.

```
npm ci
npm run lint
npm run typecheck
npm test
npm run synth
```

The tests and the synthesis do not need AWS credentials or a network.

## Deploy to a personal account

Do not deploy `Test`, `Staging` or `Production` from a laptop. Only the pipeline deploys them.

For your own experiments there is a fourth stage, `Dev`. The context value `dev=true` selects it.
With `dev=true` the app makes only the `Dev` stage, so the command cannot touch a pipeline stage by accident.

```
npx cdk deploy -c dev=true "Dev/*" --profile <your-dev-profile>
npx cdk destroy -c dev=true "Dev/*" --profile <your-dev-profile>
```

The deployment-order rule applies here too. Deploy the `Dev` stage of core, catalogue and account to the account first.

## Layout

| Path | Content |
| --- | --- |
| `bin/app.ts` | The entry point that `cdk.json` names. |
| `lib/app.ts` | Reads the context values and makes the stages. |
| `lib/stages.ts` | The typed settings of each stage. |
| `lib/web-stage.ts` | The CDK stage. |
| `lib/web-stack.ts` | The stack: SSM lookups, function, API, SSM parameter, outputs. |
| `lib/web-handler.ts` | The Lambda handler. It routes the two requests and calls the two APIs. |
| `lib/upstream.ts` | Calls the two APIs, with a time limit, and checks the answers. |
| `lib/page.tsx` | The React components. They are pure: data in, markup out. |
| `test/` | The unit tests (vitest). |
| `.github/workflows/` | Three small files that call the workflows in lab-workflows. |
