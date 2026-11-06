<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/nace.dark.svg">
    <source media="(prefers-color-scheme: light)" srcset=".github/assets/nace.svg">
    <img src=".github/assets/nace.svg" alt="Nace" height="64" align="middle">
  </picture>
  &nbsp;&nbsp;×&nbsp;&nbsp;
  <img src=".github/assets/n8n-brand.svg" alt="n8n" height="64" align="middle">
</p>

<h1 align="center">Drex for n8n</h1>

<p align="center">Typed decisions with calibrated probabilities (yes/no, classify, score, route) in your n8n workflows, powered by Drex from Nace.</p>

<p align="center">
  <a href="https://github.com/nace-ai/n8n-nodes-nace/actions/workflows/ci.yml"><img src="https://github.com/nace-ai/n8n-nodes-nace/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT"></a>
  <a href="https://docs.n8n.io/integrations/community-nodes/"><img src="https://img.shields.io/badge/n8n-community%20node-EA4B71.svg" alt="n8n community node"></a>
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#credentials">Credentials</a> ·
  <a href="#operations">Operations</a> ·
  <a href="#example-workflows">Examples</a> ·
  <a href="#limits">Limits</a> ·
  <a href="#errors">Errors</a>
</p>

**Drex by Nace** evaluates typed questions, classifies and scores content, and routes items by label and confidence. It works as an n8n AI Agent tool. The package uses the Nace API or OpenRouter and has no runtime dependencies.

## Why Drex

- **Calibrated probabilities.** Read the full answer distribution alongside each decision.
- **Route with Unsure.** Send low-confidence decisions and continued errors to a dedicated output.
- **Image decisions on Drex Max.** Ask typed questions about images from your workflow.

## Install

On self-hosted n8n:

1. Open **Settings > Community Nodes > Install**.
2. Enter `@nace-ai/n8n-nodes-nace` and acknowledge the community node notice.
3. Install the package and add **Drex by Nace** to a workflow.

