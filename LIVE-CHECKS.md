# Live checks

Run on 2026-11-05 against Drex prod (run three times: before the review and after each fix round; the IDs are from the final run, and checks 10 and 11 are from the first) (`https://console.nace.ai`), using an internal test account. The package was built with `npm pack` (`n8n-nodes-nace-0.1.0.tgz`), installed with `npm install <tarball> --legacy-peer-deps` into the mounted `~/.n8n/nodes` of `n8nio/n8n:2.46.6` in Docker, and driven through n8n's REST API (credential create and test, dynamic options, workflow run). Installing the tarball added exactly one package, so there are no runtime dependencies.

| # | Check | n8n result | Drex result | Request ID |
|---|---|---|---|---|
| 1 | Credential **Test connection** (`GET /v1/models`) | `OK`, "Connection successful!" | | |
| 2 | Test connection with an invalid key | `Error`, "Unauthorized" | | |
| 3 | **Model dropdown** (`getModels`) | lists `drex-v1.5`, `drex-v2.0`, `drex-max`, `drex-max-v1.1`, `drex-max-finance` and `drex-latest`, each with its description | | |
| 4 | `drex-v2.0` text: noul, choice and score questions in one request | success | refund noul 0.9255; team `billing` 0.9135 (full probabilities); urgency score 1.31 with probabilities for levels 0, 1 and 2 | `req_48d16ff1e29416591ce0ef9c94d37f18` |
| 5 | `drex-max` with 2 images, order red, blue: "What is the colour of Image 1?" | success | `red`, p = 0.9997, 128 image tokens | `req_4268fb323c38f136cdd96f7063b6aaeb` |
| 6 | `drex-max` with 2 images, order blue, red | success | `blue`, p = 0.9998 | `req_e09f7bc1c3cc5588ef3e5803bb04e742` |
| 7 | **Route** (billing / support, plus the Unsure output, threshold 0.8) on 3 tickets | 3 outputs | double charge to `billing` (0.95), output 0; Android crash to `support` (0.91), output 1; "hi" (0.39) to **Unsure**, output 2 | `req_cc129c59d49709c1b97a294d7191015a`, `req_1ef99f04e8bbe59a8797b8ee0b219795`, `req_2015a2f4a7cb0c8a87b1c45839e8c610` |
| 8 | Images with `drex-v2.0` | refused client-side, no request sent: "Images require a drex-max model …" | | |
| 9 | Invalid key in a workflow (Classify) | error: "Invalid API key. Check your Nace API credential." with the error type | 401 | `req_89a3ae708db542c81bd2a42de82fb203` |
| 10 | Unknown model ID (free-form) | error shows the server's 422 message and the list of valid models | 422 `invalid_request_error` | |
| 11 | State over the 131,072-token limit | error shows the server's 422 message | 422 `invalid_request_error` | |
| 12 | Empty score criteria | refused client-side with a clear message | | |

## OpenRouter backend

Run on 2026-11-06 against `https://openrouter.ai/api`, on n8n 2.46.6 with the same tarball. OpenRouter returns its ID as `id` (`gen-dec-…`), and the node passes it through as `request_id`.

| # | Check | Result | Request ID |
|---|---|---|---|
| 13 | Credential **Test connection** (`GET /v1/key`) | `OK`. An invalid key gives `Error` "Unauthorized". | |
| 14 | **Model dropdown** (`GET /v1/models?output_modalities=all`, keeping `nace-ai/` IDs) | Lists Nace.AI: Drex Max, Drex v2.0 and Drex v1.5 | |
| 15 | `nace-ai/drex-v2.0` Evaluate (noul, choice, score) | success, with full probabilities | |
| 16 | `nace-ai/drex-max` images sent inside `state`, order red then blue | `red` | `gen-dec-1793910655-HBLvYj6woRvMPJwRiOIY` |
| 17 | Same, order blue then red | `blue` | `gen-dec-1793910658-47MAWHSNdV4godWdWzcm` |
| 18 | **Route** on 3 tickets | billing to output 0, support to output 1, "hi" (0.39) to **Unsure**, output 2 | `gen-dec-1793910663-NQQVN40m4FRQLt2Qfdm1`, `gen-dec-1793910664-8Kh4aoTVmtk3LLXZZOdF`, `gen-dec-1793910665-Asfqvod7MuYqs5QvO2UF` |
| 19 | 4 images | success. "Image 4" is `yellow`. | |
| 20 | 5 images | refused client-side: "OpenRouter: At most 4 images are allowed per request". DeepInfra returns HTTP 400 for a 5th image. | |

OpenRouter's "Model busy" 429 has no `retry-after` header and cleared within 15 to 35 s. With no retry header, the node waits 2, 4, 8 and 16 s, then 30 s.

## Security checks (live)

- An `http://` Base URL is refused by the credential test: "Base URL must use HTTPS. Only Nace on localhost, 127.0.0.1, or [::1] may use HTTP."
- A regression rerun of checks 4 to 8 on Nace direct after the security round passed: `req_e2207666b7971537f5cf0694d0dd8a64`, `req_66907dc44999c9e206c05506ff3ce197` (red), `req_43edce94b3a1291e9402378b7a048810` (blue), and Route `req_23e7949ee06ad3ef8997744d09a2e8e1`, `req_51e359b2450bf71e7ed9a5a17f5e6064`, `req_557b5410922542b7a92a547e1ff2cdcc`.

## Not run live

- **429/529 retries.** These can't be triggered on demand. Unit tests cover them. A live OpenRouter 429 was seen during testing, but outside n8n.
