# src/models/ (owned by the models package, DESIGN-agnostic §7.5)

`src/registry/models.ts` imports `index.ts` and calls `createModels(config.models, deps)`. These modules are needed only when a pack or case uses a judge, a user simulator, host-sim or the intent writer. Runs that use none of them never call a model.

| File | What it does |
|---|---|
| `provider.ts` | The `Provider` contract (effective body plus send), `ModelHttpError`, `familyOf`, the RPM bucket and the optional extra deps |
| `vertex.ts` | **Default provider.** Vertex AI Gemini through the OpenAI-compatible endpoint, with ADC from `gcloud auth application-default print-access-token`. Accepts `google/gemini-*` only. Adds the thought-signature shim and drops the fields Vertex refuses. A lost credential throws `AuthLostError`, never `process.exit`. |
| `openai-compatible.ts` | Any `/chat/completions` endpoint. The key comes from `api_key_env`. |
| `fake.ts` | Deterministic fakes: a `provider: "fake"` provider, `fakeOpenAIFetch` and `fakeExec` |
| `http.ts` | Retry policy: back off on 429, 5xx, HTML 404 and network errors; refresh once on 401; any other 4xx throws `HarnessError` |
| `chat.ts` | One pipeline for every provider: cache lookup, then worst-case reservation, then the call, then actual cost and a cache write |
| `cache.ts` | Content-hash cache: `sha256(canonical({provider, model, body, salt}))` under `cacheDir` |
| `ledger.ts`, `prices.ts` | Hard spend cap (`SpendStopError` 402) and list prices (`verified: false`, overridable) |
| `judge.ts` | Pointwise judge. It is advisory until `judges/registry.json` admits the exact dimension, model, prompt SHA and rubric SHA, and only when the judge's family differs from the agent's. It refuses safety dimensions. |
| `user-sim.ts` | Persona simulator with a pinned prompt SHA and JSON-schema output |
| `intent-writer.ts` | Intents for `ves packs synthesize`. Each intent's args are validated against the tool's `input_schema`. |

Tests in `test/models/**` inject `fetch`, `exec`, `sleep` and the clock. `test/setup.ts` blocks real network.