See [n8n community node installation](https://docs.n8n.io/integrations/community-nodes/installation/).

This package does not imply availability on n8n Cloud. Cloud availability requires separate verification.

## Credentials

1. Obtain an API key from [Nace Console](https://console.nace.ai).
2. Create a **Nace API** credential in n8n. Paste the key into **API Key**, a password field.
3. Select **Nace**. Use the visible **Base URL** `https://console.nace.ai`. Custom compatible HTTPS endpoints are allowed, except hosts ending with `openrouter.ai`. HTTP is allowed only for Nace on `localhost`, `127.0.0.1`, or `[::1]`.
4. Test the credential. Nace uses `GET /v1/models` with bearer authentication.
5. Select the credential in your Drex node.

Keys belong in credentials, never workflow JSON.

For OpenRouter, use an OpenRouter key and choose **OpenRouter**. Set **OpenRouter Base URL** to `https://openrouter.ai/api`. Its connection test uses the authenticated `GET /v1/key` endpoint, so an invalid key fails the test.

Nace reads `baseUrl`. OpenRouter reads its separate `openRouterBaseUrl` field. Switching backend never reuses the other backend's URL. Each backend uses its own default when its URL field is empty.

OpenRouter URLs must use `openrouter.ai` or a subdomain of it. Incompatible hosts are refused before sending credentials, including during connection tests. Base URLs must not contain userinfo, query parameters, or fragments. The node normalizes the origin and path and removes trailing slashes. The credential test uses n8n’s standard declarative request and reports only n8n’s status/message. Its URL is validated and normalized by the credential authentication step.

## Operations

| Operation | What it does | Output |
| --- | --- | --- |
| **Evaluate** | Ask multiple typed questions in one request | `answers`, keyed by question ID, with full probabilities when provided |
| **Classify** | Choose a label for each input item | `answers.classify.choice`, confidence, and probabilities |
| **Score** | Rate content against levels ordered low to high | `answers.score.score`, legend, and probabilities |
| **Route** | Send each item to a label output or Unsure | `answers.route`, probabilities, and `routeLabel` |

### Evaluate

Set **State Format** to Text, JSON, or Whole Input Item. Whole Input Item uses the input item's JSON and excludes binary data.

Use **Questions > Define Below** to add questions with unique IDs. Or choose JSON mode:

<details>
<summary>JSON example: refund, team, and urgency</summary>

```json
{
  "refund": {
    "type": "noul",
    "instructions": "Is the customer asking for a refund?",
    "criteria": { "true": "Refund requested", "false": "No refund requested" }
  },
  "team": {
    "type": "choice",
    "instructions": "Which team should handle this?",
    "criteria": { "billing": null, "support": "Technical problems" }
  },
  "urgency": {
    "type": "score",
    "instructions": "How urgent is this?",
    "criteria": ["Low", "Medium", "High"]
  }
}
```

For state `My invoice was charged twice. Please refund the duplicate.`, inspect `answers.refund.noul`, `answers.team.choice`, and `answers.urgency.score`.

</details>

Noul is a numerical truth estimate, not a JavaScript boolean. Score levels run from low to high. Use the returned legend and probabilities to interpret the score.

Every question sends `instructions` as a string, including `""` when omitted. Choice options with no description send `null`.

### Classify

Choose **Classify** and enter `Which team should handle this ticket?` as Instructions. Add labels `billing` and `support`. Use `={{ $json.ticket }}` as State.

Label names and descriptions accept expressions. They resolve separately for each input item. The output includes `answers.classify.choice`, confidence, and the full probability distribution.

### Score

Choose **Score** and enter `Rate urgency`. Add levels `Routine`, `Soon`, and `Immediate`, from low to high.

For state `Production checkout is unavailable`, inspect `answers.score.score`, `legend`, and `probabilities`.

### Route

Choose **Route** and add labels `billing`, `support`, and `sales` in that order. Enter routing instructions. Each label gets an output in the configured order. A final **Unsure** output is always present.

Set **Confidence Threshold**, for example `0.8`. Lower-confidence answers go to Unsure. Confidence equal to the threshold uses the label output. A threshold of `0` disables confidence-based fallback. Continued errors still go to Unsure.

Configure at least one label. `Unsure` is reserved, regardless of case. Label names are fixed because they determine workflow connections. Descriptions accept expressions.

Route retains the complete `answers.route` response and probabilities by default. Its JSON includes `routeLabel`, the chosen label or `Unsure`.

As an AI Agent tool, Route returns all results on one output. This lets the tool adapter receive every result. Use `routeLabel` to identify the decision.

## Models and images

The model dropdown skips entries explicitly marked retired and identifies aliases. Nace loads `GET /v1/models`. Model loading uses at most one retry. OpenRouter lists only IDs starting with `nace-ai/`.

The default model field is `drex-v2.0`. Use a `nace-ai/` ID for OpenRouter. To enter an ID absent from the dropdown, switch the field to an expression, such as `={{ 'drex-max' }}`. The list remains open to new models.

Images require a model whose ID contains `drex-max`. Enter input binary field names in **Input Binary Fields**, such as `front,back`.

The node reads n8n binary data, including externally stored binary data. It sends data URLs in the configured order. Refer to them as **Image 1**, **Image 2**, and so on. Reversing the field names reverses image numbering.

For an invoice, use `drex-max` and binary field `invoice`. Ask `Does Image 1 show an invoice with a readable total?`.

Images on other models are refused before an API request. AI Agent tool calls cannot supply binary attachments. Use a normal workflow node for image evaluation.

## Limits

| Model or limit | Nace | OpenRouter |
| --- | --- | --- |
| Text model | `drex-v2.0` | `nace-ai/drex-v2.0` |
| Image model | `drex-max` family | `nace-ai/drex-max` family |
| Questions per request | 1–512 on every model | 1–512 on every model |
| Images per request | **8 maximum** | **4 maximum**, served through DeepInfra |
| Image formats | PNG, JPEG, WebP; magic bytes checked | PNG, JPEG, WebP; magic bytes checked |
| Size per image | 16 MiB maximum | 16 MiB maximum |
| Total image bytes | 32 MiB maximum | 32 MiB maximum |
| Complete UTF-8 JSON body | **Smaller than 4 MiB**, base64 included | **Smaller than 4 MiB**, base64 included |
| Decision response body | 8 MiB maximum | 8 MiB maximum |
| Model-list response body | 16 MiB maximum | 16 MiB maximum |

These limits are checked client-side. Response caps apply to node execution and model loading; credential tests use n8n’s standard request handling. Exceeding the selected backend's image limit is refused before a request. Binary metadata sizes are checked before loading files when present. Actual byte counts and image signatures are checked after loading. The running JSON budget stops loading further images once the limit is reached. The JSON body limit is usually the binding image limit. Resize images before sending.

## Output and options

Default output preserves `answers`, including probabilities, plus `model`, `usage`, `request_id`, and `evaluation_time_ms`.

The node reads `request_id` from the response body, then the `x-request-id` response header. Only OpenRouter also falls back to the body's generation `id`. IDs must be strings or numbers. An array-valued header uses its first element. If no valid ID exists, `request_id` is omitted. Error descriptions use the same backend-specific order.

A successful response must contain a JSON object. Other body types produce a clear unexpected-response error. Every requested question must have an answer of the correct type. Noul values, confidence, and probability values must be numbers between 0 and 1. Choices must match the requested labels, and scores must be numbers. Invalid answers produce an unexpected-response error naming the question. They never reach a Route label output.

| Option | Behavior |
| --- | --- |
| **Simplify** | Returns `{ "value": ..., "confidence": ... }` for each answer. Omits probability distributions and legends. Metadata remains available. |
| **Include Other Input Fields** | Copies input JSON and binary data into output. Response fields take precedence on collisions. Items retain n8n pairing. |
| **Timeout** | Defaults to 60000 ms per attempt. The configured value applies to every attempt. |
| **Max Retries** | Defaults to 5 additional attempts. Capped at 10. Applies only to HTTP 429 and 529. |

Retries use `retry-after-ms`, then `retry-after` seconds or an HTTP date. Without retry headers, waits grow from 2 to 4, 8, 16, then 30 seconds per wait. Header-specified waits are capped at 60000 ms. Total sleep is capped at 120000 ms per input item. Once that budget is exhausted, the last API error is returned.

Timeouts and transport errors are surfaced without retrying.

### Continuing after errors

Enable **On Error > Continue** to keep processing later input items. This includes failures while resolving parameter expressions. Items that cannot be processed contain the message in `json.error` and, when available, details in `json.description` (including issue paths and request IDs). Messages name the relevant parameter and include `[Item N]` when the item is known. **Include Other Input Fields** also retains input JSON and binary attachments on continued errors. Error fields take precedence on collisions, and items retain n8n pairing.

| Route error setting | Destination |
| --- | --- |
| **Continue** | Final **Unsure** output, even at threshold `0`, with full error JSON. |
| **Continue (using error output)** | n8n moves failed items from Unsure to its separate **Error** output. |

Label outputs receive successful decisions only. With **Continue**, downstream nodes can check `$json.error`; descriptions and optional input fields remain available. With **Continue (using error output)**, the node sets `item.error` for n8n routing, and n8n normalizes the item's JSON to `{ "error": "message" }`. Pairing and optional binary attachments remain. Tool invocations collect results on their single output before n8n applies the selected error handling.

## Errors

| Status | What to do |
| --- | --- |
| **401** | Check the API key and selected backend. |
| **402** | Add funds through [Nace Billing](https://console.nace.ai) or [OpenRouter Credits](https://openrouter.ai/settings/credits), matching the selected backend. |
| **422** | Read every issue path and message in the error description. |
| **429 / 529** | Retries follow the configured policy. Exhausted attempts return an API error. |

During node execution, the exact credential API key is replaced with `[REDACTED]` in successful JSON responses and every generated message. Errors retain only a redacted projection of the HTTP code, error type, message, issue paths and messages, and request ID. Original transport errors, request configuration, raw response bodies, and transport causes are never attached. Credential tests report only n8n’s status/message; they do not use this custom response projection.

API error descriptions include the request ID when provided. Share it with support when investigating a failure. Validation errors identify the offending field or limit.

## OpenRouter

Use `nace-ai/drex-v2.0` for text or `nace-ai/drex-max` for images. The request path is `/v1/systemone` under `https://openrouter.ai/api`. A model ID without the `nace-ai/` prefix is refused before a request, with a suggested prefixed ID. HTTP 402 errors link to [OpenRouter Credits](https://openrouter.ai/settings/credits).

Images go into `state` as a content array of text and `image_url` parts. There is no top-level `images` field. JSON state is serialized in the text part.

Requests include `HTTP-Referer: https://nace.ai` and `X-OpenRouter-Title: Drex for n8n`.

The model dropdown requests `GET /api/v1/models?output_modalities=all`. This includes Drex decision models. It filters to `nace-ai/` IDs and displays each model's name and description when supplied. The Nace model request remains `GET /v1/models`.

OpenRouter responses include `usage.cost` and may include `provider`. The node keeps usage and provider as returned. With full output, **Simplify** off, a score's `legend` is passed through unchanged. OpenRouter may return an object keyed by index instead of an array.

Only the OpenRouter backend uses its generation `id`, such as `gen-dec-...`, as `request_id` when neither a body request ID nor an `x-request-id` header is present.

All API requests, model loading, and credential tests include `User-Agent` and `X-Nace-Client`. Both are set to `n8n-nodes-nace/<package version>`.

## Example workflows

Import JSON from [examples/](examples/). Then select credentials by name.

| Workflow | What it demonstrates |
| --- | --- |
| [Support ticket triage](examples/support-ticket-triage-route.json) | Synthetic tickets routed by team, with Unsure fallback |
| [Invoice image check](examples/invoice-image-check-drex-max.json) | A generated synthetic invoice PNG evaluated with Drex Max |
| [AI Agent tool gating](examples/ai-agent-tool-gating.json) | A Drex approval gate as an AI Agent tool. Configure the agent's chat model credential too. |

## Development

With dependencies already installed, run `npm run build`, `npm run lint`, `npm test`, and `npm pack --dry-run`.

The package has no runtime dependencies. It uses `n8n-workflow` as a peer. Tests use mocked authenticated HTTP and synthetic images. Live API, UI, Docker installation, and OpenRouter checks must be performed separately.

CI and publishing both run unit tests before proceeding. The development CLI is pinned to `0.55.5`. Workflow actions are pinned by commit SHA. Checkouts have read-only permissions and do not persist credentials.

Publishing runs on version tags matching `*.*.*` (the format `npm run release` creates, such as `1.2.3`) or by manual dispatch. A build job installs dependencies, lints, tests, builds, and packs the package without OIDC publishing permission. It uploads the tested tarball. A separate publish job downloads that artifact and runs `npm publish <tarball> --provenance --access public --ignore-scripts`. It does not install dependencies or execute package lifecycle scripts.

Before release, configure npm trusted publishing for owner `nace-ai`, repository `n8n-nodes-nace`, workflow `publish.yml`, and environment `npm-publish`. Create that GitHub environment and require reviewers. The publish job uses GitHub OIDC; no `NPM_TOKEN` is needed. A manual run publishes the selected ref after checks and environment approval. Development checks do not publish the package.

---

[MIT licence](LICENSE). Copyright (c) 2026 Nace.

n8n is a trademark of n8n GmbH; this is a community node by Nace and is not affiliated with or endorsed by n8n.
