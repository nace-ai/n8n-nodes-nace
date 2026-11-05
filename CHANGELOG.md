# Changelog

## 0.1.0

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
