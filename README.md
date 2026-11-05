# n8n-nodes-nace

**Drex by Nace** evaluates typed questions, classifies and scores content, and routes items by label and confidence. It also works as an n8n AI Agent tool. Uses the Nace API or OpenRouter, with no runtime dependencies.

## Installation

On self-hosted n8n, open **Settings > Community Nodes > Install**, enter `n8n-nodes-nace`, acknowledge the community node notice, and install. Add **Drex by Nace** to a workflow. See [n8n community node installation](https://docs.n8n.io/integrations/community-nodes/installation/).

This package does not imply availability on n8n Cloud; Cloud availability requires separate verification.

## Credentials

1. Obtain an API key from [Nace Console](https://console.nace.ai).
2. Create a **Nace API** credential in n8n and paste the key into **API Key** (a password field).
3. Select **Nace** and use the visible **Base URL** `https://console.nace.ai`. A custom compatible endpoint may be entered, except hosts ending with `openrouter.ai`.
4. Test the credential. For Nace, the test calls `GET /v1/models` using bearer authentication.
5. Select the credential in your Drex node. Keys belong in credentials, never workflow JSON.

For OpenRouter, use an OpenRouter key, choose **OpenRouter**, and set **OpenRouter Base URL** to `https://openrouter.ai/api`. Nace uses `baseUrl`; OpenRouter uses its separate `openRouterBaseUrl` field. Switching backend never reuses the other backend’s URL. Each backend reads only its own URL field and uses its own default when that field is empty. OpenRouter URLs must use `openrouter.ai` or a subdomain of it. Incompatible hosts are refused before sending credentials, including during connection tests. The OpenRouter connection test calls the authenticated `GET /v1/key` endpoint, so an invalid key fails the test.

## Operations

### Evaluate

Ask multiple questions in one request. Set **State Format** to Text, JSON, or Whole Input Item (the input item's JSON, excluding binary data). Use **Questions > Define Below** to add questions with unique IDs, or choose JSON mode:

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

For state `My invoice was charged twice. Please refund the duplicate.`, inspect `answers.refund.noul`, `answers.team.choice`, and `answers.urgency.score`. Noul is a numerical truth estimate, not a JavaScript boolean. Score levels are ordered low to high; inspect the returned legend and probabilities when interpreting the score.

Every question sends `instructions` as a string, including `""` when omitted. Choice options with no description send `null`.

### Classify

Choose **Classify**, enter `Which team should handle this ticket?` as Instructions, and add labels `billing` and `support`. Use `={{ $json.ticket }}` as State. Label names and descriptions can use expressions and are resolved separately for each input item. The output includes `answers.classify.choice`, confidence, and the full probability distribution.

### Score

Choose **Score**, enter `Rate urgency`, and add levels `Routine`, `Soon`, `Immediate`, from low to high. For state `Production checkout is unavailable`, inspect `answers.score.score`, `legend`, and `probabilities`.

### Route

Choose **Route**, add labels `billing`, `support`, and `sales` in that order, and enter routing instructions. The node exposes one output for each label, in configured order. A final **Unsure** output is always present after the label outputs. Set **Confidence Threshold**, for example `0.8`, to send lower-confidence answers to the final **Unsure** output. Confidence equal to the threshold uses the label output. Set the threshold to `0` to disable confidence-based fallback; continued errors still go to Unsure. Route outputs retain the complete `answers.route` response and probabilities by default. Label names are fixed values, because they determine workflow connections; expressions are allowed in descriptions. Configure at least one label. Route output JSON includes `routeLabel`, the chosen label or `Unsure`. When Route runs as an AI Agent tool, all results are returned on a single output so the tool adapter receives every result; use `routeLabel` to identify the decision.

## Models and images

The model dropdown loads `GET /v1/models`, skips entries explicitly marked retired, and identifies aliases. On OpenRouter, it lists only IDs starting with `nace-ai/`. The default is `drex-v2.0`. To use a model ID absent from the dropdown, switch the field to an expression, for example `={{ 'drex-max' }}`. The list remains open to new models.

Images require a model whose ID contains `drex-max`. Enter binary property names in **Image Binary Properties**, for example `front,back`. The node reads n8n binary data, including externally stored binary data, and sends data URLs in that order. Refer to them as **Image 1**, **Image 2**, etc. Reversing property names reverses image numbering. For an invoice, use `drex-max`, property `invoice`, and ask `Does Image 1 show an invoice with a readable total?`.

Client-side limits:

- 1–512 questions per request, on every model.
- At most **8 images on Nace** or **4 images on OpenRouter** (Drex Max is served through DeepInfra). PNG, JPEG, or WebP only. Exceeding the selected backend’s limit is refused before an API request.
- At most 16 MiB per image and 32 MiB total image bytes.
- The complete UTF-8 JSON body must be **smaller than 4 MiB**, including base64. This is usually the binding image limit; resize images before sending.

Images on other models are refused before an API request. Binary attachments cannot be supplied through an AI Agent tool call; use a normal workflow node for image evaluation.

## Output and options

Default output preserves `answers` (including `probabilities`), `model`, `usage`, `request_id`, and `evaluation_time_ms`. The node sets `request_id` from the response body’s `request_id`, then the `x-request-id` response header. Only OpenRouter also falls back to the body’s generation `id`. IDs must be strings or numbers; an array-valued header uses its first element. When no valid ID is available, `request_id` is omitted. Error descriptions use the same backend-specific order. A successful response must contain a JSON object; other body types produce a clear unexpected-response error.

**Simplify** replaces each answer with `{ "value": ..., "confidence": ... }`; it intentionally omits probability distributions and legends. Metadata remains available. **Include Other Input Fields** copies the input JSON and binary data into output; response fields take precedence on collisions. Items retain n8n pairing.

**Timeout** defaults to 60000 ms per attempt. **Max Retries** defaults to 5 additional attempts and is capped at 10. Only HTTP 429 and 529 responses are retried, using `retry-after-ms`, then `retry-after` seconds, then exponential backoff when retry headers are absent (2, 4, 8, 16, then 30 seconds per wait). Header-specified waits are capped at 60000 ms, and total sleep is capped at 120000 ms per input item. Once that budget is exhausted, the last API error is returned. The configured request timeout is passed to every attempt. Timeouts and transport errors are surfaced without retrying.

Enable n8n's **On Error > Continue** to keep processing later input items, including when parameter expressions fail. Errors include a message and description and retain item pairing. With **Include Other Input Fields** enabled, continued error items retain both input JSON and binary attachments.

Route error handling depends on n8n's **On Error** setting:

- **Continue:** Route errors always go to the final **Unsure** output, including at confidence threshold `0`. Label outputs receive successful decisions only.
- **Continue (using error output):** n8n adds a separate **Error** output and moves error items from Unsure to the separate Error output. This node sets `item.error`, which n8n-core checks independently of the JSON fields. In n8n-core 2.46.5, a bare `json.error` is recognized only if all JSON keys are among `error`, `message`, and `details`; relying on `json.error` alone would fail when input fields or a description are included.

This behavior was checked against the locally cached n8n-core 2.46.5 `WorkflowExecute.handleNodeErrorOutput` implementation and the installed n8n-workflow output helper. Tool invocations collect continued errors on their single output.

## Errors

- **401:** check the API key and selected backend.
- **402:** add funds through [Nace Billing](https://console.nace.ai).
- **422:** the error description lists every issue path and message.
- **429 / 529:** retries follow the configured policy; exhausted attempts return an API error.

The exact credential API key is replaced with `[REDACTED]` throughout API and transport error payloads before n8n creates an error, including messages, descriptions, validation issues, nested causes, and echoed request IDs. API error descriptions include the request ID when provided. Share it with support when investigating a failure. Validation errors identify the offending field or limit.

## OpenRouter

Use model `nace-ai/drex-v2.0` for text, or `nace-ai/drex-max` for images. The request path is `/v1/systemone` under `https://openrouter.ai/api`. For images, state becomes a content array of text and `image_url` parts, with no top-level `images` field. JSON state is serialized in the text part. Requests include `HTTP-Referer: https://nace.ai` and `X-OpenRouter-Title: Drex for n8n`.

The model dropdown requests `GET /api/v1/models?output_modalities=all` to include Drex decision models, filters to `nace-ai/` IDs, and displays each model’s name and description when supplied. The Nace model request remains `GET /v1/models`.

OpenRouter responses include `usage.cost` and may include `provider`; the node keeps usage and provider as returned. With full output (Simplify off), a score’s `legend` is passed through unchanged: OpenRouter may return an object keyed by index instead of an array. For the OpenRouter backend only, its generation `id` (for example, `gen-dec-...`) is used as `request_id` when neither a body request ID nor an `x-request-id` header is present.

All API requests, model loading, and credential tests include `User-Agent` and `X-Nace-Client` set to `n8n-nodes-nace/<package version>`.

## Example workflows

Import JSON from [examples/](examples/), then select credentials by name:

- `support-ticket-triage-route.json`: synthetic tickets routed by team, with Unsure fallback.
- `invoice-image-check-drex-max.json`: generates a synthetic invoice PNG and evaluates it with Max.
- `ai-agent-tool-gating.json`: AI Agent with a Drex tool for an approval gate; configure the agent's chat model credential too.

## Development

With dependencies already installed, run `npm run build`, `npm run lint`, `npm test`, and `npm pack --dry-run`. The package has no runtime dependencies and uses `n8n-workflow` as a peer. Tests use mocked authenticated HTTP and synthetic images; live API, UI, Docker installation, and OpenRouter checks must be performed separately.

Both CI and publishing run the unit tests before proceeding. The tag-triggered GitHub Actions publish workflow uses `n8n-node release`, which enables npm provenance (`NPM_CONFIG_PROVENANCE=true`) in GitHub Actions, equivalent to `npm publish --provenance`. Configure npm trusted publishing for `nace-ai/n8n-nodes-nace` and `publish.yml` before releasing. No publishing is performed by the development checks.

## License

MIT. Copyright (c) 2026 Nace.
