# Notification Handler Lambda

AWS Lambda (Node.js 22, TypeScript) that takes a batch of semi-structured user events, validates and normalizes them, and stores each one as a row in the `Notification` table through a simulated `insertToMySQL(event)`. Invalid events are logged and reported; the rest of the batch keeps going.

## Running locally

Requires Node.js 22+.

```bash
npm install                     # installs dependencies and compiles TypeScript to dist/
node app/run.js --input sample/events.json --log-level INFO
```

The processing report is printed to stdout and logs go to stderr, so `node app/run.js -i sample/events.json > report.json` gives you just the report.

In a terminal, logs are short coloured lines (`00:21:32.767 INFO  Processing finished total=7 inserted=4 ...`). When stderr is piped or redirected they are JSON lines, the format Lambda always uses. `--log-format json|pretty` overrides the choice.

Other useful commands:

```bash
node app/run.js -i sample/events.json --show-db      # also print the simulated Notification table
node app/run.js -i sample/edge-cases.json -l WARN    # malformed events, odd dates, DB failures
npm test                                             # build + unit tests (node:test)
npm run lint
```

## What happens to the assignment sample

| #   | Event                                                                                  | Result                                                                                                                                                                                        |
| --- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0   | Alice, `roles: "admin, editor ,  manager"`                                             | inserted, roles `["admin","editor","manager"]`, joined `2021-04-01T00:00:00.000Z`                                                                                                             |
| 1   | Bob, `bob.smith(at)example.com`, `roles: ["viewer", " "]`, `April 5th, 2021 13:45 PST` | invalid: `email: "bob.smith(at)example.com" is not a valid email address`. His roles (`["viewer"]`) and date (`2021-04-05T21:45:00.000Z`) are valid, so the email is the only reason reported |
| 2   | Carol, `2021/06/01 10:23+02:00`                                                        | inserted, requested `2021-06-01T08:23:00.000Z`                                                                                                                                                |
| 3   | David, `2021-07-15T00:00:00`                                                           | inserted, deleted `2021-07-15T00:00:00.000Z` (no zone, so UTC)                                                                                                                                |
| 4   | `unknown_type`                                                                         | invalid: unknown event type                                                                                                                                                                   |
| 5   | Alice, `event_id: "dedupe-1"`, `roles: null`                                           | inserted, roles `[]`                                                                                                                                                                          |
| 6   | Alice, `event_id: "dedupe-1"` again                                                    | skipped as a duplicate of #5                                                                                                                                                                  |

Report (shortened):

```json
{
  "total": 7,
  "inserted": 4,
  "duplicates": 1,
  "invalid": 2,
  "failed": 0,
  "durationMs": 61,
  "results": [
    {
      "index": 0,
      "type": "user_registered",
      "eventId": null,
      "status": "inserted",
      "notificationId": 1
    },
    {
      "index": 1,
      "type": "user_registered",
      "eventId": null,
      "status": "invalid",
      "error": "validation_failed",
      "reasons": ["email: \"bob.smith(at)example.com\" is not a valid email address"]
    }
  ]
}
```

Each result has a `status`: `inserted`, `duplicate`, `invalid` (with `error` = `invalid_event`, `unknown_type` or `validation_failed`) or `failed` (`storage_failed` after retries, or `deadline_exceeded` when the Lambda was about to time out before reaching the event). `reasons` lists every problem with the event at once, not just the first one.

If the Lambda event itself is not an array, the handler throws `InputError` (the CLI exits with code 2). A single bad event never throws.

## How it works

```
src/
  handler.ts                     Lambda entry point
  cli.ts                         local runner used by app/run.js
  notification.processor.ts      validate -> de-duplicate -> insert, one event at a time
  events/                        one file per event type + the registry
  schemas/fields.schema.ts       shared email / date / roles / name / event_id schemas
  helpers/                       DateHelper (date parsing to ISO 8601 UTC), RetryHelper, ErrorHelper
  db/                            NotificationRepository + the simulated MySQL implementation
```

For every event the processor:

1. Checks that it is an object with a string `type`, and finds the event definition for that type.
2. Runs the type's zod schema, which validates and normalizes in one pass and strips unknown fields.
3. Skips it if an event with the same `event_id` was already stored in this invocation.
4. Maps it to a `Notification` row and calls `insertToMySQL`, retrying transient database errors with exponential backoff.

Events are processed sequentially on purpose: notifications keep the order of the stream, and "first stored copy wins" for duplicates stays deterministic.

### Adding an event type

