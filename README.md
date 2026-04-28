# comet.mcpgw.app

Streamable-HTTP **Model Context Protocol (MCP)** server that bridges any MCP
client (Claude Code, Claude Desktop, custom clients) to the
[Perplexity Comet](https://www.perplexity.ai/comet) browser via the Chrome
DevTools Protocol (CDP).

- **Site:** [comet.mcpgw.app](https://comet.mcpgw.app)
- **Source:** [github.com/nicolaeser/comet.mcpgw.app](https://github.com/nicolaeser/comet.mcpgw.app)
- **Container image:** `ghcr.io/nicolaeser/comet.mcpgw.app:latest`

```
MCP Client  →  comet.mcpgw.app (HTTP)  →  CDP  →  Comet Browser  →  Perplexity AI
```

Purpose-built so the coding model stays focused on code while Comet handles
login walls, dynamic pages, and deep agentic research. **31 MCP tools, 3
resources, 3 prompts**, fully isolated per-task parallelism.

---

## Why?

- **Search APIs** (Tavily, Perplexity API, WebFetch) return static text only.
- **Browser-automation MCPs** (Playwright, Puppeteer) make the coding model
  also drive the browser, which fragments its focus.
- **Comet bridge** delegates browsing to Perplexity's purpose-built agentic
  browser. Claude stays focused on code; Comet handles login walls, dynamic
  pages, and deep research.

Each parallel workflow gets its own Comet tab + CDP socket + AI state, so
concurrent tasks cannot stomp on each other.

---

## Quick start

Run Comet on your workstation with `--remote-debugging-port=9222`, then start
the bridge:

```bash
docker compose up -d
```

The MCP endpoint is `http://localhost:3000/mcp`. Add it to your client:

```json
{
  "mcpServers": {
    "comet": {
      "url": "http://localhost:3000/mcp",
      "headers": { "Authorization": "Bearer change-me-in-production" }
    }
  }
}
```

For local development without auth:

```bash
docker compose -f docker-compose.dev.yml up
```

Or run from source:

```bash
npm install
npm run dev
```

---

## Tools (31)

**Lifecycle**
| Tool | What it does |
|------|--------------|
| `comet_status` | Bridge health + active task list. Call first when troubleshooting. |
| `comet_connect` | Create a new isolated task; returns `task_id`. |
| `comet_tasks` | List active tasks with id, label, tab, URL, age, idle, keepAlive. |
| `comet_task_close` | Tear down a task (or `all=true`). Closes the owned tab plus any auxiliary tabs the agent opened during the task. |
| `comet_rename_task` | Change a task's label. |
| `comet_inspect` | URL/title/age/idle for one task. |

**Driving Perplexity**
| Tool | What it does |
|------|--------------|
| `comet_ask` | Send a prompt and wait for the answer. Completed one-shot tasks auto-close by default; pass `closeAfter=false` for follow-up/inspection. Parallel-safe across distinct `task_id`s. |
| `comet_poll` | Non-blocking status check; returns the response when COMPLETED. |
| `comet_get_response` | Peek at the latest visible answer without waiting. |
| `comet_stop` | Click Perplexity's Stop button. |
| `comet_mode` | Switch search / research / labs / learn. |
| `comet_accept_banner` | Manual accept of the "Allow browser control" banner. |

**Tab navigation & inspection**
| Tool | What it does |
|------|--------------|
| `comet_navigate` | Drive the tab to a URL. |
| `comet_back` / `comet_forward` / `comet_reload` | History navigation. |
| `comet_screenshot` | Viewport PNG. |
| `comet_full_screenshot` | Full-page PNG/JPEG. |
| `comet_pdf` | `Page.printToPDF` as base64 resource. |
| `comet_html` | outerHTML of full doc or a selector match. |
| `comet_dom_query` | querySelectorAll → structured `{tag,id,class,attrs,text,visible}` array. |

**Interaction (no agent)**
| Tool | What it does |
|------|--------------|
| `comet_click` | Click a CSS-selector match. |
| `comet_type` | `Input.insertText` (foreground-independent). |
| `comet_eval` | Run arbitrary async JS in the tab. **Off by default** (`COMET_ENABLE_EVAL=true` to enable). |

**Debugging the page**
| Tool | What it does |
|------|--------------|
| `comet_console` | Buffered `console.*` entries (filter by level/substring). |
| `comet_network` | Buffered HTTP requests (filter by URL/status/failed). |

**Browser state**
| Tool | What it does |
|------|--------------|
| `comet_cookies` / `comet_set_cookie` | Read/write cookies. |
| `comet_set_viewport` | Override device metrics (mobile emulation). |
| `comet_block_urls` | `Network.setBlockedURLs` patterns. |
| `comet_clear_cache` | Browser-wide resets. |

---

## Task lifecycle defaults

`comet_ask` auto-closes completed one-shot task tabs by default. A task stays
open when Comet is still working, waiting for confirmation, or when the caller
passes `closeAfter=false`. `closeTimeout` can be used to keep a completed tab
available briefly for inspection before it closes.

For asynchronous clients such as n8n, call `comet_ask` with `wait=false`, then
poll with `comet_poll`. The task inherits the same auto-close preference and
will close when `comet_poll` observes completion unless `closeAfter=false` was
set on the ask or poll call.

### Auxiliary tab cleanup

When Comet's agent browses third-party sites during a task (e.g. opens
`kayak.com`, `google.com/travel/flights`, etc.), those tabs are not children of
the Perplexity sidecar in the CDP `openerId` sense — they're spawned by the
browser-agent overlay. To make `comet_task_close` clean them up reliably, the
registry takes a snapshot of all existing page targets when a task is created
(`preexistingTargetIds`). On close, every page target that:

- did not exist when the task was created, AND
- is not claimed by another active task (registered or pending), AND
- is not `chrome://` or `devtools://`,

is closed alongside the owned tab. Pre-existing tabs and tabs owned by other
tasks are never touched.

### Parallel safety

The registry is race-safe across concurrent `create()` and `close()` calls:

- **Pending claims:** A tab is added to `pendingTabIds` the moment `cdpNewTab`
  returns, before the task is fully registered. Other tasks running `close()`
  in the same window see this set and skip the tab. `findPerplexityTarget` also
  consults it, so a concurrent `attach="sidecar"` cannot adopt another task's
  pending sidecar.
- **Per-task snapshots:** Each task's `preexistingTargetIds` is taken at its
  own `create()` start, so tabs created by Task B during Task A's lifetime are
  never seen as auxiliaries of A.
- **Live registry lookup:** `otherTaskTabIds` is computed from the live
  registry at `close()` time, so closes that race in `closeAll()` see each
  other's owned/child tabs and don't touch them.
- **Orphan cleanup on failure:** If `create()` opens a tab via `cdpNewTab` but
  throws before the task is registered, the orphan tab is closed in `finally`.
- **Zombie detection:** The idle sweep also lists the browser's live page
  targets and removes registered tasks whose owned tab no longer exists.

---

## Resources (3) and prompts (3)

The server publishes three Markdown resources for in-band documentation that
any MCP client can read:

- `comet://bridge/overview` — mental model + tool map + parallelism guarantees.
- `comet://bridge/hosting-guide` — running Comet so the bridge can reach it,
  every env var explained, plus a diagnosing-common-failures table.
- `comet://bridge/recipes` — copy-pasteable JSON-RPC patterns for the 10 most
  common workflows (one-shot, multi-step, parallel, debug, eval, etc.).

And three prompt templates that emit turnkey workflows:

- `comet_research_topic` — research-mode task → poll → close.
- `comet_parallel_questions` — fan out N tasks, collect answers in parallel.
- `comet_scrape_page` — open a tab, run `comet_dom_query`, screenshot, close.

---

## Hosting & the Comet question

This is the part that is **unusual** for an HTTP MCP server. Comet is a
desktop browser, not a Node process — so the container cannot launch it the
way a stdio server can.

**The bridge does not run Comet. It only speaks CDP to a Comet that already
exists somewhere reachable.** What you have to provide:

1. A running Comet instance with `--remote-debugging-port=9222 --remote-allow-origins=*`.
2. Network reachability from the container to that port.
3. A logged-in Perplexity session inside that Comet (login is interactive and
   persists in the browser profile — the bridge never sees credentials).

### Local workstation (`docker compose up`)

- Start Comet on your machine with the flags above.
- `COMET_CDP_URL=http://host.docker.internal:9222` resolves to your host on
  Docker Desktop. On Linux the compose file already adds
  `host.docker.internal:host-gateway` so the same URL works.
- Log into Perplexity once in Comet — it persists.

### Remote / cloud deployment (comet.mcpgw.app)

| Option | What you do |
|--------|-------------|
| **Tunnel to a workstation** | Comet runs on a Mac/PC you control. Tunnel port 9222 to the server (Tailscale, Cloudflare Tunnel, SSH `-R`). Set `COMET_CDP_URL` to the tunnel target. Profile + login live on your workstation. |
| **Headed VM** | Spin up a desktop Linux VM (with `Xvfb`/Xvnc), install Comet, mount a persistent `--user-data-dir`, log in once via VNC, then leave it running. |
| **Per-user instance** | Each user runs their own Comet locally and points the hosted bridge at it via tunnel. Best for multi-tenant; worst for ops. |

There is no fully headless `comet --headless` story that preserves the
Perplexity login flow. The first login always needs a real display.

### Production checklist

- **Auth on the CDP port** — there is none. Bind it to localhost and tunnel;
  never expose 9222 publicly.
- **Auth on the MCP port** — keep `AUTH_MODE=bearer` and rotate `API_KEY`.
- **Login persistence** — mount the Comet profile dir somewhere durable
  (`--user-data-dir=/path/to/profile`).
- **Eval** — leave `COMET_ENABLE_EVAL=false` unless you trust every MCP client
  that can reach the endpoint (it's XSS-equivalent inside the tab).
- **Logging** — set `LOG_FORMAT=json` for log aggregators (Datadog/Loki/ELK)
  and `LOG_REDACT=true` (default) so cookies/tokens are scrubbed.

---

## Configuration

### Server

| Variable | Default | Notes |
|----------|---------|-------|
| `PORT` | `3000` | HTTP listen port. |
| `PUBLIC_BASE_URL` | — | Used for OAuth metadata + CORS. |
| `SERVER_NAME` | `comet-mcpgw` | Name advertised in MCP `initialize`. |

### Auth

| Variable | Default | Notes |
|----------|---------|-------|
| `AUTH_MODE` | `bearer` | `bearer` (uses `API_KEY`) or `none`. |
| `API_KEY` | — | Bearer token clients must present. |
| `DISABLE_AUTH` | `false` | Force `AUTH_MODE=none` for local dev. |
| `MCP_ALLOWED_ORIGINS` | — | Comma-separated origins permitted to call `/mcp`. |

### CDP

| Variable | Default | Notes |
|----------|---------|-------|
| `COMET_CDP_URL` | `http://host.docker.internal:9222` | Where Comet's debug port is reachable from the container. |

### Logging

| Variable | Default | Notes |
|----------|---------|-------|
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` \| `silent`. |
| `LOG_FORMAT` | `pretty` | `pretty` for terminals, `json` for log aggregators. |
| `LOG_REDACT` | `true` | Auto-scrub keys matching `token`/`cookie`/`authorization`/etc. |
| `LOGGING_MODE` (legacy) | `standard` | `none` drops non-`privacySafe` field bodies (kept for back-compat). |

### Sessions, rate-limit, Redis

| Variable | Default | Notes |
|----------|---------|-------|
| `SESSION_TTL_MS` | `1800000` | MCP session inactivity timeout. |
| `REDIS_URL` | — | Optional Redis for sessions/rate-limit/tasks. |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Default rate-limit window. |
| `RATE_LIMIT_CLIENT_ID_HEADER` | `x-client-id` | Header used for per-client rate limits. |

### Comet task lifecycle & buffers

| Variable | Default | Notes |
|----------|---------|-------|
| `COMET_TASK_IDLE_TTL_MS` | `1800000` | Auto-close idle tasks after this many ms. Per-task opt-out via `keepAlive=true`. |
| `COMET_TASK_IDLE_SWEEP_MS` | `60000` | Idle sweeper cadence. |
| `COMET_MAX_CONSOLE` | `500` | Per-task console buffer cap. |
| `COMET_MAX_NETWORK` | `500` | Per-task network buffer cap. |
| `COMET_MAX_EVENT_SOURCE` | `1000` | Per-task browser `EventSource` message buffer cap. Comet usually uses fetch-backed SSE, so this is mostly a fallback. |
| `COMET_MAX_STREAM_REQUESTS` | `100` | Per-task fetch-backed SSE request buffer cap. |
| `COMET_MAX_STREAM_TEXT` | `250000` | Max decoded SSE text kept per streamed request. |
| `COMET_MAX_WEBSOCKET` | `1000` | Per-task WebSocket frame buffer cap for Comet agent-channel status. |
| `COMET_ENABLE_EVAL` | `false` | Turn on `comet_eval` (XSS-equivalent inside the tab). |

### Redis layout (when `REDIS_URL` is set)

- DB 0: MCP sessions
- DB 1: Rate limiting
- DB 2: MCP tasks
- DB 3: Tool cache

---

## Project layout

- `src/comet/` — CDP client (`cdp-client.ts`), per-task helper (`comet-ai.ts`), task registry.
- `src/tools/comet/` — the 31 `comet_*` MCP tools.
- `src/resources/comet/` — overview, hosting guide, recipes.
- `src/prompts/comet/` — research / parallel-questions / scrape templates.
- `src/http/` — Express server, auth, routing.
- `src/mcp/` — MCP protocol, session/task stores, dynamic loaders.
- `src/runtime/` — logger (JSON/pretty + redaction), Redis client.

Drop more `.ts` files into `src/tools/...`, `src/resources/...`, or
`src/prompts/...` and they are auto-registered at startup.

### Workflow runners such as n8n

For runners with short MCP/tool-call timeouts, submit Comet work without
holding the call open:

```json
{ "prompt": "Use your browser to ...", "wait": false }
```

Then poll the returned `task_id` with `comet_poll` until it returns the final
answer, or use `comet_get_response` for partial text. Completed tasks close
automatically when `comet_poll` observes completion unless `closeAfter=false`
is set. The bridge watches Comet's `/rest/sse/perplexity_ask` stream and agent
signals via CDP, so status can keep moving even when DOM-based UI detection is
brittle.
