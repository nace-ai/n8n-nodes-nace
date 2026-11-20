# Changelog

## 0.2.0

- Add the **Nace Document Intelligence** node (type `@nace-ai/n8n-nodes-nace.naceDocumentIntelligence`) with Document Parse, Document Extract, and Workspace Search operations. It uses the same Nace API credential; the OpenRouter backend is refused for document operations.
- Binary sources upload to a unique `n8n/` path using the granted upload URL and upload token, never the API key. The node deletes the uploaded file after the job and also deletes the job unless Keep Job is on, also when the job fails.
- Job calls wait with `wait_seconds` and poll until the final status, up to Max Wait (Seconds); a job that does not finish in time is cancelled unless Keep Job is on. Each job create carries an `Idempotency-Key`. Every output carries `job_id`, `request_id` when available, and `cost`.
- Max Wait (Seconds) bounds the whole job run: the create request waits up to 100 seconds (the longest Nace keeps an HTTP request open), no request is sent at or after the deadline, and each request's HTTP timeout is capped to the remaining budget. The bound is best-effort: a request already in flight, a retry inside the HTTP client, or job and file cleanup can run slightly past the deadline. A finished job whose result was not retained fails with an explanation instead of a retry suggestion, because a repeat run starts a new, billable job.
- A Parse download link — a `content_url` or `rows_url` anywhere in the result, for example in `document.spreadsheet.sheets[]` — keeps its job so the link stays usable, reported as `cleanup.job_kept` with the link that was found; Extract results are not searched, because their data fields are user data. Delete the kept job in the Nace console after fetching the full content. Rejected creates clean up the job Nace names in `x-drex-document-job`. Upload responses without usable file and workspace IDs are refused, and `cost` is always present, `null` when Nace does not report one.
- Add mocked unit tests with synthetic data for the new node.

## 0.1.1

- First release published from GitHub Actions with npm provenance, as n8n requires for verified community nodes. No functional changes from 0.1.0; the client version in `User-Agent` and `X-Nace-Client` is now 0.1.1.

## 0.1.0

- The package is published as `@nace-ai/n8n-nodes-nace`. The node type is `@nace-ai/n8n-nodes-nace.nace`.
- The API key is only sent to the origin of the credential's base URL, including from the HTTP Request node.
- Simplify reads each answer's value from the field that matches its validated type.
- With On Error set to Continue, failed items keep the error description and the input fields. Continue (using error output) still routes them to the Error output.
- Messages quote parameter names and say how to fix the issue. "Image Binary Properties" is now labelled "Input Binary Fields".

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
