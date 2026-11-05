# Changelog

## 0.1.0

- Require HTTPS except local Nace development endpoints; reject URL userinfo, queries, and fragments and normalize endpoint paths.
- Use n8n’s standard declarative credential test with validated, normalized URLs and n8n status/message reporting. Remove the node-level tester and deprecated-helper exemption.
- Use e.g. text placeholders and parameter-specific messages with item numbers; preserve API type strings.
- Redact successful JSON and construct execution errors from fixed safe projections without raw transport causes or request config.
- Validate every requested answer before simplifying or routing; skip malformed model entries and report malformed lists clearly.
- Bound responses at 8 MiB for decisions and 16 MiB for model lists. Check image signatures, metadata sizes, and running JSON budgets.
- Require OpenRouter model prefixes, use its credits link, reserve Unsure route labels, limit model loading to one retry, and support Retry-After HTTP dates.
- Pin the development CLI and workflow actions; isolate tarball building from environment-protected OIDC publishing.
- Add deep error inspection and regression coverage for URL, credential, response, image, retry, and workflow behavior.

- Enforce backend-specific image counts before requests: 4 on OpenRouter (DeepInfra), 8 on Nace.
- Default to 5 retries with headerless backoff starting at 2 seconds, doubling to a 30-second cap; preserve retry-header handling and the 120-second total sleep budget.

- Include OpenRouter decision models with `output_modalities=all`, displaying model names and descriptions while retaining Nace-only filtering.
- Fall back from body request ID to response header, then generation ID for OpenRouter only, for successful outputs and API error descriptions. Accept only scalar IDs and use the first element of array-valued headers. Reject non-object success responses clearly; tolerate missing IDs and bodyless errors. Preserve returned usage costs, provider, and full score legends.

- Use only each backend's own base URL field and default. Refuse OpenRouter hosts for Nace and non-OpenRouter hosts for OpenRouter before requests and credential tests; validate OpenRouter keys with `/v1/key` and filter its model list to Nace models.
- Fix label names only for Route; Classify label expressions resolve per item. Reject missing Route labels and continue after per-item parameter errors.
- Always append Unsure after Route labels; send low-confidence answers and continued errors there. Threshold 0 disables confidence-based fallback while preserving error isolation.
- Preserve continued error markers and binary attachments, and document n8n's separate Error output behavior.
- Return all Route tool results on one output with `routeLabel`.
- Redact credential keys from API and transport errors before constructing n8n errors.
- Cap retry sleeps at 60 seconds each and 120 seconds total while retaining per-attempt timeouts.
- Run unit tests in both CI and the publishing workflow.

- Add Drex by Nace with Evaluate, Classify, Score, and dynamic Route outputs.
- Add Nace API credentials, model loading, and optional OpenRouter backend.
- Validate image formats, model support, question count, and request size locally.
- Preserve answer probabilities and metadata; support simplified answers and input fields.
- Add structured API errors, request attribution, and bounded retries on 429/529.
- Add mocked unit tests and importable example workflows.
