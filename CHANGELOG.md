# Changelog

## 0.1.0

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
