# Router-Maestro-local `web_search`

Router-Maestro can execute web searches **server-side** on behalf of models whose
upstream cannot run Anthropic's hosted `web_search` server tool.

## Why this exists

GitHub Copilot's model endpoints reject Anthropic's hosted server tool outright:

```json
{"type":"error","error":{"type":"invalid_request_error",
 "message":"The use of the web search tool is not supported."}}
```

Copilot's own apps (Copilot CLI, IDE chat) *do* have web search, but it is an
**MCP tool executed by the client**, not a capability of the inference API. The
CLI surfaces it as `Web Search (MCP: github-mcp-server)`.

Router-Maestro therefore plays the client role itself:

```text
client ──tools=[web_search_20250305]──▶ Router-Maestro
                                        │  advertises "web_search" as a function tool
                                        ▼
                                     upstream model (e.g. Claude via Copilot)
                                        │  tool_use(web_search, {query})
                                        ▼
                                     Router-Maestro ──▶ search backend
                                        │  tool_result
                                        ▼
                                     upstream model ──▶ final answer ──▶ client
```

The client sees a single message (one `message_start` … `message_stop`) and never
receives a `tool_use` block for `web_search` — it declared the tool as hosted and
has no implementation for it.

By default (`emit_native_blocks: true`) the searches are replayed as
Anthropic-native blocks so clients can render sources:

```json
{"content": [
  {"type": "server_tool_use", "id": "…", "name": "web_search",
   "input": {"query": "latest stable Python version"}},
  {"type": "web_search_tool_result", "tool_use_id": "…",
   "content": [{"type": "web_search_result", "title": "…", "url": "…"}]},
  {"type": "text", "text": "Python 3.14.7 …"}
],
 "usage": {"server_tool_use": {"web_search_requests": 1}}}
```

Set `emit_native_blocks: false` for a text-only response (sources appended to the
answer text instead). Usage counters stay accurate either way.

**Difference from native Anthropic:** `web_search_tool_result` here omits
`encrypted_content`, and text blocks carry no `citations` array with
`encrypted_index` — those are signed by Anthropic and cannot be forged. The
blocks are structurally faithful, not cryptographically faithful. Clients use
them to render sources; they are not replayable against api.anthropic.com.
Clients that echo them back are safe: the inbound schema accepts them (the block
union permits raw dicts) and the OpenAI translation drops them, since the
upstream history is rebuilt by the search loop itself.

## Backends

### `github_mcp` (default)

Calls the `web_search` tool on GitHub's remote MCP server
(`https://api.githubcopilot.com/mcp/`) — the same Bing-backed tool Copilot CLI
uses. It returns an AI-synthesised answer with citation URLs.

- **Credentials:** reuses the GitHub Copilot OAuth credential Router-Maestro
  already stores (`auth.json`, written by `router-maestro auth login
  github-copilot`). **No extra API key, no extra quota, no extra cost.**
- **Note:** `web_search` is not in the MCP server's default toolset. Without the
  `X-MCP-Toolsets: all` header the server advertises 47 GitHub-only tools and
  `web_search` is absent. Router-Maestro sends that header automatically.

### `google`

Google Programmable Search (Custom Search JSON API). Returns ranked
title/URL/snippet results.

- **Credentials:** an API key and a Programmable Search engine ID, supplied via
  environment variables. Only the *names* of those variables are stored in
  config — never the values.
- Free tier is 100 queries/day.

## Configuration

The feature is **disabled by default** and lives in `priorities.json` under
`web_search`:

```json
{
  "web_search": {
    "enabled": true,
    "backend": "github_mcp",
    "max_uses": 5,
    "timeout_seconds": 60.0
  }
}
```

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Master switch |
| `backend` | `"github_mcp"` | `github_mcp` or `google` |
| `max_uses` | `5` | Max searches executed per client request |
| `max_results` | `5` | Results per search (`google` only) |
| `timeout_seconds` | `60.0` | Timeout for one upstream search call |
| `emit_native_blocks` | `true` | Emit `server_tool_use` / `web_search_tool_result` blocks |
| `api_key_env` | `GOOGLE_SEARCH_API_KEY` | Env var holding the `google` API key |
| `cse_id_env` | `GOOGLE_SEARCH_CSE_ID` | Env var holding the `google` engine ID |

Enable it through the admin API (no restart needed):

```bash
curl -sS -X PATCH "$URL/api/admin/priorities" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"web_search": {"enabled": true, "backend": "github_mcp"}}'
```

For the `google` backend, also set the two environment variables on the server
process, then switch `backend` to `"google"`.

## Behaviour

- **Activation.** The loop engages only when the client declares Anthropic's
  hosted tool (`{"type": "web_search_20250305", "name": "web_search"}`) *and*
  the feature is enabled with usable credentials. Otherwise the request is
  passed through exactly as before.
- **Client-supplied tools win.** If the client also ships its own executable
  `web_search` function tool (one carrying an `input_schema`), Router-Maestro
  does not intercept — the client clearly intends to run searches itself.
- **Routing.** The beta native-passthrough route (`/api/anthropic/beta/v1/messages`)
  cannot run this loop, so requests that need it fall back to the standard
  translated route automatically.
- **Budget.** After `max_uses` searches the tool is withdrawn from the upstream
  request so the model answers with what it has instead of looping.
- **Failure handling.** A failed or malformed search becomes `Search error: …`
  text handed back to the model; it never fails the client request.

## Security

- Credentials are read from the existing credential store or from environment
  variables; they are never written to `priorities.json`, logged, or returned
  to clients.
- Search backends surface only HTTP status codes on failure — response bodies
  (which can echo an API key supplied in a query string) are not interpolated
  into error messages.
- Logs record the query *length*, never the query text or credential material.
- Search results are untrusted third-party content. They are inserted as a
  `tool_result`, the same trust level as any other tool output, and are subject
  to the usual prompt-injection considerations.

## Limitations

- `github_mcp` depends on an undocumented, non-default MCP toolset; GitHub could
  change or withdraw it.
- Each `github_mcp` search opens a short-lived MCP session (initialize →
  initialized → tools/call), i.e. three HTTP round trips. This keeps the server
  stateless and scale-to-zero friendly at the cost of a little latency.
- The loop is implemented for the Anthropic Messages surface only. OpenAI and
  Gemini surfaces are unaffected.
- Native blocks are structurally faithful but omit Anthropic's signed
  `encrypted_content` / `encrypted_index`, so they cannot be replayed against
  api.anthropic.com. Set `emit_native_blocks: false` if a client mis-parses them.
