# Email Classifier / Summarizer Lambda

AWS Lambda (Node.js 22, TypeScript) that processes short emails in one of two modes:

- `classify`: 1 to 3 topics per email from a predefined list
- `summarize`: a 1 to 2 sentence summary per email

The model sits behind a small adapter interface. Two adapters ship with the repo:

- `anthropic`: Claude (`claude-haiku-5-5` by default) through the official `@anthropic-ai/sdk`. Needs your own API key.
- `mock` (default): offline keyword rules, not a language model. It exists so the project runs and its tests pass without a key or network access, and it answers in the same JSON format as Claude, so parsing, validation and retries are exercised either way. Use `anthropic` to see real results.

## Running locally

Requires Node.js 22+.

```bash
npm install                    # installs dependencies and compiles TypeScript to dist/
node app/run.js --input sample/emails.json --mode classify --log-level INFO
node app/run.js --input sample/emails.json --mode summarize --log-level INFO
```

To use Claude, create a `.env` (gitignored) from the example and set the key:

```bash
cp .env.example .env           # then set PROVIDER=anthropic and ANTHROPIC_API_KEY=sk-ant-...
```

Results are printed to stdout and JSON logs go to stderr, so `node app/run.js -i sample/emails.json -m classify > results.json` gives you just the results.

Other useful commands:

```bash
node app/run.js -i sample/edge-cases.json -m classify   # invalid items, duplicates, long body, odd ids
npm test                                                # build + unit tests (node:test, no network)
npm run lint
```

With `PROVIDER=mock`, email 14 in `sample/edge-cases.json` contains `[simulate-provider-error]`, which makes the mock fail its batch. That shows the retry: the batch is retried email by email and only email 14 ends up as `processing_failed`.

## Input and output

The Lambda event is `{ "mode": "classify" | "summarize", "emails": [{ "id", "subject", "body" }] }` (see `sample/lambda-event.json`). The CLI builds it from `--mode` and the file given to `--input`.

The result is an array with one entry per input email, in input order:

```json
[
  { "id": 1, "topics": ["finance"] },
  { "id": 2, "topics": ["technical"] },
  { "id": 3, "topics": ["hr", "marketing"] },
  { "id": 4, "error": "empty_input" }
]
```

In `summarize` mode the entries are `{ "id": 1, "summary": "..." }`. Errors per email:

- `empty_input`: subject and body are both empty or whitespace
- `invalid_item`: not an object, no usable `id` (then `id` is `null`), or a subject/body that is not a string
- `processing_failed`: a valid email the model couldn't process, even after retrying it on its own

A bad email never stops the others. Only an unusable event (unknown mode, `emails` not an array) throws an `InputError`.

## How it works

```
src/
  handler.ts                    Lambda entry point
  cli.ts                        local runner used by app/run.js
  email.processor.ts            validate -> de-duplicate / cache -> batch -> call model -> merge results
  modes/                        classify and summarize: prompt + parsing of the reply
  llm/                          LlmAdapter interface, Anthropic and mock adapters
  schemas/email.schema.ts       event and email validation (zod)
  helpers/                      BatchPromptHelper, TextHelper, ConcurrencyHelper, ErrorHelper
```

For each invocation the processor:

1. Validates every email. Invalid and empty ones get their error result straight away and are logged at `WARN`.
2. Collapses whitespace, truncates long subjects and bodies, and groups identical emails, so each unique email is sent once. Emails seen in earlier invocations of the same container come from an in-memory LRU cache.
3. Sends the rest in batches of `BATCH_SIZE`, with up to `MAX_CONCURRENCY` calls in flight.
4. Parses the reply and validates each entry with zod. Topics outside the allowed list are dropped (`other` if none remain); summaries are cut to 2 sentences and 300 characters.
5. Retries what is worth retrying (see below).

### Retries and failures

| Failure                                                                            | What happens                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 429, 5xx (incl. overloaded), timeout, network error                                | The SDK retries twice with exponential backoff. If it still fails, the batch is marked `processing_failed` and is not split, so an outage doesn't turn into 10x more calls.                                                                                   |
| Malformed JSON, missing or invalid entries, refusal, reply cut off at `max_tokens` | Only the emails without a valid answer are retried, one at a time, so one problematic email can't fail its neighbours.                                                                                                                                        |
| Bad API key, no access, unknown model, missing credentials                         | No more calls for the rest of the run; every remaining email gets `processing_failed`.                                                                                                                                                                        |
| The Lambda is about to time out                                                    | No new call starts with less than 5 s left (3 s kept back to return, 2 s minimum for a call). Calls still running at that point are aborted, including the SDK's own retries. Their emails get `processing_failed`, and every email already done is returned. |

Retries run sequentially inside their batch's slot, so calls in flight never exceed `MAX_CONCURRENCY`. There is deliberately no fallback to the mock: silently returning keyword-rule results would look like model output. A second model as a fallback (for example Sonnet when Haiku is overloaded) is one more `LlmAdapter` call away, but isn't needed for this task.

### Parsing the model's answer, and why not structured outputs

The prompt asks for `{"results":[{"k":0,...}]}`, where `k` is the email's position in the batch. The parser takes the outermost JSON object (tolerating a code fence or text around it), validates the envelope and then each entry with zod, ignores keys outside the batch, and re-checks the content (allowed topics, sentence and length limits, no placeholder summaries). An entry that fails any check is retried on its own.

