---
name: logfire
description: Query LogFire observability logs via API. Use when the user asks to check, analyze, or investigate LogFire logs, traces, errors, AI requests, or performance issues.
---

# LogFire Log Analysis

Query application logs and traces from Pydantic LogFire to investigate issues, analyze AI requests, and debug problems.

## Prerequisites

The project's `.env` file must contain:
```
LOGFIRE_READ_TOKEN=pylf_v1_...
```
The API region (EU/US) is auto-detected from the token prefix.

## Querying

Run from the **project root directory** (where `.env` lives):

```bash
/path/to/logfire/query.sh "SELECT ... FROM records ..." [limit]
```

- First argument: SQL query (required)
- Second argument: row limit (optional, default 20, max 10000)
- Output: JSON with `columns` and `rows` arrays
- Pipe through `jq` for formatting

**Keep queries small.** Always use `LIMIT` in SQL (5-20 rows). When selecting `attributes`,
use `LIMIT 1-3` — AI spans contain full prompts/responses and can be 10KB+ each.

## Data Model

LogFire stores OpenTelemetry spans/logs in a `records` table. Key columns:

| Column | Type | Description |
|---|---|---|
| `start_timestamp` | Timestamp | When the span/event started |
| `end_timestamp` | Timestamp | When it ended |
| `duration` | Float64 | Duration in seconds |
| `message` | Utf8 | Human-readable message |
| `span_name` | Utf8 | Span operation name |
| `level` | UInt16 | Severity: 1=trace, 5=debug, 9=info, 13=warn, 17=error, 21=fatal |
| `trace_id` | Utf8 | Groups related spans into a trace |
| `span_id` | Utf8 | Unique span identifier |
| `parent_span_id` | Utf8 | Parent span (for nesting) |
| `is_exception` | Boolean | Whether this span recorded an exception |
| `exception_type` | Utf8 | Exception class name |
| `exception_message` | Utf8 | Exception text |
| `exception_stacktrace` | Utf8 | Full traceback |
| `otel_status_code` | Utf8 | `OK`, `ERROR`, or empty |
| `attributes` | Utf8 (JSON) | Structured data — AI prompts, responses, parameters |
| `otel_scope_name` | Utf8 | Instrumentation scope (e.g., `pydantic-ai`) |
| `tags` | List(Utf8) | Custom tags |
| `service_name` | Utf8 | Application name |

### The `attributes` Column

This is a JSON string. Use `attributes::string` or JSON functions to query it.
For AI/LLM spans, attributes typically contain:

- `gen_ai.input.messages` — prompt messages sent to the model
- `gen_ai.output.messages` — model responses (including tool calls)
- `gen_ai.system_instructions` — system prompt
- `gen_ai.request.model` — model name (e.g., `gemini-2.5-flash`)
- `gen_ai.request.temperature` — temperature setting
- `gen_ai.response.model` — actual model used
- `gen_ai.response.finish_reasons` — completion reasons
- `gen_ai.usage.input_tokens` — prompt token count
- `gen_ai.usage.output_tokens` — completion token count

## Query Patterns

### Recent events
```sql
SELECT start_timestamp, message, span_name, level
FROM records ORDER BY start_timestamp DESC LIMIT 20
```

### Errors and exceptions
```sql
SELECT start_timestamp, message, exception_type, exception_message, exception_stacktrace
FROM records WHERE is_exception = true
ORDER BY start_timestamp DESC LIMIT 10
```

### Spans with errors
```sql
SELECT start_timestamp, message, otel_status_code, otel_status_message
FROM records WHERE otel_status_code = 'ERROR'
ORDER BY start_timestamp DESC LIMIT 10
```

### AI requests with full prompts and responses
```sql
SELECT start_timestamp, message, duration, attributes
FROM records WHERE span_name LIKE 'chat %'
ORDER BY start_timestamp DESC LIMIT 5
```

### Slow operations
```sql
SELECT start_timestamp, message, span_name, duration
FROM records WHERE duration > 5.0
ORDER BY duration DESC LIMIT 10
```

### Full trace (all spans in a request chain)
```sql
SELECT start_timestamp, message, span_name, span_id, parent_span_id, duration
FROM records WHERE trace_id = '<trace_id>'
ORDER BY start_timestamp
```

### Events in a time range
```sql
SELECT start_timestamp, message, level
FROM records
WHERE start_timestamp > '2025-01-15T10:00:00Z'
  AND start_timestamp < '2025-01-15T11:00:00Z'
ORDER BY start_timestamp DESC
```

### Distinct span names (discover what's being traced)
```sql
SELECT DISTINCT span_name FROM records ORDER BY span_name
```

## Gotchas

### API is GET, not POST
The query endpoint is `GET /v1/query` with query parameters (`sql`, `limit`, `json_rows`), not a POST with JSON body.

### Region-specific base URL
The API base URL depends on the token region. The token format is `pylf_v<version>_<region>_<secret>`:
- `eu` → `https://logfire-eu.pydantic.dev`
- `us` → `https://logfire-us.pydantic.dev`

The `query.sh` script handles this automatically.

### Project is inferred from token
The read token is scoped to a specific project. There's no need to pass org/project in the URL — just `/v1/query`.

### `attributes` is JSON but returned as object
With `json_rows=true`, `attributes` comes back as a parsed JSON object, not a string. You can pipe directly through jq without an extra parse step:
```bash
./query.sh "..." | jq '.rows[0].attributes."gen_ai.output.messages"'
```

### PII scrubbing
LogFire automatically scrubs fields matching sensitive patterns (e.g., `session`, `password`, `token`). Scrubbed fields show `"[Scrubbed due to '<pattern>']"`. Check `logfire.scrubbed` in attributes for details.

### `SELECT DISTINCT` with `ORDER BY`
The query engine requires that `ORDER BY` columns appear in the `SELECT` list when using `DISTINCT`. Instead of:
```sql
-- This FAILS:
SELECT DISTINCT trace_id FROM records ORDER BY start_timestamp DESC
```
Use aggregation:
```sql
SELECT trace_id, MIN(start_timestamp) as ts FROM records GROUP BY trace_id ORDER BY ts DESC
```

### Trace IDs are full-length
When filtering by `trace_id`, use the complete 32-char hex value, not a prefix. Query the full IDs first, then use them in WHERE clauses.

## Workflow

When investigating an issue:

1. **Start broad but small**: query recent events or errors with `LIMIT 10-20` to understand what's happening
2. **Narrow down**: filter by time range, span name, or error type
3. **Inspect details**: fetch full `attributes` for specific spans to see AI prompts/responses
4. **Follow traces**: use `trace_id` to see the full chain of operations
5. **Cross-reference with code**: use span names and messages to find the relevant code, then propose fixes

When parsing `attributes`, pipe through `jq` to extract specific fields:
```bash
./query.sh "SELECT attributes FROM records WHERE span_name LIKE 'chat %' LIMIT 1" | jq -r '.rows[0].attributes' | jq '.["gen_ai.input.messages"]'
```