1. Create `src/events/<name>.event.ts` with `type`, `notificationTypeId` and a zod schema built from the shared field schemas.
2. Add it to `EVENT_DEFINITIONS` in `src/events/event-registry.ts`.
3. Add a value to `EventType`, a value to `NotificationType` and a matching row to `schema.sql` (a test fails if they drift apart).

Nothing else changes.

### Mapping to the Notification table

- `NotificationTypeID`: from the event definition (1 = user_registered, 2 = password_reset, 3 = user_deleted).
- `NotificationData`: the normalized event as JSON, including the event's own date (`joined`, `requested`, `deleted`) and `event_id` when present.
- `Created`: left to MySQL (`DEFAULT CURRENT_TIMESTAMP`), so it is the time the notification was created, not the time of the original event.
- `Status`, `Seen`, `IsBookmarked`: `0` (inbox, unseen, not bookmarked).
- `CreatedByType` / `CreatedByID`: `0` by default, meaning "system"; configurable through env.

The insert is a parameterized statement (`SimulatedMySqlRepository.buildInsertStatement`), so switching to real MySQL means implementing `NotificationRepository` with `mysql2/promise` and passing it to the processor.

## Normalization rules

- **Email**: trimmed and lowercased, validated with zod's email rule, max 254 characters. Obfuscated addresses like `bob.smith(at)example.com` are rejected rather than repaired.
- **Dates**: converted to ISO 8601 UTC. Parsed against an explicit list of formats (`2021-04-01`, `2021-07-15T00:00:00`, ISO with `Z` or offset, `2021/06/01 10:23+02:00`, `April 5th, 2021 13:45 PST`) instead of `new Date(string)`, which guesses and silently rolls invalid dates over. No zone means UTC. Zone abbreviations are fixed offsets (`PST` is always -08:00); ambiguous ones like `IST` are rejected, as are impossible dates (`2021-02-30`), `01/02/2021`-style input and words like `yesterday`.
- **Roles**: a comma-separated string or an array becomes an array of trimmed, lowercased, unique strings; blanks are dropped and `null`/missing becomes `[]`. Non-string entries are rejected.
- **Other**: `type` is case- and whitespace-insensitive, `name` is required (1-255 characters), `event_id` is optional and `101` equals `"101"`.
- **Size limits**: `event_id` up to 128 characters (the column size suggested in `schema.sql`), at most 50 roles of up to 64 characters, dates up to 64 characters. Without them one malformed event could store megabytes of JSON.

## Duplicates

The first successfully stored event with a given `event_id` wins and later copies are reported as `duplicate`. An id is only marked after a successful insert, so an invalid first copy doesn't block a valid one. Events without `event_id` are never de-duplicated.

This works within one invocation. To make it hold across invocations, persist the id with a unique key (see the note at the end of `schema.sql`).

## Errors, retries and logging

- On Lambda, logs are JSON lines (AWS Powertools Logger) with a `requestId`. Skipped events are logged at `WARN` with their index, type, `event_id`, error code and the names of the invalid fields; storage failures at `ERROR`. Submitted values (emails, names) never reach the logs; the full reasons are only in the report returned to the caller.
- Transient `StorageError`s (lock timeout, lost connection) are retried twice, after 25-50 ms and then 50-100 ms (random jitter), so concurrent Lambdas don't retry against the database in lockstep. Other errors fail the event immediately.
- A retry after a lost connection can, in rare cases, repeat an insert that had already committed. With real MySQL, the unique `event_id` key from the note in `schema.sql` (`INSERT ... ON DUPLICATE KEY UPDATE`) makes the retry harmless.
- The handler stops 2 s before the Lambda timeout. Events it didn't reach are reported as `failed` / `deadline_exceeded` with every earlier result intact, instead of the invocation being killed with no report after some rows were already written.
- The INSERT is a parameterized statement, so event data can't inject SQL.
- To demo failures, emails ending in `@db-flaky.test` fail once and `@db-failure.test` always fail. `sample/edge-cases.json` uses both.

## Configuration

| Variable          | Default | Description                                                          |
| ----------------- | ------- | -------------------------------------------------------------------- |
| `LOG_LEVEL`       | `INFO`  | `DEBUG`, `INFO`, `WARN`, `ERROR`; `--log-level` overrides it locally |
| `CREATED_BY_TYPE` | `0`     | `Notification.CreatedByType`                                         |
| `CREATED_BY_ID`   | `0`     | `Notification.CreatedByID`                                           |
| `DB_LATENCY_MS`   | `5`     | Simulated insert latency                                             |

## Deploying (optional)

```bash
sam build && sam deploy --guided
sam remote invoke NotificationHandlerFunction --event-file sample/events.json
```

Or run `npm run bundle` and upload `build/lambda/index.mjs` (handler `index.handler`, runtime `nodejs22.x`).