I measured the alternative, API structured outputs (`output_config.format` with a JSON schema), with Claude Haiku 5.5 on the sample batch, 3 runs per variant:

| Variant                    | classify               | summarize              | input tokens           |
| -------------------------- | ---------------------- | ---------------------- | ---------------------- |
| Prompt + validation (used) | 9/9 valid in every run | 9/9 valid in every run | ~950-990               |
| Structured outputs         | 9/9 valid in every run | 1/9, 8/9 and 9/9 valid | ~1,230-1,340 (+30-36%) |

With the schema, Haiku sometimes stops a summarize batch early, and the schema costs extra input tokens on every call. Validation is needed either way (a schema can't enforce "2 sentences" or "no placeholders"), so the prompt-based format wins here. With a larger model, structured outputs are worth re-testing.

### Security

- The API key comes from the environment or a gitignored `.env`, is never logged, and is never echoed back in configuration errors.
- Email text is treated as untrusted input. The prompt tells the model the emails are data, not instructions, and `<` is escaped in the payload, so an email can't close the `<emails>` block. A test email that tried to rewrite its own classification and summary was classified as `other` and summarized as an ignored instruction.
- Whatever the model returns is constrained before it reaches the caller: topics must be on the allow-list and summaries are length-capped. The model has no tools, so an injected instruction can at most affect that email's own result.
- Logs contain ids, counts and error messages, never email subjects, bodies or summaries.
- On AWS the key is a `NoEcho` deployment parameter. In production it belongs in Secrets Manager (see below).

### Adding a mode

1. Add a value to `ModeName`.
2. Implement `Mode` in `src/modes/<name>.mode.ts`: a system prompt, an output token budget per email and a `parseReply` that validates the model's answer.
3. Register it in `src/modes/mode.factory.ts`. TypeScript reports a mode without a factory.

### Adding a model provider

1. Implement `LlmAdapter` (`src/llm/llm.adapter.ts`): one `complete({ task, system, prompt, maxTokens })` method returning text and token usage, throwing `ProviderError` on failure (`fatal: true` when no call can succeed, `transient: true` when the service itself failed).
2. Add a `ProviderName` value and a case in `src/llm/llm-adapter.factory.ts`.

A local model (for example via `node-llama-cpp`) or another API fits the same interface. Modes and the processor don't change.

## Cost controls

- Invalid and empty emails never reach the model.
- Batching: the instructions are sent once per batch of up to 10 emails instead of once per email.
- Identical emails in an invocation are sent once, and repeats across warm invocations are served from the cache.
- Input is kept small: whitespace collapsed, subjects capped at 200 characters, bodies truncated to `MAX_BODY_CHARS`, short JSON keys in the prompt.
- Output is capped: `max_tokens` is sized per batch (20 tokens per email for classify, 60 for summarize) plus a fixed allowance for the model's reasoning.
- The cheapest current model, Claude Haiku 5.5, at `low` effort. A harder dataset can switch to `claude-sonnet-5-5` with `ANTHROPIC_MODEL` alone.
- Retries happen only for the emails that failed, never fan out during an API outage, and stop entirely on configuration errors.
- Every run logs `modelCalls`, `inputTokens`, `outputTokens`, `cacheHits` and `deduplicated`, so cost is visible per invocation.

## Configuration

See `.env.example`. On Lambda these are environment variables; locally the CLI also reads `.env`.

| Variable            | Default            | Description                                                          |
| ------------------- | ------------------ | -------------------------------------------------------------------- |
| `PROVIDER`          | `mock`             | `mock` or `anthropic`                                                |
| `ANTHROPIC_API_KEY` |                    | Required when `PROVIDER=anthropic`                                   |
| `ANTHROPIC_MODEL`   | `claude-haiku-5-5` | Any Claude model id                                                  |
| `LOG_LEVEL`         | `INFO`             | `DEBUG`, `INFO`, `WARN`, `ERROR`; `--log-level` overrides it locally |
| `TOPICS`            | 8 topics           | Comma-separated allowed topics; `other` is always added              |
| `BATCH_SIZE`        | `10`               | Emails per model call                                                |
| `MAX_CONCURRENCY`   | `3`                | Model calls in flight                                                |
| `MAX_BODY_CHARS`    | `2000`             | Longer bodies are truncated                                          |
| `CACHE_MAX_ENTRIES` | `1000`             | Result cache size; `0` turns it off                                  |

## Deploying (optional)

```bash
sam build && sam deploy --guided --parameter-overrides Provider=anthropic AnthropicApiKey=sk-ant-...
sam remote invoke EmailClassifierFunction --event-file sample/lambda-event.json
```

Or run `npm run bundle` and upload `build/lambda/index.mjs` (handler `index.handler`, runtime `nodejs22.x`).

## What I'd add for production

- Read the API key from AWS Secrets Manager at cold start instead of a (`NoEcho`) environment variable.
- Use the Message Batches API (50% cheaper) for large jobs that don't need an answer within the invocation.
- Use prompt caching once the system prompt grows (for example with few-shot examples). The current prompts are below the minimum cacheable length, so it would have no effect today.
- Move the result cache to DynamoDB or Redis so it is shared between containers.
