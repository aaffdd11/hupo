# DSH browser window — protocol / architecture half

**Scope:** how the DSH browser frontend talks to the DSH backend, and what state lives where.
**Source:** read-only audit of the installed package
`/home/deploy/.nvm/versions/node/v24.15.0/lib/node_modules/@deepseek-ai/dsh/`
(root version `0.1.5-rc.1`; sub-packages in `<root>/node_modules/@deepseek-ai/`).
**Evidence style:** `path · symbol`. "only in lib/…" means there is no README for that fact.
**Method:** READMEs first, then every `lib/types/**/*.d.ts` wire type, then compiled `lib/**/*.js` where the docs were silent. Facts marked *live-verified* came from read-only `curl`s against the already-running GUI at `127.0.0.1:3081`; no server was started or stopped and nothing outside `/tmp/dsh-ui/` was written.

---

## 0. Two naming corrections before anything else

| Common assumption | Reality | Evidence |
|---|---|---|
| `dsh-web` is the `dsh web` command | **No.** `dsh-web` is the web *search/fetch* service (`ctx.web.search()` / `ctx.web.fetch()`). | `dsh-web/README.md` §Summary; `searchProvider`/`fetchProvider` config |
| `dsh-web-app` is a server | It is the **web profile bundle** (one patch + one glue plugin). It registers **no HTTP route itself**. | `dsh-web-app/README.md` §Source map; `dsh-web-app/cordis.patch.yml` |
| `dsh-app-boot` boots the browser app | **No.** It is the **host-side** Loader boot library (profiles, patches, `boot()`), shared by all `dsh` surfaces. | `dsh-app-boot/README.md` §Summary ("Shared Loader boot support for dsh profiles") |
| Browser app boot | `dsh-web-frontend/dist` (Vite shell) + `dsh-client-modules` (`__ModuleLoader__` / `__DSH_BOOT__`) + `dsh-cordis-client-runner` | §4 below |

`dsh web` is a hardcoded CLI alias for `--profile web`:
`lib/bin.js` · `program.command("web").description("boot the web profile (alias of --profile web)…")`,
`resolved = resolveBoot(web, "web", options, args)`.
Extra flags on the alias: `--patch <path>` (repeatable), `--dump-config`, `--dump-default-config`.

---

## 1. Transports and endpoints

There are **two live carriers** plus a dev/static group and one SPA fallback: (A) HTTP unary RPC on the `/api` prefix, (B) one multiplexed WebSocket at `/api/remote.mux` carrying every logical stream. Everything is same-origin; there is no CORS layer.

### 1.1 Carrier A — HTTP unary RPC ("the `/api` fetch bridge")

- **Owner:** `dsh-client-connection` host half · `HostConnectionService` (`lib/index.js`), registers the sole prefix route `API_PATH = "/api"` (`lib/types/api-path.d.ts`).
- **Client:** `createWebConnectionRpc` (`dsh-client-connection/lib/types/client/rpc.d.ts`, impl `lib/client.js`).
- **Call:** `POST <location.origin>/api/<endpoint>` — the endpoint is **in the URL path**, e.g. `POST /api/session/prompt`, `POST /api/workspaceFiles/stat`. Base is `resolveBase()` = `location.origin` (fallback literal `http://dsh.internal`). `assertTarget` constrains the channel to `/^\/[A-Za-z0-9._~-]+$/` and each endpoint segment to `/^[A-Za-z0-9_$.-]+$/`. Headers: `content-type: application/json` only. Cookie auth (see §5).
- **Request envelope** (`lib/types/rpc.d.ts` · `ClientRequest`):
  `{ type: "client-request", rpcId: RpcId, method: string, payload: unknown }`
  `rpcId = RpcId(randomUuid())`, minted per call.
- **Response envelope** (`ServerResponse`):
  `{ type: "server-response", rpcId, result: { ok: true, value } | { ok: false, error: { code, message, details } } }`
  The client validates the envelope and rejects a mismatch: `Error("rpcId mismatch for <endpoint>: sent X, got Y")` (`lib/client.js` · `parseConnectionResponse`).
- **Typert payload nesting:** `payload` is **exactly one plain-object field `args`** (`remoteRequest()`, `dsh-api-gateway/lib/index.js`). A real call body therefore looks like
  `{"type":"client-request","rpcId":"…","method":"workspace/create","payload":{"args":{"request":{"path":"/x"}}}}`
- **Host-side rejection codes:** unmapped endpoint or non-POST → `404`; wrong content-type → `415`; non-JSON body → `400`; `method !== endpoint` → `{code:'gateway/bad-request'}`; handler throw → `500`. Buffered body cap `maxRequestBodyBytes` default `314572800` (300 MiB) → `413`.
- **Carries:** every unary Remote command (full list in §2.3) plus the event-waterfall result endpoint `$events/result`.

### 1.2 Carrier B — WebSocket stream mux `/api/remote.mux`

- **Constant:** `REMOTE_STREAM_MUX_PATH = "/api/remote.mux"` (`dsh-api-gateway/lib/types/stream-protocol.js`; host side `dsh-api-gateway/lib/index.js`).
- **Owner:** `dsh-api-gateway` `RemoteStreamMuxServer`. **Opened by the client when the Gateway plugin activates and kept connected while idle** (`dsh-api-gateway/README.md` §Host service).
- **Client→Host messages** (`RemoteStreamClientMessage`):
  `{ type: "open", streamId, endpoint, payload }` | `{ type: "cancel", streamId }`
- **Host→Client messages** (`RemoteStreamServerMessage`):
  `{ type: "item", streamId, value? }` | `{ type: "error", streamId, error: { code, message, details } }` | `{ type: "end", streamId }`
- **Multiplexing:** one physical socket carries **all** independently cancellable logical streams (`streamId = randomUUID()` per stream).
- **URL derivation:** `const url = new URL(REMOTE_STREAM_MUX_PATH, location.origin); url.protocol = url.protocol === "https:" ? "wss:" : "ws:"` (`dsh-api-gateway/lib/client.js`) — so an `https` page yields `wss://<host>:<port>/api/remote.mux`. ⚠️ This one line is the classic browser-mixed-content failure point: a client that hardcodes `ws://` works on `http://127.0.0.1` and is silently blocked on any `https` origin. **Any acceptance test for a re-implementation must be run on the client's own computed URL, not on a probe that hardcodes the scheme.**
- **Close codes:** `4000 "reconnect requested"`, `4002 "invalid Remote stream frame"`, `1000 "disposed"`.
- **Heartbeat:** **server-side only** — the Host sends WebSocket Ping control frames every `websocketHeartbeatIntervalMs` (**2000 ms** default); the browser answers Pong at the WebSocket protocol layer, so idle intermediaries see traffic with **no Remote frame**. `MAX_MISSED_HEARTBEATS = 2` ⇒ `socket.terminate()` (`dsh-api-gateway/lib/types/stream-server.js`). The browser sends no ping of its own. So the cadence **is** the Pong deadline.
- **Auth:** the upgrade runs the same Host/Origin fence + cookie check; failure is a raw `HTTP/1.1 401 Unauthorized` / `403 Forbidden` (`dsh-api-gateway/lib/index.js` · `rejectRemoteStreamUpgrade`).
- **Carries:**
  - **the session event stream** → endpoint `session/follow` (`AsyncIterable<SessionFollowFrame>`)
  - **the session control stream** → endpoint `session/control` (`AsyncIterable<SessionControlFrame>`)
  - the workspace follow stream `workspace/follow`, the file-watch stream `workspaceFiles/changes`
  - the internal forwarded-event stream → endpoint `$events`, payload `{ args: {} }`

**Answer to "which one carries the session event stream": the `/api/remote.mux` WebSocket, logical stream `session/follow`.**
**Answer to "which one carries commands": the HTTP unary bridge — `POST /api/session/prompt` (and siblings).**

### 1.3 The internal `$events` forwarded-event stream (live push + the answer path)

`dsh-api-gateway/README.md` + `lib/types/stream-protocol.d.ts`:

- Reserved endpoint `REMOTE_EVENT_STREAM_ENDPOINT = "$events"`; unary result endpoint `REMOTE_EVENT_RESULT_ENDPOINT = "$events/result"`.
- Opening item **before any events**: `RemoteEventReadyFrame` = `{ type: "ready", clientId, host: { home } }`. Events are attached synchronously *before* `ready`, so a baseline read cannot race incremental delivery.
- Downlink frame union `RemoteEventDownlinkFrame`:
  - `{ type: "emit", event, args }` — one-way notification
  - `{ type: "waterfall", event, eventId, agentId, request }` — Host asks the browser a question and **awaits** the answer
  - `{ type: "cancel", eventId }` — a previously delivered waterfall is withdrawn
- Answer path: `RemoteEventResult = { clientId, eventId, outcome: {kind:'next'} | {kind:'result', value?} | {kind:'rejected', error:{name,message,code?,details?}} }`, posted via the **HTTP** carrier to `$events/result` as `{args: RemoteEventResult}`. This is how **approval decisions and user-question answers get back to the Host** (see §2.4).
- Host facts: the `ready` frame's `host.home` is the only Host fact on the wire; the client exposes it (plus a derived `isLoopback`) as the plain values `ctx.remote.$host: RemoteHostFacts = { home: string|undefined, isLoopback: boolean }`. It is **not** a store — no subscription, no generation counter.
- Allowlist `API_REMOTE_FORWARDED_EVENTS` (`dsh-api-remotes/lib/types/remote-events.js`) — **the complete legal key set of `ctx.remote.$on`**:

| event | mode |
|---|---|
| `agent-preset/selected` | emit |
| `approval/request` | **waterfall** |
| `api-session/activity` | emit |
| `api-session/added` | emit |
| `api-session/error` | emit |
| `api-session/removed` | emit |
| `api-session/status` | emit |
| `commands/change` | emit |
| `credentials/reference-updated` | emit |
| `goal/activation-changed` | emit |
| `cordis/request-run` | emit |
| `cordis/request-run-resolved` | emit |
| `cordis/dynamic-package` | emit |
| `cordis/dynamic-retract` | emit |
| `cordis/inspect-query` | emit |
| `cordis/inspect-query-resolved` | emit |
| `llm/adapters-updated` | emit |
| `settings/document-updated` | emit |
| `user-questions/request` | **waterfall** |

> Ordinary forwarded events are **not replayed** after reconnect; only the two waterfalls carry pending lifetime (`dsh-api-remotes/README.md` §Known Limitations).

### 1.4 Exact Fetch routes (non-JSON; registered on the same `/api` channel)

| Path | Methods | Payload / notes |
|---|---|---|
| `/api/file` | GET, HEAD | `?path=<absolute path>`. Complete file, **ignores `Range`**. Headers: `Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox; default-src 'none'`. `> imageLimits.maxImageBytes` (normally 20 MiB) → `413`. No directory confinement, no MIME restriction; type from `mime-types`, unknown → `application/octet-stream`. `dsh-api-session-controller` · `SessionMediaReferences` |
| `/api/session.export` | GET, HEAD | `?sessionId=<id>&includeDescendants=true\|false` → ZIP of the session log. Bad/missing `sessionId` → `400`. `dsh-session-log-export` · `SESSION_LOG_EXPORT_PATH` |
| `/api/session/uploadFileBinary` | POST (**streaming**) | `?sessionId=<id>&name=<name>`, `content-type: application/octet-stream`, body = raw bytes. Response `{ ok: true, value: { receiptId, file: { attachmentId, name, bytes } } }`. `dsh-client-file-upload` · `FILE_UPLOAD_PATH` |
| `/api/present.host` | GET | `dsh-client-ui-deliverables` · `PRESENT_HOST_PATH` |
| `/api/present.open` | POST | `dsh-client-ui-deliverables` · `PRESENT_OPEN_PATH` |
| `/open-in-app/apps` (exact), `/open-in-app/icon` (prefix), `/open-in-app/open` (exact) | GET / GET / POST | `dsh-host-open-in-app`; fenced + authenticated |
| `/api/<typert endpoint>` | POST | Gateway interceptor; unclaimed → `404` |
| `/api` prefix | any | `dsh-client-connection` `bridge()` → shared Fetch handler |

### 1.5 `/plugins` — client bundle serving and HMR (both **unauthenticated**)

- Prefix `/plugins` (`dsh-client-modules` host half, ctx key `clientModules`, `static inject = ["loader"]`), registered as `webServer.register({kind:"prefix", path:"/plugins", handler: serveBundle})`.
  - **The served form is the revisioned one-resource combo**: `` /plugins/??<id1>/client.js,<id2>/client.js&rev=<rev> `` (`comboUrl`, `dsh-client-modules/lib/index.js`). `MAX_COMBO_URL_BYTES = 3 * 1024` bounds batch partitioning; graph `rev = shortHash(JSON.stringify({entries,batches}))` (sha1 → 12 hex).
  - **Lookup is by exact `pathname + search`** (`bundleResource`), so the *un-revisioned* single-bundle path `/plugins/<id>/client.js` is **not** a served form — a live probe of `/plugins/@deepseek-ai/dsh-client-modules/client.js` returned `404`. Unknown → `404`; non-GET/HEAD → `405`; hit → `200 text/javascript; charset=utf-8` + `cache-control: public, max-age=31536000, immutable`. (`/plugins/<id>/client.js` *does* appear as a fallback `sourceUrl` for sourcemap comments, which is a different thing.)
- Exact `/plugins/events` — **HMR SSE channel**, `content-type: text/event-stream`.
  Frames (`dsh-client-hmr/lib/types/events.d.ts` · `PluginsEventFrame`):
  `{ type: "graph", graph: WebBootGraph }` | `{ type: "rebuilt", id, rev }`.
  `parsePluginsEventFrame` yields `frame` / `unknown` / `invalid`.

### 1.6 Fallback route — the SPA

`dsh-host-frontend-static` · `serveStatic` registers the **fallback** seat:
serves the built dist root and the index file; the index path calls
`ctx.connection.authorizeIndex(req, res)` (**token → cookie exchange**, see §5) and then
`ctx.webServer.renderIndex(html)` (adds `<base href="/">`).
Traversal outside the dist root → `403`; missing → `404`; non-GET/HEAD → `405`.
**Static assets are public**; only the index is authenticated.

---

## 2. The session protocol

### 2.1 Durable event envelope

Host type `SessionEvent<T>` / wire type `SessionWireEvent`
(`dsh-session/lib/types/types.d.ts`, `dsh-api-session-controller/lib/types/types.d.ts`):

```ts
SessionWireEvent = {
  type: string            // event name (see §2.2)
  seq: number             // monotonic, contiguous within the session
  time: number            // unix epoch ms
  data: JsonValue         // event-specific payload
  ignorable?: true        // safe-to-skip marker for unknown types
  sourceEventSeqs?: JsonValue   // surface events only: cited earlier sources
  surfaceOp?: JsonValue         // surface events only: 'append' | {op:'replace',startSeq,endSeq}
}
```

- **Format version:** `SESSION_FORMAT_VERSION = 3` (`dsh-session/lib/types/types.d.ts`). A monotonic integer; bumps only for structural changes (header shape, envelope, core semantics, surface mechanism). **Adding an ordinary event type does not bump** — `ignorable` covers vocabulary growth.
- **Persisted vs transient:** *every* `SessionEvent` is durable (has `seq`, is written to the per-session log) and is the only thing the transcript is rebuilt from. The **only** client-visible non-durable record is `assistant/live-chunk` (§2.5), which is Client-memory only.
- **Surface events** (exactly 4): `system/message`, `user/message`, `assistant/message`, `tool/result`. Only these carry `surfaceOp`; the other three may also cite `sourceEventSeqs`. Non-surface events must not carry either (compile-enforced at `Session.append()`).
- **`session/end-seed`** marks the end of a constructor seed (resume/fork/replay): events before it came from the seed, not this lifecycle. Fresh forks own one `{ inherited: true }` marker at the cut.

### 2.2 Event vocabulary — 56 known types

`dsh-session/lib/types/known-event-types.js` · `KNOWN_SESSION_EVENT_TYPES` (generated by `scripts/gen-persistence-catalog.ts`). The read path **refuses to interpret a log containing a type outside this set unless the event carries `ignorable`** — that refusal is deliberate (silently skipping a required unknown event would reconstruct a wrong session).

**Core loop (`dsh-session/lib/types/types.d.ts`)**

| type | fields | notes |
|---|---|---|
`turn/start` | `turn` | opens a turn before queued input is claimed |
`turn/end` | `turn`, `reason` | `TurnEndReason` = `{kind:'completed'}` \| `{kind:'aborted', reason: TurnEndCancelCause}` \| `{kind:'blocked'}` \| `{kind:'error', error: LlmFailure}` \| `{kind:'max-tokens'}` \| `{kind:'interrupted'}`. `TurnEndCancelCause` = `user` \| `parent` \| `{kind:'hook',reason}` \| `disposed` \| `legacy` |
`step/start` | `turn`, `step` | one model call plus the tool executions it requested |
`step/end` | `turn`, `step` | |
`user/message` | `UserMessage` (incl. `source`) | **surface**. `source` distinguishes a human prompt (`user-rpc` + `rpcId` + optional `clientTimeZone`) from `agent.inject()` context and goal continuation rounds |
`system/message` | `turn`, `step`, `message: SystemMessage` | **surface**, node 0 |
`assistant/message` | `turn`, `step`, `message: AssistantMessage`, `stream: AssistantStreamRecord[]`, `usage?: TokenUsage`, `interrupted?: true` | **surface**. Usage travels with the message — there is no separate usage event. A mid-stream cancel finalizes the delivered prefix with `interrupted: true` |
`assistant/attempt` | `turn`, `step`, `stream` | a settled model attempt that committed **no** surface message (failed/retried/cancelled) |
`tool/call` | `turn`, `step`, `callId: ToolCallId`, `name`, `arguments: string` (raw, unparsed) | pairs with `tool/result` by `callId` |
`tool/result` | `turn`, `step`, `message: ToolResultMessage`, `error?: {name,code}`, `meta?: JsonValue` | **surface**. `meta` is tool-private presentation payload (must be JSON-safe, runtime-validated by `isJsonValue`) |
`request/header` | `header: EpochHeader`, `reason: 'initial'\|'resume'\|'change'\|'series'`, `startsSeries?` | log-only; latest snapshot reconstructs the header. `EpochHeader = { config: LlmCallConfig, adapterDefaults?, tools?: ToolSchema[] }` |
`request/context` | `RequestContext` = `{provider, model, contextWindow?, systemPromptUpdate?}` | log-only route metadata, only on change |
`session/end-seed` | `inherited?: true` | |

**Plugin-augmented (`declare module '@deepseek-ai/dsh-session/types' { interface SessionEventMap { … } }`)**

| type | owner | fields |
|---|---|---|
`model/selection` | api-session-controller | `ModelSelection = {provider, model, reasoningEffort?}` |
`approval/policy` | dsh-user-approval | `policy: ApprovalPolicy`, `source?: 'delegation'` |
`approval/asked` | dsh-user-approval | `id: ApprovalRequestId`, `toolName`, `callId?`, `reason?` |
`approval/decided` | dsh-user-approval | `id`, `outcome: ApprovalOutcome` (exactly one per ask; fail-closed `unavailable`) |
`plan/mode` | dsh-plan-mode | `active: boolean` (last wins) |
`sandbox/mode` | dsh-sandbox-policy | `mode: SandboxMode`, `source?: 'delegation'` |
`permission/preset` | dsh-permission-presets | `preset: string` |
`goal/change` | dsh-goal | `GoalChangeMeta` (complete post-mutation state or clear tombstone) |
`compaction/start` | dsh-compaction | `compactionId`, `sourceCommandId?`, `turn: number \| null` |
`compaction/summary` | dsh-compaction | `compactionId`, `sourceCommandId?`, `summary: ContentBlock[]`, `shadowedRange:{start,end}`, `shadowedSeqs`, `shadowedTokenCount`, `provider`, `model`, `maxTokens?`, `usage?`, `rawOutput?`, `llmStreamCall?` |
`compaction/end` | dsh-compaction | `compactionId`, `sourceCommandId?`, `turn`, `error?` |
`compaction/prune` | dsh-compaction | `shadowedRange`, `shadowedSeqs`, `shadowedTokenCount` |
`session/title` | dsh-session-title | `SessionTitleEventData` (latest-wins snapshot, log-only) |
`session/title-llm-request` | dsh-session-title-llm | one-shot title request record |
`feedback/message-put` / `feedback/message-delete` | dsh-message-feedback | log-only human rating/note |
`feedback/record` | dsh-command-feedback | `FeedbackRecord` (log-only remark) |
`agent/inbox/spliced` | dsh-agent | `target: InboxTarget`, `start`, `removedCount?`, `inserted: UserMessage[]`, `outcome?: 'canceled'` |
`command/run` / `command/done` | dsh-commands | run: `commandId`, `name`, `args?`, `source: CommandSource`; done: `commandId`, `kind:'success'\|'error'`, `text?`, `sourceEventSeq?` |
`agent-preset/selected` | dsh-agent-presets | `agentPreset: string` |
`todo/write` | dsh-tool-todo | `todos: TodoItem[]` (whole-list snapshot, latest wins) |
`deliverables/presented` | dsh-tool-present | `turn`, `callId`, `files: PresentedFile[]` |
`subagent/descriptor` | dsh-subagent | `SubagentDescriptorData` (durable child identity + lifecycle mode) |
`subagent/catalog` | dsh-subagent | `SubagentCatalogEvent` (parent-owned discovery fact) |
`subagent/model-selection-policy` | dsh-tool-subagent | `allowedModels: AllowedModelRoute[]` |
`schedule/change` | dsh-schedule | `ScheduleChange` (versioned mutation) |
`hook/invoked` / `hook/result` | dsh-hook-protocol | invoked: `turn`, `point`, `dialect`, `matcher?`, `handlerId`; result: `turn`, `point`, `handlerId`, `decision`, `exitCode?`, `stderrSummary?`, `durationMs` |
`llm/retry` / `llm/retry-started` | dsh-llm-retry | `LlmRetryEventData` / `LlmRetryStartedEventData` |
`tool/ptc-dispatch-start` / `tool/ptc-dispatch` | dsh-tools | `PtcDispatchStartEventData` / `PtcDispatchEventData` (parent `run_code` id, `subCallId` `<parent>:ptc:<n>`, `name`, normalized `arguments`, outcome `content`+`isError`) |
`session-log-deepseek/delivery-accepted` | dsh-session-log-deepseek | `sessionId`, `sessionFormatVersion?`, `throughSeq` |
`web/deepseek-search-llm-request` | dsh-web-search-deepseek | `DeepSeekSearchLlmRequest` (secret-free) |
`tool-workflow/run-start` / `agent-start` / `agent-end` / `run-end` | dsh-tool-workflow | run identity, member sequence, child Session, terminal reason |

**Recognized but not declared by any installed package:** `team/member`, `team/task`, `team/message/queued`, `team/message/delivered`. They appear only in `KNOWN_SESSION_EVENT_TYPES` (and legacy format-migration code) — the declaring plugin is not in this install. Treat them as reserved names.

### 2.3 Commands the frontend can send

Source of truth: the generated `TypertRemoteMap` in each package's `lib/typert.remote-client.d.ts` — **this is the exact `ctx.remote` surface**. Every unary entry is `POST /api/<name>`. There are **16 `session/*` endpoints** plus `skills/list` and `fileReferences/list`.

**Session namespace** (`dsh-api-session-controller`) — the important one:

| endpoint | args | result |
|---|---|---|
`session/prompt` | `SessionPromptRequest` | `{accepted:true}` |
`session/cancel` | `{sessionId}` | `{accepted:true}` |
`session/updateQueue` | `{sessionId, itemId: MessageId, action: QueueAction}` | `{accepted:true}` |
`session/create` | `{workspaceId?, cwd?, sessionId?, agentPreset?}` | `{sessionId, agentPreset?}` |
`session/fork` | `{sessionId, atSeq?}` | `{sessionId}` |
`session/rename` | `{sessionId, title}` | `{title, seq}` |
`session/selectModel` | `{sessionId, provider, model, reasoningEffort?}` | `{selected: ModelSelection}` |
`session/list` | `{cursor?}` | `{items: SessionSummary[]}` |
`session/search` | `{query}` | `{items, hasMore}` (limit 20, snippet ≤240 code points) |
`session/page` | `SessionPageRequest` | `SessionPage` (unary; backwards history) |
`session/follow` | `SessionFollowRequest` | **`AsyncIterable<SessionFollowFrame>` — the event stream** |
`session/control` | — | **`AsyncIterable<SessionControlFrame>` — the Host-wide live control stream** |
`session/attachment` | `{sessionId, attachmentId}` | `{attachment, data}` |
`session/modelCatalog` | — | `ModelCatalog` |
`session/canOpenWorkspacePath` | — | `boolean` |
`session/openWorkspacePath` | `{path, action?: 'reveal'}` | `{opened:true}` |
`skills/list` | `{sessionId}` | `{skills: SkillEntry[]}` |
`fileReferences/list` | `(agentId, query)` | `FileReferenceCandidate[]` |

`SessionPromptRequest` = `{ requestId: SessionRequestId, sessionId, mode: 'queue' | 'steer', content: PromptContentPart[], clientTimeZone? }`.
`PromptContentPart` = `{type:'text', text}` | `{type:'image', mediaType, data, name?}` | `{type:'file', receiptId}`.
`SessionRequestId` is **client-minted** and is the reconciliation identity (§3.4).
`QueueAction` = `{kind:'edit', content}` | `{kind:'remove'}` | `{kind:'steer'}`.

> **There is no `session/resume` command.** Resume is implicit: any command that can resolve an ordinary Session ("model, rename, prompt, and file-reference operations may resolve or resume an ordinary Session") will resume it on the Host. `create` and `fork` are the **only** operations that create a new Agent.
> **There is no `session/compact` command.** Compaction is a **slash command**: `commands/execute(agentId, line, attachments)` with e.g. `/compact`. Same for `/export`, `/goal`, etc.
> **There is no `session/setEffort` / `setPermission` / `setTitle` RPC** beyond `session/selectModel` (`reasoningEffort` travels inside `ModelSelection`) and `session/rename`.

**Commands namespace** (`dsh-commands`): `commands/execute(agentId, line, submittedAttachments)` → `CommandExecution | undefined`; `commands/list(agentId)` → `CommandDescriptor[]`. This is how `/compact`, `/export`, `/goal`, and every slash command reach the Host.
**Subagents** (`dsh-subagent`): `subagents/list(parentSessionId)`, `subagents/prompt(SubagentPromptRequest)`, `subagents/interruptByParent(childSessionId, parentSessionId, 'continuable')`.
**Goals** (`dsh-goal`): `goals/get|create|edit|pause|resume|complete|clear`.
**Message feedback** (`dsh-message-feedback`): `messageFeedback/list|put|delete`.
**Session feedback** (`dsh-command-feedback`): `sessionFeedback/record`.
**Settings/credentials** (`dsh-api-settings-controller`): `settings/describe`, `settings/update(ns, patch, expectedRevision)`, `settings/replace`, `settings/mutate(ns, ops, expectedRevision)`, `settings/openSettingsDocument`, `settings/openAgentPresetDirectory`, `settings/canOpenAgentPresetDirectory`, `credentials/describe`, `credentials/set`, `credentials/unset`.
**Agent presets** (`dsh-agent-presets`): `agentPresets/list|read|select|copy|deletePreset`.
**LLM** (`dsh-llm`): `llm/listProviders`, `llm/listConfigurableProviders`, `llm/discoverModels`.
**Workspace controller** (`dsh-api-workspace-controller`, namespaces `workspace` + `directoryPicker`) — all unary except `workspace/follow`:

| endpoint | request | response |
|---|---|---|
`workspace/create` | `{ path }` | `{ workspace, created: boolean }` |
`workspace/rename` | `{ workspaceId, title }` | `{ workspace }` |
`workspace/delete` | `{ workspaceId }` | `{ deleted: true }` |
`workspace/insertBefore` | `{ workspaceId, beforeWorkspaceId? }` | `{ workspaceIds }` |
`workspace/insertSessionBefore` | `{ workspaceId, sessionId, beforeSessionId? }` | `{ workspace }` |
`workspace/archiveSession` | `{ sessionId }` | `{ archivedSessionIds }` |
`workspace/follow` (**stream**) | — | `{type:'baseline', value:{items, archivedSessionIds}}` then `{type:'upsert',workspace}` \| `{type:'remove',workspaceId}` \| `{type:'order',workspaceIds}` \| `{type:'archived',archivedSessionIds}` |
`directoryPicker/pick` (signal) | — | `string \| null` |
`directoryPicker/list` | `path?` (absent = home) | `{ path, home, crumbs, entries: [{name,path,hidden}], truncated }` |
`directoryPicker/createDirectory` | `{ path, name }` | `string` |

`WorkspaceView = { workspaceId, path, title, sessionIds: SessionId[], createdAt, updatedAt }` (ISO-8601). **There is no `workspace/list`, `open`, `roots`, or `cwd` operation** — the full list arrives only as `follow`'s `baseline`, and reconnect is a replacement baseline with no cursor. **cwd lives on the Session**, not the workspace (`session/create` args `{workspaceId?, cwd?, sessionId?, agentPreset?}`); membership requires the Session header `cwd` to canonicalize to `Workspace.path`. Codes: `workspace/invalid-path`, `workspace/name-conflict`, `workspace/move-invalid`, `workspace/not-found`, `directory-picker/{unavailable,unreadable,exists,create-failed}`.

**Workspace files** (`dsh-api-workspace-files`, namespace `workspaceFiles`) — **READ-ONLY; there is no write/mkdir/delete/rename/upload/download operation.** First wire arg is the lookup `workspaceFileScopeId`, which **is a `SessionId`**; it resolves from the live Session header else `sessionPersistence.stat()`, with `workspaceRoot = header.cwd ?? sandboxPolicy.workspaceRoot`; unresolvable → `gateway/lookup-not-found`. Every method takes `cancellation: {parameter:'signal'}`.

| endpoint | request (after session id) | response |
|---|---|---|
`workspaceFiles/stat` | `path` | `{ absolutePath, version, bytes? }` |
`workspaceFiles/read` | `path`, `range {offset?, limit?}` | stat + `{ offset, text, lines, eof }` |
`workspaceFiles/readBytes` | `path`, `range {offset?, length?}` | stat + `{ offset, data (base64), eof }` |
`workspaceFiles/readAll` | `path` | stat + `{ offset:0, eof:true }` |
`workspaceFiles/readRelated` | `path`, `relativePath` | bytes from `dirname(path)` |
`workspaceFiles/list` | `path` | `{ path, entries:[{name,type:'file'\|'directory'\|'other',size?}], truncated }` |
`workspaceFiles/changes` (**stream**) | — | `{kind:'ready'}` \| `{kind:'change', change:{absolutePath,version} \| {absolutePath,absent:true}}` |

- **Watch is instrumented, not OS-level:** the source is `fs/observed` filtered to the Session workspace root — *"the operating system is not watched"*. The client `ChangeFeed`/`Follower` fans one stream per Session.
- **Path safety:** every op `lstat`s first (missing → `workspace-file/not-found`); final symlink / wrong kind → `workspace-file/not-regular-file{path,kind}` / `not-directory`. `read`/`readBytes`/`readAll`/`readRelated`/`stat` accept absolute or root-relative paths and are **NOT workspace-confined** (the composed `ctx.fs` read authority decides; *"sandboxing backend fences writes and edits, not reads"*). **Only `list` is confined** — `fs.contains(root, fs.resolve(path))` else `workspace-file/outside-workspace` — and `changes` filters on root. Empty path → `gateway/bad-request`. `read` rejects invalid UTF-8/NUL (`workspace-file/not-text`); `readBytes` decodes nothing. `workspace-file/too-large{path,limit}`.
- **Caps:** `maxBytes` 2097152, `maxFileBytes` 33554432, `maxLines` 5000, `maxEntries` 2000. Resource address grammar `dsh-resource://file/session/<sessionId>/<path>` (`absolute/<path>` parses but fails `unknown-workspace`).
- **Upload / download are elsewhere:** upload = `fileUploads/upload` + the raw `POST /api/session/uploadFileBinary` route; download = the exact GET routes `/api/file` and `/api/session.export`.

**Settings / credentials** (`dsh-api-settings-controller`, namespaces `settings` + `credentials`):

| endpoint | request | response |
|---|---|---|
`settings/describe` | — | `{ writable, hasDocument, namespaces: SettingsNamespaceView[] }` |
`settings/update` | `ns, patch: Record<string,JsonValue>, expectedRevision?` | `SettingsNamespaceView` |
`settings/replace` | `ns, section, expectedRevision?` | `SettingsNamespaceView` |
`settings/mutate` | `ns, ops: SettingsPathOpView[], expectedRevision?` | `SettingsNamespaceView` |
`settings/openSettingsDocument` (signal) | — | `{opened:true}` |
`settings/canOpenAgentPresetDirectory` | — | `boolean` |
`settings/openAgentPresetDirectory` | `agentPreset` | `{opened:true}` \| `{opened:false, path}` |
`credentials/describe` | `refs: string[]` (**≤ 64**) | `Record<string, CredentialInfo>` |
`credentials/set` / `credentials/unset` | `ref, value` / `ref` | `void` |

`SettingsNamespaceView = { ns, schema (schemastery `toJSON()`), value (redacted), base?, user?, applies:'live'|'restart', secrets:[{path, set:boolean}], revision }`; `SettingsPathOpView = {op:'set',path,value} | {op:'unset',path}` (empty path = root). **Persistence:** `dsh-settings-file` `config.path`, default `<harness home>/settings.yaml`; the wire never returns the Host path (only `hasDocument`). Credentials live in `$DSH_HOME/.credentials.yaml`. **Precedence is schema defaults → composition `base` (cordis.yml entry config) → the single user layer; there is no project or session scope.** `update` deep-merges into the user section; `replace({})` resets to base+defaults; writes are serialized per namespace and `expectedRevision` is judged at the queue front → `settings/conflict{ns,expected,actual}`. Refusals: `settings/rejected{ns}`, `credential/rejected{ref}` — details never carry the value.
**File upload** (`dsh-client-file-upload`): `fileUploads/upload(agentId, EncodedFileUploadRequest)` — the base64 **fallback**; the raw path is §1.4.
**Cordis dynamic runner** (`dsh-cordis-host-runner`): `dynamicCordisRunner/*` incl. `runHostHalf`, `settleUserRun`, `resolveRequestRun(requestId: ApprovalRequestId, resolution)`, `resolveInspectQuery`.
**Plugin inventory** (`dsh-host-plugin-inventory`): `pluginInventory/list`.

**The Remote mechanism underneath all of this.** These are not REST resources; they are generated typed RPC methods (`@deepseek-ai/dsh-typert-protocol` · `@Remote` / `@RemoteScope`, `TypertRemoteService`, `InvocationDescriptor`), shipped as per-package generated artifacts `lib/typert.host.{js,d.ts}` (`TYPERT`) and `lib/typert.remote-client.{js,d.ts}` (`TYPERT_REMOTE`). A "Remote" here means **a typed Host capability projected onto the wire — not a remote machine** (see §4.6 for what `dsh-api-remotes` actually is).

- A cancellation-aware method declares `signal: AbortSignal` as its **final Host parameter**; the signal is descriptor metadata, not a wire argument — Connection supplies it, Gateway injects it after decoding.
- **Errors are `RemoteError<Code>`** with `code`, `message`, typed `details`, and an `isDSHRemoteError` marker. **Branch on `code`, never `instanceof`** — the subclass identity survives only in-process. Universal codes: `gateway/bad-request{issues?}`, `gateway/cancelled{}`, `gateway/internal{}`. Infrastructure codes include `gateway/lookup-not-found`, `gateway/method-unavailable`, `gateway/signature-invalid`. A non-Remote throw folds to `gateway/internal`; a business refusal keeps its own code (e.g. `session/conflict`, `settings/conflict`, `workspace-file/outside-workspace`).
- `error.details` is typed per code by each owner's `declare module '@deepseek-ai/dsh-typert-protocol' { interface RemoteErrorDetailsMap { … } }`. Session adds 13: `session/model-unavailable`, `session/conflict`, `session/agent-busy`, `session/invalid-time-zone`, `session/workspace-attach-failed`, `agent-preset/conflict`, `session/attachment-invalid`, `session/queue-item-not-found`, `session/steer-unavailable`, `session/title-invalid`, `session/fork-unavailable`, `subagent/not-found`, `subagent/catalog-diagnostic`, plus the base `session/not-found`.
- **`RemoteResult<T> = {ok:true, value} | {ok:false, error}` never rejects for a carrier problem** — an offline carrier is folded into the error branch, and a caller-signal abort becomes `gateway/cancelled`. Only an *assembly* fault still throws (wrong arity, unmounted method, withdrawn contribution, missing Context adapter).

### 2.4 Approval and user questions (both are waterfalls, not RPCs)

- **Approval.** `dsh-user-approval` · `ctx.userApproval.ask()` runs a composed answerer chain. The browser contributes an **Agent-scoped answerer over the Remote Event waterfall**: the Host pushes
  `{ type: "waterfall", event: "approval/request", eventId, agentId, request }` on `$events`, and the UI posts its decision back to `$events/result` as `{ clientId, eventId, outcome }`.
  Missing / throwing / aborted answerer → outcome `unavailable` / `cancelled`; **callers fail closed on `unavailable`**.
  Audit trail is durable and log-only: `approval/asked {id, toolName, callId?, reason?}` then `approval/decided {id, outcome}`.
  Policy is durable too: `approval/policy { policy, source?: 'delegation' }` (last one wins).
- **User questions.** `dsh-user-questions` · `ctx.userQuestions.ask(request)` → dispatches an answerer waterfall (event key `user-questions/request`).
  `AskUserQuestionRequest = { questions: [{ id, question, detail?, header?, options?: [{label, description?}], multiSelect?, intent? }], agent?, signal? }`
  `AskUserQuestionAnswer = { answers: [{ id, selected: string[], custom? }] }`
  `AskUserQuestionIntent = { kind: 'plan-review', approve }` — presentation only; `dsh-plan-mode` tags the `exit_place_mode`-family `exit_plan_mode` question with it. A UI that ignores the tag renders the generic option list and produces the same answer fields.
  Errors: `EMPTY_QUESTIONS`, `BAD_INTENT`, `NO_PROVIDER`, `ASK_ABORTED`, `CALLER_NOT_LIVE`, `DELEGATED_CALLER`. The Web answerer receives **only Agent-scoped** requests.
  Note routing: the *tool name* is `ask_user_question` (`dsh-tool-ask-user/lib/index.js`), with snake_case tool args (`multi_select`) mapped to camelCase wire fields (`multiSelect`).

### 2.5 The three server→client stream shapes

**(a) `session/follow` — `SessionFollowFrame`:**

```ts
| { type: 'snapshot'; header: SessionWireHeader; cursor: number;
    records: SessionHistoryRecord[]; hasMore: boolean;
    projections: SessionProjectionBaseline;
    assistantStream?: SessionAssistantStreamBaseline }
| { type: 'event'; event: SessionWireEvent }            // SessionEventEntry
| { type: 'assistant-stream'; frame: SessionAssistantStreamFrame }
```

`SessionWireHeader = { version, id, createdAt, cwd?, parentSession?, isSeeded, origin?: 'subagent', delegationDepth?, agentPreset? }` (`SessionWireHeader` ≡ the durable `SessionHeader` minus `isSeeded`'s prefix length).
`SessionProjectionBaseline = { asOfSeq: number, values: SessionProjectionValues }`.

**(b) `session/control` — `SessionControlFrame`:** exactly one `{type:'baseline', value: SessionControlBaseline}` per generation, then deltas.
`SessionControlBaseline = { queues: Record<SessionId, SessionQueuedItem[]>, jobs: Record<SessionId, SessionJob[]>, projections: Record<SessionId, SessionProjectionBaseline> }`.
Deltas: `{type:'queue', sessionId, items}` | `{type:'jobs', sessionId, jobs}` | `{type:'projection', sessionId, key, value, seq}`.
`SessionQueuedItem = { id: MessageId, placement: 'queued'|'steering'|'context', rpcId?: SessionRequestId, message: {id, content} }`.
`SessionJob = { id, kind, label, status: 'running'|'stopping'|'completed'|'killed'|'failed', detail?, startedAt, finishedAt? }`.

> Because every generation opens with a **complete process-local baseline**, reconnect **replaces** queue/jobs/projection state rather than replaying. Control baselines cannot reconstruct jobs after a Host restart (`dsh-api-session-controller/README.md` §Limitations).

**(c) Assistant streaming frames** — the one deliberately transient channel.

`SessionAssistantStreamBaseline = { revision: number, activeAttempt?: SessionAssistantStreamAttempt }`;
`SessionAssistantStreamAttempt = { attemptId: LlmAttemptId, startedAfterSeq: SessionSeqCursor, turn, step, nextIndex, stream: JsonValue[] }`.
`SessionAssistantStreamFrame` =
`{type:'start', attemptId, revision, startedAfterSeq, turn, step}`
| `{type:'chunk', attemptId, revision, index, time, chunk}`
| `{type:'end', attemptId, revision, index, outcome: {kind:'committed', eventType:'assistant/message'|'assistant/attempt', seq} | {kind:'abandoned'}}`.

Client-side projection of a chunk: `AssistantLiveChunkEvent = { type: 'assistant/live-chunk', seq: number, time, data: { attemptId, turn, step, chunk } }`.
This is **`SessionEvent`-shaped but not durable** — the README calls it "Client-only live chunk presentation; `seq` orders the transient row between durable Session seqs". On the wire entries are tagged `{type:'transient', event}` versus `{type:'event', event}` (`SessionEventLikeEntry`).

**Settlement rule (this is the transcript-integrity contract):** an `end` frame with `outcome.kind:'committed'` publishes one `settle-assistant` delta `{attemptId, entry?}` that **retires the attempt's transient rows and adds the durable entry in one step**; `{kind:'abandoned'}` publishes a settlement with **no** entry, so transient rows retire immediately. A durable `assistant/message`/`assistant/attempt` arriving after an active opening is staged only when its `seq` follows `startedAfterSeq` **and** its `turn`/`step` match; earlier same-step retries remain visible. Revision / dense-index / settlement gaps for a *known* attempt reopen `follow`; a controller that missed the `start` ignores unknown-attempt frames and waits for the durable settlement. A replacement Agent may restart `revision` at 1.

### 2.6 Histories / page / follow semantics

- `SessionFollowRequest = { address: SessionAddress, maxMessages?, assistantStream?: true }`.
  `SessionAddress = {kind:'session', sessionId} | {kind:'subagent', parentSessionId, childSessionId, mode:'one-shot'|'continuable'}`.
- `SessionPageRequest = { address, throughSeq: number, beforeSeq?, maxMessages? }`. `throughSeq` is the **inclusive log cut obtained from the corresponding follow opening frame**; a page never crosses its own `throughSeq`.
- `SessionPage = { records: SessionHistoryRecord[], hasMore: boolean }`; **every history record covers exactly its own event seq**.
- The wire form embeds compact assistant streams inside `assistant/message` / `assistant/attempt` events — one durable settlement per attempt, no separate replay of deltas.

---

## 3. What state lives where

### 3.1 Server-authoritative

- **The session event log** — append-only, one artifact per session, per-session JSONL with checksummed Zstandard frames by default, root-configured (`dsh-session-persistence-jsonl`). It is the single source of truth; everything below is derived or cached.
- **Projections** — synchronous folds of committed events registered by domain plugins (`dsh-session-projection`). Snapshots carry `asOfSeq` so a carrier can pair state with the exact history cut. Durable checkpoints exist (`dsh-session-projection-cache`), and the README is explicit: *"The session log remains authoritative: a crash can leave a checkpoint stale, but never ahead of committed events."*
- **The pending queue** (`agent/inbox/spliced`), **jobs**, **subagent catalog**, **session list**, **model catalog**, **settings**, **credentials**.
- **Live/process-local** state that is authoritative but **not durable**: the assistant stream baseline (`revision`, `activeAttempt`), the queue/jobs/projection baseline of the control stream, `agent/inbox/spliced`-derived inbox identity.

### 3.2 Client-cached / client-only

| State | Where | Durable? |
|---|---|---|
Event window (`SessionEventWindow`) | `dsh-api-session-controller/client` · `MutableSessionEventSource` | no — rebuilt |
`entries`, `hasMore`, `revision`, `change` | same | no |
`SessionSnapshot` (`queue`, `running`, `openState`, `blank`, `promptError`, `awaitingFirstTurn`, …) | `client/contract/snapshot.d.ts` | no |
`pendingSubmissions` (local echoes) | same | **no — client memory only** |
`AssistantLiveChunkEvent` rows | `client/contract/events.d.ts` | no |
Session list / search / subagent catalog snapshots | `client/sessions/manager.d.ts` · `SessionListSnapshot` | no |
Selected session + navigation address | `SessionManager(restoredSelection?, restoredAddress?)` | restored across reload via the URL, not a client store |
Conversation view prefs | `localStorage` key `"dsh.conversation"` (+ per-session `"dsh.conversation.<sessionId>"`), content width `"dsh.conversation.contentWidth"` | yes (browser only) |
Locale | settings namespace `"locale"`; absence delegates to the browser | server settings |

### 3.3 Rebuilding the transcript after a reload

The reload path is **follow-before-page**, never "page then subscribe":

1. `SessionEventStream` (a Gateway `RemoteJournalStream`) **opens `session/follow` first** — with `assistantStream: true` on the Web adapter — before any history page. This closes the race where an event lands between the page and the subscription.
2. The opening `snapshot` frame carries `header`, `cursor`, `records`, `hasMore`, `projections`, and `assistantStream` baseline. That is a complete, self-consistent window.
3. Backwards paging has two verbs (`ISession`, `client/transport.d.ts`):
   - `loadOlder()` — pulls **one 50-message page**;
   - `loadThrough(seq)` — the **turn-jump** loader: loops **200-message** pages until the window covers `seq` (a turn's `turn/start` seq). Repeated calls lower a shared target; it stops on a page that makes no progress and reports busy through the same `loadingOlder` snapshot bit.
   Implementation constants: `maxMessages: 50` (initial open and `loadOlder`), `maxMessages: 200` (jump) in `dsh-api-session-controller/lib/client.js`.
4. The client publishes only **contiguous** changes: `replace`, `prepend`, `append`, `settle-assistant`. `RemoteJournalStream` "removes complete duplicates and **rejects gaps, inverted ranges, and partial overlaps**".
5. **Gap repair:** a sequence gap triggers a **tail page** repair (`repairRequest`); a durable gap-repair page has no Assistant baseline, so its held notification reopens follow once for a paired page+baseline.
6. Durable seqs are the merge key. Client-only `transient` rows are ordered between durable cursors by their synthetic `seq` and never advance the durable cursor.

### 3.4 Reconnection

`dsh-client-connection/README.md` §Connection generation:

- **Generation model:** API Gateway Client registers the internal `$events` logical stream as the **sole generation source**, whether or not any `$on` listener exists. A generation becomes visible when its source reports `ready`. Source completion / failure / withdrawal / explicit stop clears it *before* the retry policy applies — so `onConnected` fires only after `ready`, and baseline acquisition cannot race ahead of incremental observation.
- **Retry:** continuous, capped, **jittered** exponential backoff. Delay = `cap / 2 + Math.random() * (cap / 2)` where `cap = min(backoffMaxMs, backoffBaseMs * backoffFactor ** (attempt - 1))` — i.e. **50 %–100 % jitter**. Defaults (`ConnectionRecoveryConfig`): `backoffBaseMs` 500, `backoffFactor` 2, `backoffMaxMs` 10000, `generationReadyWarnMs` 3000, `generationReadyTimeoutMs` 15000 — so the caps sequence is 500 ms, 1 s, 2 s, 4 s, 8 s, 10 s, then held at 10 s until recovery. Log line `[connection] connection lost, retry #N`. Every retry asks Gateway to replace the physical WebSocket exactly once and reopens `$events`. Gateway mux itself owns **no** independent retry schedule.
- **Handshake:** slow-Host warning logged after **3 s**; readiness timeout and abort after **15 s** by default (including time spent waiting for the socket).
- **Browser online/offline** (`watchBrowserNetwork`): `offline` aborts active work, publishes `disconnected`, and suspends automatic attempts; the next `online` transition resets the sequence and starts at the 500 ms tier.
- **Manual:** `ctx.connection.reconnect()` resets `attempt = 0`, interrupts active work, and starts retry 1 immediately.
- **Generation change signal:** the Cordis event **`connection/reset`** tells wire caches to repull (the dynamic-cordis inspect registry listens on it). `ctx.remote.$host` is **not** a store — no subscription, no generation counter.
- **Configurable:** Host Connection row `config.recovery` overrides caps, growth factor, handshake warning and cancellation times. The Host validates and **injects them into each served page**; the Client validates the bootstrap data before providing Connection. *Reload the page after changing Host recovery configuration.*
- **Resume cursor:** the *session* stream does not send a "since" cursor on reconnect. It reopens `follow`, gets a fresh `snapshot` + `assistantStream` baseline, and repairs gaps through tail pages. The *assistant* channel is explicitly **cursorless** on the Web adapter (opening carries `startedAfterSeq`/`nextIndex`/`stream`; live frames are not replayed).
- **Forwarded events are not replayed** — only the two Agent-scoped waterfalls keep their pending lifetime across replay (by `eventId`).

### 3.5 Optimistic submissions and their reconciliation

This is the cleanest part of the design and worth copying verbatim.

1. `ISession.beginSubmission(input)` synchronously inserts a `PendingSubmission` into `SessionSnapshot.pendingSubmissions` **on the submit click's own frame**, before serialization or transport. It returns `{ requestId, abandon() }`.
   `BeginSubmissionInput = { mode: 'queue'|'steer', text, attachments, onRetire? }`.
   The echo stores ordered image previews (browser-owned `previewUrl`) and durable file metadata.
2. The echo's **placement is derived** from the current running state plus the requested delivery mode (`transcript` | `queued` | `steering`), then **retained** while serialization is in flight.
3. `prompt(content, mode, signal, requestId)` sends that `requestId`. The Host echoes it as the durable user source's **`rpcId`** (`MessageSourceMap['user-rpc'] = {kind:'user', rpcId, clientTimeZone?}`), and projects it as `SessionQueuedItem.rpcId`.
4. The echo retires when either the durable `user/message` (`rpcId` match) **or** the queue occurrence (`rpcId` match) is observed — **one animation frame later** (so the durable row renders before the echo disappears). It retires immediately when the identified prompt fails or is abandoned, and as failed on disposal.
5. `onRetire` fires **exactly once**, and an `observed` retirement carries the ordered durable attachment references so the composer can release successful cards while **preserving failed drafts**.
6. **Idempotence on the Host:** a prompt retry whose `requestId` is already queued or already logged returns the **original acceptance** without inserting another message. Admission consumes opaque `fileUploads` receipts and resolves every same-Agent receipt before sending the ordered content list through `ctx.attachments`.
7. **Echoes are Client memory only.** Reload and reconnect rebuild the conversation from durable events alone.

Failure surface: `PromptError = { op: 'send'|'stop', error: RemoteFailure }` in the snapshot.

### 3.6 The in-browser resource model (`dsh-client-resources`)

This is the layer between "a path/file/session reference" and "the bytes", and it owns **no HTTP of its own** — it is a client-side registry that delegates to Remote streams.

- **Address scheme:** `RESOURCE_SCHEME = "dsh-resource"`, addresses `dsh-resource://<type>/…`. `protocolOf(address)` is the URL host lower-cased, so `sidebar://guide` names no resource.
- **Service `ctx.resources`:** `register(provider)`, `pin(address, signal)`, `source(address) → ObservableSnapshot`. A `ResourceProvider = { protocol, open(address, {signal}) → AsyncIterable<RemoteResult<T>> }`.
- **State:** `ResourceSnapshot { status: 'none'|'loading'|'live'|'failed', value, failure: RemoteFailure | undefined }`. `none` means "no provider" or "not a resource address" — deliberately not an error.
- **Cache / refcount:** one registry record per address, **kept for the whole page lifetime**. `holders = subscribers + pins`; the first holder `start()`s the provider stream with an `AbortController`, later holders share the snapshot, and the **last release aborts** and resets to `loading` (provider present) or `none`. A provider registering while addresses are already held → `attach` opens them; provider disposal → `detach` → `none`. Frames arriving after an aborting release are dropped. No localStorage, no HTTP.
- **What actually fetches:** the `file` provider lives in `dsh-api-workspace-files/lib/types/client/provider.js` (`protocol: 'file'`), addresses `dsh-resource://file/session/<sessionId>/<abs path>`. It calls `remote.workspaceFiles.stat(sessionId, path, signal)` (unary → `POST /api/workspaceFiles/stat`) **plus** `remote.$stream(...)` over `remote.workspaceFiles.changes(sessionId, signal)` — a logical stream on `wss://…/api/remote.mux`, keyed by `absolutePath`/`version`. So this is the concrete case where a read (unary) and its invalidation (stream) ride **different carriers** and must be correlated by the client.

### 3.7 Locale and the shell

- **Locale detection** (`dsh-client-locale` · `detectBrowserLocale`): walks `navigator.languages` then `navigator.language`, matching each tag **exactly against registered ids first, then by primary subtag**; fallback `FALLBACK_LOCALE = "en"`; built-ins `LOCALE_IDS = ["zh","en"]`. `document.documentElement.lang` is set to `"zh-CN"` for `zh`, otherwise the active id.
- **Translations are bundled into the client bundles** — there is no locale route and nothing in the boot payload. Each plugin calls `ctx.locale.register(ns, {zh, en})` in its own `lib/client.js`; this package ships `COMMON_NS = "common"` and `SETTINGS_NS = "settings.locale"`.
- **The preference is Host settings, not browser storage:** namespace `LOCALE_SETTINGS_NAMESPACE = "locale"`, field `LOCALE_PREFERENCE_FIELD = "preference"` (id pattern `/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u`), persisted in `$DSH_HOME/settings.yaml`. The client reads via `settings/describe` and writes via `settings/mutate('locale', …)`; live updates arrive as the forwarded event `settings/document-updated`. **`dsh-client-locale` uses no cookie, localStorage, sessionStorage or IndexedDB key at all.** (The only browser storage found in the whole client surface is conversation-view preference: `"dsh.conversation"`, `"dsh.conversation.<sessionId>"`, `"dsh.conversation.contentWidth"`.)
- **Shell:** `dsh-web-frontend` has **no README** and only `dist/`; its `package.json` exports `./dist/*` and `./package.json`, and its shell library `@deepseek-ai/dsh-client-web` is a **devDependency absent from the install** — the shell exists only as built assets (`dist/assets/index-*.js`, `dist/assets/vendor-*.js`). `dist/index.html` contains **no** `__DSH_BOOT__`; it is injected per response. The shell kernel awaits `__DSH_BOOT_READY__`, creates the module system from `__ModuleLoader__` + `__DSH_BOOT__` with a **platform seed table** (React, `react/jsx-runtime`, `react-dom`, `react-dom/client`, cordis, `dsh-client-store`, `dsh-client-ui-slots`, `dsh-client-ui-primitives`, `dsh-client-ui-dockkit`), prefetches the `immediately` tier, then feeds `manifest.plugins` to the vendored Loader entry by entry, asserts every entry activated (`web boot: N entries did not activate…`, naming `pending (waiting for service(s): …)`), and finally mounts the renderer into `<div id="root">`.

### 3.8 Development reload (HMR) — `/plugins/events`

- **SSE, not WebSocket.** `GET /plugins/events` (`EVENTS_ENDPOINT`), exact route, headers `content-type: text/event-stream`, `cache-control: no-cache`, `connection: keep-alive`; non-GET/HEAD → 405. On connect: `: connected\n\n` then one `graph` frame; frames are `data: <json>\n\n`.
- **Frames:** `{type:'graph', graph: WebBootGraph}` (ignored by the browser) | `{type:'rebuilt', id, rev}`.
- **Detection (node):** every `pollIntervalMs` (**500** default) it `statSync`s each graph row's bundle (`mtimeMs` + `size`) against the pre-read `artifactBaseline`; an unchanged startup row is watched **without a content read**. A change re-hashes bundle + source map, and **only a real `rev` change is broadcast** — a source-map-only write does not reload executable code.
- **Swap (browser):** `rebuilt` frames pass through one serialized promise queue. `reload(id, rev)` = `findEntry(entry.options.name === id)` → `ctx.modules.invalidate(id, rev)` → `await ctx.modules.prefetch(id)` → delete the old fiber from the registry → drain `oldFiber.inertia` → delete `entry.fiber` → `removeOwnedStyles(id)` (`style[data-plugin]`) → `await entry.refresh()` → `await entry.fiber?.await()`. **`invalidate` must precede `prefetch`** (it also switches the row to its single-resource combo URL at the new rev). The new bundle is `/plugins/??<id>/client.js&rev=<newRev>`.
- **Hot-swap vs full refresh:** only rows present in `clientModules.graph().entries` **with an artifactBaseline** are watched/reloadable. The Vite shell entry, the React/cordis platform seeds, and non-client packages are not graph rows, so changing them requires a page reload. With no rebuild watcher running (`pnpm run dev:web` / tsdown watch writing `lib/client.js`) the chain stays idle. **No rollback:** an import failure leaves the entry fiberless, an apply failure leaves a FAILED fiber; both are logged.
- **The HMR channel is unauthenticated**, like `/plugins` itself — see §5.

---

## 4. Plugin / boot model

### 4.1 What `dsh web` loads

`dsh web` → `lib/bin.js` → `resolveBoot(web, "web", …)` → `{mode:'profile', profile:'web'}` → `runProfile` → `dsh-app-boot.boot()`:
loads environment layers, composes profile bundles and patches, boots every plugin, returns the app or names the failing plugin and stage (`host preparation failed` vs `plugin tree failed to load`, with the deepest plugin error's stack appended).

- **Profile template:** `PROFILE_TEMPLATES.web = { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"], patchReload: "live" }` (`dsh-app-boot/lib/index.js`). Layer order: `$DSH_HOME/profiles/web/cordis.yml` (root, `[]`) → `$DSH_HOME/profiles/web/cordis.patch.yml` (user layer) → `$DSH_HOME/cordis.patch.yml` → each `--patch` overlay.
- **`dsh web` flags** (`dsh-web-app/lib/startup.js` · `webCommand()`, `.name("dsh --profile web")`, `.description("Serve the DeepSeek Harness browser UI.")`): `-h/--help`, `--host <host>`, `--port <port>` (*"pass 0 to let the OS pick a free one"*), `--no-open`, `--trusted-host <authority...>`. **There is no `--open` and no `--token`.** Published to the tree as the cordis service `webStartup` (plugin `web-startup`, `inject: ["cmdlineArgs"]`).
- **Launcher flags** (`lib/bin.js`): `--profile <name>`, `--from-default-profile <name>`, `--patch <path>` (repeatable), `--dump-config`, `--dump-default-config`, `-V/--version`; subcommands `web`, `plugin`. `error: profile "desktop" is managed exclusively by the Electron application`.
- **The dist is located by resolution, not by config:** `resolveDistIndex()` = `join(dirname(require.resolve("@deepseek-ai/dsh-web-frontend/package.json")), "dist", "index.html")`.
- **Startup prints:** `dsh web: ${authenticatedUrl} (LAN: ${lanUrl})` and `dsh web: opening the default browser; pass --no-open to disable`; on failure `web-app: could not open the default browser because <reason>; use the dsh web URL printed at startup`. Both are announced only after `loader.await()` (and not at all for a tree disposed mid-boot) — that is the supervisor readiness signal.
- Also registers the prompt sections `app:web-surface` (`webSurfacePrompt(webUrl)`) and `harness:source`, plus the managed bash env var **`DSH_WEB_URL`**.

The web profile is `dsh-web-app/cordis.patch.yml` (**484 lines**), a patch over the base bundle. Its own comment defines the layering:

```
# ── web-only host rows, the transport layer, and the browser roster ─────────
# `dsh.client` rows are the browser roster the modules node half scans into
# window.__DSH_BOOT__; the modules row is simultaneously a host row.
```

Relevant rows (ids are the cordis entry ids):
`session-controller`, `workspace-files`, `settings-controller`, `workspace-controller`, `cordis-host-runner`, `web-startup`, `webserver` (`dsh-host-webserver`, `host: !!js ctx.webStartup.host ?? '127.0.0.1'`, `port: !!js ctx.webStartup.port ?? 3080`, gzip 1, threshold 1024 B), `web-runtime` (`dsh-web-app`), `client-hmr`, `modules`, `connection`, `file-upload`, `api-remotes`, `cordis-client-runner`, then the full `ui-*` roster (theme, locale, layout, renderer, session, resources, sidebar…, plan, user-questions, trajectory).

### 4.2 The `dsh.client` declaration (client plugin discovery)

Discovery is **build-time-by-package**: the host scans the Loader's entries for packages declaring `dsh.client` and whose `platform === "web"`.

```jsonc
// package.json
"dsh": { "client": {
  "platform": "web",        // required string; only "web" is scanned
  "inject": ["@deepseek-ai/dsh-api-session-controller", …],  // package-name edges
  "external": [ … ],        // optional: non-inject module specifiers this row requests
  "immediately": true       // optional bool: stage-one prefetch
}},
"exports": {
  ".":        { "types": "./lib/types/index.d.ts", "default": "./lib/index.js"  },
  "./client": { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" }
}
```

- **Entry convention: the `./client` export subpath → `lib/client.js`.** There is no `client.js`-at-root magic and no `dsh.client.entry` field. A package that declares `dsh.client` but exports no `./client` **throws** at scan time (`client-modules: <pkg> declares dsh.client but exports no "./client" bundle`).
- **Validation is loud** (`dsh-client-modules/lib/index.js` · `parseDshClient`): non-object declaration, missing `platform`, non-string-array `inject`/`external`, non-boolean `immediately` all throw. A row must not declare its own package in `external`. A missing bundle raises `MissingClientBundleError` naming `pnpm run build`.
- `<id>/client` (the specifier bundles emit) and the bare package name resolve to the same exports (`stripClientSuffix`).
- **Roster size in this install:** 55 packages declare `dsh.client`; the shipped web overlay wires **51** as cordis rows (one, `ui-schedule`, is `disabled: true`), two more (`dsh-api-gateway`, `dsh-typert-registry`) are wired by `dsh-base` rows, and a machine-local `~/.dsh/profiles/web/cordis.patch.yml` can add more. `immediately: true` (the stage-one prefetch tier) is exactly 10: `dsh-api-gateway`, `dsh-api-remotes`, `dsh-client-connection`, `dsh-client-file-upload`, `dsh-client-hmr`, `dsh-client-locale`, `dsh-client-modules`, `dsh-client-ui-renderer`, `dsh-client-ui-theme`, `dsh-typert-registry`.
- **Discovery is incremental, never a full rescan:** `ClientModuleRegistry` listens on `internal/plugin` (`dirty.add(fiber.entry?.options.name)`) and flushes on a microtask.
- **No SRI.** There is no `integrity=` attribute anywhere in the boot path; integrity is `rev`-in-query + `immutable` caching + `404` for an unknown combination/revision.

### 4.3 The boot payload — `window.__DSH_BOOT__`

Produced by the `dsh-client-modules` **node** half as index-HTML injection rows and consumed by its **browser** half.

Wire type `WebBootGraph` (`dsh-client-modules/lib/types/client/manifest.d.ts`):

```ts
WebBootGraph = {
  rev: string                 // consistency anchor over content + bundle hashes
  entries: WebBootEntry[]     // module-graph order
  batches: WebBootBatch[]     // every entry belongs to exactly one descriptor
}
WebBootEntry = { id, url, rev, inject?: string[], immediately?: boolean, external?: string[] }
WebBootBatch = { phase: 'bootstrap' | 'application', url, rev, entries: string[] }
```

`parseBootManifest(wire)` splits it into **one wire, two consumer views**:
`BootManifest = { rev, modules: BootModuleRow[], plugins: BootPluginRow[] }`.
`BootModuleRow` adds `initialUrl` (content-addressed, used before the first HMR invalidation; `url` is the revisioned combo used after).

The modules host half injects, in order (`dsh-client-modules/lib/index.js` · `bootInjections`, driven by `ctx.on("webserver/index-inject", table => table.push(...bootInjections(this.composed)))`):
1. an inline `head` `<script>` installing the `window.__ModuleLoader__` **queue facade** (queues registrations arriving from parser-preloaded scripts),
2. `<script-preload>` (`<link rel="preload" as="script">`) for each `application` batch,
3. `<script-src>` in `head` for each `bootstrap` batch — `PARSER_PRELOAD_IDS = ["@deepseek-ai/dsh-client-modules"]` is the **sole** bootstrap batch, i.e. the module system itself is the only parser-blocking bundle,
4. `<script-global name="__DSH_BOOT__" value={graph}>`, rendered by `dsh-host-webserver` · `renderRow` as `<script>globalThis["__DSH_BOOT__"] = {…}</script>` with every `<` escaped to `\u003c`; inserted immediately after the opening `<head>`.

**There is exactly one more injected global pair** (`dsh-host-webserver`): `globalThis.__DSH_BOOT_READY__ ??= Promise.withResolvers()` plus a tail `<script>` calling `.resolve()` after the last body row. The shell awaits `__DSH_BOOT_READY__?.promise` before touching the module loader.

**What `__DSH_BOOT__` does NOT contain** (verified by enumerating `WebBootGraph`): no versions, no plugin-id list beyond the row ids, no workspace list, no locale, no flags, no base path, **no tokens**, and **no payload version field at all**. Specifically:
- the base path is a hardcoded `<base href="/">` injected by `dsh-host-frontend-static`, not boot data;
- locale, workspaces, settings and everything else arrive over Remote RPC **after** connect;
- auth is the URL query token exchanged for the signed cookie (§5).

Window API (`DshWindow`): `__DSH_BOOT__?: unknown`, `__ModuleLoader__?: ClientModuleLoaderTarget` with `{ mode: 'queue'|'live', pendingQueue, load(registration), create(options) }`.

**Two further page globals:**
- `globalThis.__DSH_CONNECTION_RECOVERY__` (`dsh-client-connection/lib/index.js`, injected via the same `webserver/index-inject` table as `{kind:'global'}`) = `ConnectionRecoveryConfig` (§3.4). This is how a deployment tunes backoff without shipping JS.
- `globalThis.__DSH_TRANSPORT__` — **consumer-side only; served pages never set it.** It is the documented extension seam §4.6 rests on: `ClientTransportHooks = { fetch, openStream?, loadBundle?, ownsHost? }`.

**Dev fixture switches** (read from `location.search`, `dsh-client-connection`): `?fixture`, `?fixturePrompt=reject`, `?fixtureAttach=fail`, `?fixtureSessionCreate=drop-response`, `?fixtureFrames=workspace-first`, `?fixtureFileChanges=demo`. These are test affordances, not a production surface.

### 4.4 The browser module system — a lazy CJS table, not ESM

`dsh-client-modules/lib/types/client/manifest.d.ts`:

- Executing a plugin bundle **only registers its factory** (`window.__ModuleLoader__.load({id, factory})`). Every module-body side effect — including CSS injection — lives inside the factory closure and runs at **materialization**, not at script execution.
- Materialization (`factory(require) → exports`) happens on first `import`/`require` and is memoized in `loadCache`; a factory requiring another registered-but-unmaterialized module materializes it recursively, so **load order needs no external sequencing**.
- Resolution branch order: seed word → shell instance; memoized record → exports; graph row → register dependency factories + own factory; registered factory → materialize; **anything else → throw** (the runtime mirror of the build-time bundle purity gate).
- The `require` handed to factories is **synchronous**; loading is async (a requested dynamic package must have registered its factory before a consumer materializes).
- Interface `ClientModuleLoader` = `{ version: 'client', manifest, loadCache, import(), prefetch(id), invalidate(id, rev?) }`. The vendored cordis Loader consumes it through the `internal` contract (`EntryTree.import` → `internal.import`), which keeps fiber lifecycle / inject waiting / update-refresh on the vendored side while this package owns **code arrival**.
- CSS ownership is tracked per module: `ClientModuleRecord.styles` holds the `data-plugin-css` `<style data-plugin>` tag ids injected during materialization.

### 4.5 `dsh-cordis-client-runner`

**It is not the shell's root container** (the shell kernel builds that, in `dsh-web-frontend/dist`). It is the **browser half for dynamic, agent-authored cordis packages** — the client peer of `dsh-cordis-host-runner`.

- Cordis deps: `inject = ["loader", "modules", "slots", "remote", "remote.dynamicCordisRunner"]`. Declaring `remote.dynamicCordisRunner` **parks the plugin until the Host half mounts** — dependency waiting is by *service name*, not by the `dsh.client.inject` package edges (those are module-graph/factory-arrival edges only).
- `apply(ctx)` order: (1) `provideClientTimer` → `ClientTimerService` on ctx key `timer` with `timeout/interval/throttle/debounce/setTimeout/setInterval` mixed in; (2) `ClientCordisInspectRegistry`; (3) `ctx.provide("cordisInspect", registry)`; (4) register first-party Inspect Providers (slots, theme, events); (5) `ctx.on("connection/reset", () => inspect.publish())`; (6) `DynamicCordisPackageRunner`; (7) `CordisRunOrchestrator` with host hooks `{runHostHalf, getClientCode, resolveRequestRun, settleUserRun}`; (8) `ctx.provide("dynamicCordisRunner", face)` with `{activeRuns, lastRunError, renderFailures, reconcileApprovals, approve, decline, startUserRun, subscribe, getSnapshot, isLoaded}`; (9) a dispose effect; (10) `ctx.remote.$on("cordis/request-run" | "cordis/request-run-resolved", …)`.
- An evaluated (agent-authored) browser half is an async function body receiving **exactly** `React, console, styles, host` — no `fetch`, no `setTimeout`, browser globals shadowed. Its returned plugin may use only lifecycle verbs plus its own declared `inject`; `host.call(method, args)` routes through the Remote namespace. Failure text carries stage `evaluate`/`module-import`/`activate` and reason `rejected`/`host-half-failed`/`client-half-failed`.

### 4.6 The API-only path (a different frontend on the same data path)

Nothing in the protocol requires DSH's own bundle. The minimal contract a foreign frontend must satisfy:

1. **Authenticate:** open `GET /?token=<printed token>` once → receive the `dsh-auth-<sha256(authority)>` cookie → thereafter present it on every `/api/*` request and on the `/api/remote.mux` upgrade. (`authorizeIndex` is the only token entry point.)
2. **Unary:** `POST /api/<endpoint>` with `content-type: application/json`, body `{type:'client-request', rpcId, method, payload}`; parse `{type:'server-response', rpcId, result}`.
3. **Streams:** open one WebSocket to `/api/remote.mux`; send `{type:'open', streamId, endpoint, payload}`; consume `item` / `error` / `end`; answer Host Pings (automatic in any WebSocket client).
4. **Event stream:** `open('session/follow', {address:{kind:'session',sessionId}, assistantStream:true})`. Handle `snapshot`, `event`, `assistant-stream`.
5. **Live control:** `open('session/control', {})` — take the baseline, then deltas.
6. **Forwarded events:** `open('$events', {args:{}})` — take `ready`, then `emit`/`waterfall`/`cancel`; post waterfall outcomes to `POST /api/$events/result`.
7. **Skip `__DSH_BOOT__` entirely.** It only exists so DSH's own shell can load DSH's own plugin bundles; a foreign frontend neither reads nor needs it. Skipping `/plugins/*` is safe and also skips the only unauthenticated surface.

**Build-boundary warning (`dsh-api-remotes/README.md` §Known Limitations):** *"The capability set is fixed by explicit build-time value imports; the Client does not discover the Host's active Services or Remote definitions at runtime."* There is **no runtime service-discovery document** — a foreign frontend must know the `TypertRemoteMap` at build time (or read the `typert.remote-client.d.ts` files, which are generated artifacts shipped in the packages). This is the single biggest parity constraint.

**The codebase explicitly supports a foreign shell.** The seam is `ClientTransportHooks` (`dsh-client-connection/lib/types/client/index.d.ts`): `{ fetch, openStream?, loadBundle?, ownsHost? }`, read from `globalThis.__DSH_TRANSPORT__`, documented as *"a shell that owns a different physical transport (the worker preview's postMessage tunnel) provides both halves here instead of forking this plugin"*. Supporting statements:

- `dsh-client-connection/README.md`: *"shell-owned compositions provide equivalent Remote streams through `connection.rpc.open` without opening a WebSocket."* / *"the Host half always provides the carrier-neutral RPC and exact `GET`/`HEAD`/`POST` route registries … a shell-owned carrier dispatches the shared Fetch handler directly."*
- `dsh-client-modules/README.md`: *"a shell-owned carrier dispatches the same exact bundle responses through `fetchBundle()`"* … *"a shell-owned carrier can render the same rows without a Web server."* Exports: `ClientModuleRegistry`, `bootInjections`, `orderByModuleGraph`, `stripClientSuffix`, `clientPath(id)`, `graph()`, `fetchBundle(request)`, `artifactBaseline(id)`, `onGraphChanged`.
- `dsh-api-remotes/README.md`: *"Its Client face can be reused by Web or a future TUI that provides the same React-free `ctx.remote` contract."*

**No README forbids an API-only consumer.** The only negative statement is in the runtime system prompt (`webSurfacePrompt`, `dsh-web-app/lib/index.js`): *"The apps/web Vite entry builds the shell but is not a standalone application because only dsh web injects window.__DSH_BOOT__. Do not start a replacement server unless the user asks."* — that rejects running the Vite dev server as a *replacement*, not consuming the API.

**A second, non-web API-only surface exists:** the `sdk` profile (`dsh --profile sdk`) with `dsh-sdk-jsonrpc-server` — *"serves the SDK wire protocol over stdio so out-of-process clients can drive harness agents"* (*"Stdout carries only JSON-RPC frames"*). If a product wants DSH's agent machinery without DSH's browser transport at all, that is the documented door; the `/api` + `/api/remote.mux` path described here is the *browser* door.

---

## 5. Auth / security (headline: auth is **not** in `dsh-host-webserver`, `dsh-web-app`, `dsh-authorization`, or `dsh-anonymous-user-id`)

It lives in **`dsh-client-connection`**, host half, class `BrowserAuth` (`lib/index.js`).

### 5.1 Authentication

- **Token → cookie exchange, no login page.** `dsh-web-app` prints a `dsh web:` line whose root URL carries `?token=…`, then opens it. `dsh-host-frontend-static` delegates the index request to `ctx.connection.authorizeIndex`, which accepts the token **only on `GET /` with exactly one `token` occurrence** (`TOKEN_QUERY = "token"`), writes a signed cookie, and `303`-redirects to clean `/` with `cache-control: no-store`, `location: /`, `referrer-policy: no-referrer`.
- **Launch token:** `processLaunchToken(owner)` = `base64url(randomBytes(32))`, memoized per `ctx.root` — one token per process, surviving Connection plugin reloads.
- **Cookie name:** `COOKIE_PREFIX = "dsh-auth-"` + `base64url(sha256(authority))` where the authority is the WHATWG-normalized `host:port`. **The name itself is authority-bound.**
- **Cookie value:** `v1.<base64url(JSON payload)>.<base64url(HMAC-SHA256(secret, body))>`; payload `{version:1, authority, issuedAt, expiresAt}`. Verified with `timingSafeEqual` + authority equality + `issuedAt <= now < expiresAt` + span ≤ maxAge.
- **Cookie attributes (exact):** `Max-Age=…; Path=/; Expires=…; HttpOnly; SameSite=Strict` — **no `Secure`** (shipped transport is loopback HTTP), **host-only** (no `Domain`). TTL `cookieMaxAgeDays` default **30**.
- **Signing secret:** owner-scoped credential record `client-connection/browser-session` (`AUTH_RECORD_KEY`), persisted by `dsh-credentials-local` in `$DSH_HOME/.credentials.yaml`; loaded into memory at Connection activation so request auth is synchronous. Deleting/replacing the record takes effect on the **next** activation.
- **No bearer.** The HTTP carrier accepts no query token outside the root exchange and no `Authorization` header.
- **Required for:** every `/api/*` HTTP request and the `/api/remote.mux` upgrade. **Not** required for `/plugins/*`, `/plugins/events`, static assets.
- **Failure body:** `401` + `text/plain; charset=utf-8` + `"dsh web authentication required; reopen the URL printed by dsh web.\n"`.
- **Anonymous user id** (`dsh-anonymous-user-id`) is **not** browser auth: file `$DSH_HOME/.anonymous-user-id` (bare `crypto.randomUUID()`, `wx` exclusive create) used only for OTel `user.id`, feedback acknowledgement, and the `x-deepseek-harness-user-id` header on DeepSeek provider requests. No cookie, no localStorage, no browser role.

### 5.2 Origin / CSRF

`isTrustedApiRequest(request, trustedHosts)` (`dsh-client-connection` · `lib/types/api-request-trust.d.ts`), enforced **before** authentication:

- `Host` must be loopback (`localhost`, `[::1]`, any `127/8`) or match a `trustedHosts` entry — exact on `host:port`, any port on port-less entries, both sides WHATWG-normalized. Absent/unparsable → refuse.
- `Origin`, when present, must satisfy `new URL(origin).host === hostUrl.host`. **Absent `Origin` is allowed.**
- `sec-fetch-site: cross-site` → refuse.
- Ordering: fence failure → **403**; trusted but unauthenticated → **401**. The `/api/remote.mux` upgrade writes these as raw `HTTP/1.1 401 Unauthorized` / `403 Forbidden` lines.
- `trustedHosts` comes from `resolveLanTrust` (sampled **once at boot**: a loopback bind derives no LAN addresses; an all-interfaces bind adds every non-internal IPv4 literal as a port-less entry) concatenated with explicit `--trusted-host` authorities. **Interface changes after boot are not re-advertised.**
- CSRF posture = `SameSite=Strict` + authority-bound signed cookie + this fence. *"These checks defend DNS rebinding and cross-site browser requests; they never establish identity."*
- **No CSP, no `X-Frame-Options`, no CORS/`Access-Control-Allow-Origin`, no HSTS** anywhere on the SPA page or any webserver response. The only CSP in the tree is on the authenticated `/api/file` route: `Content-Security-Policy: sandbox; default-src 'none'` + `X-Content-Type-Options: nosniff`.
- **Live-verified against the running GUI on this machine** (`127.0.0.1:3081`): `curl -i http://127.0.0.1:3081/` → `401 Unauthorized` with body `dsh web authentication required; reopen the URL printed by dsh web.`; `GET /api/remote.mux` without a cookie → `401`; **`GET /plugins/<id>/client.js` and `GET /plugins/events` return `200`/`404`-by-shape with no cookie at all** — i.e. the bundle and HMR surfaces are genuinely outside the fence, and the un-revisioned bundle URL is genuinely `404`.

### 5.3 Bind address

- Default `127.0.0.1`; port fallback `3080`. `WebServer.Config` accepts only the literals `"127.0.0.1"` and `"0.0.0.0"`.
- `dsh --profile web --host 0.0.0.0` is **rejected at startup** (`dsh-web-app/lib/startup.js`):
  `error: --host 0.0.0.0 is intentionally not supported yet for safety: it would expose remote code execution to the network; use 127.0.0.1 instead`
  Exposing therefore requires editing the composition directly (the schema permits it) plus declaring authorities.

### 5.4 Authority a frontend port must not assume

- `dsh-authorization` is **not** browser auth. It is a credential-acquisition flow registry (OAuth / one-time code / API key) keyed by `<scope>/<id>` records committed through `ctx.credentials`; it gates nothing per-request and is unmounted by default.
- The browser-surfaced **approval** model is `dsh-user-approval` + `dsh-permission-presets` (`read-only` / `workspace-write` / `danger-full-access` → sandbox + approval) + `dsh-client-ui-approval`, delivered over the Agent-scoped Remote Event waterfall with **fail-closed** default.
- `dsh-host-webserver` owns no route and no auth: `register(route{kind:'exact'|'prefix',path,handler})`, `registerUpgrade({path,handler})`, `registerFallback(handler)`, `tapIndex(fn)`. Match order: exact table → longest prefix → fallback; unmatched upgrades are `destroy()`ed; duplicate path throws.

---

## 6. Explicit limitations / non-goals (quoted)

**Transport / protocol**
- `dsh-api-gateway`: *"Only strict generated contributions can mount on the Client face. SRC markers have no Client codec or type projection."* — *"`$stream()` supervises carrier replacement but does not infer replay semantics; each domain owns its resume cursor or replacement-baseline validation and normal-end classification."* — *"Forwarded events reach `$on` without business-payload projection or redaction. Ordinary notifications are not replayed after reconnect."* — *"`websocketHeartbeatIntervalMs` is both the Ping cadence and the Pong deadline… a deployment whose event loop or network can stall longer than this interval must raise it."*
- `dsh-api-remotes`: *"The capability set is fixed by explicit build-time value imports; the Client does not discover the Host's active Services or Remote definitions at runtime."* — *"Additional capabilities require an explicit `/remote` value import and mount in this assembly."*
- `dsh-client-connection`: *"Buffered `/api` routes retain each request body in memory"* (`maxRequestBodyBytes` default 300 MiB). — *"The browser cookie is not marked `Secure`."* — *"There is no logout operation — clearing the browser cookie ends one browser session; deleting the owner credential record and restarting `dsh` revokes every session."*
- `dsh-api-session-controller`: *"The image byte cap does not validate decoded dimensions or pixel count."* — *"Control baselines represent process-local state and therefore cannot reconstruct jobs after a Host restart."* — *"A failed follow resumption remains visible to the caller instead of retrying indefinitely."* — *"The raw browser upload is one streaming HTTP request without resumable offsets; a retry sends the file again from byte zero."* — *"File-reference completion uses the shared Agent lookup and can resume a cold Session; the `skills/list` catalog is the non-activating alternative for skill metadata."*
- `dsh-api-session-controller` media route: *"Neither directory containment nor MIME categories restrict access"*; *"Responses contain the complete file, ignore Range."*

**Boot / frontend**
- `dsh-web-app`: *"**The frontend must be built** — a source checkout needs `pnpm run build` first; startup stops with a build hint when the dist is missing, and there is no source-serving fallback."* — *"**Only the handoff start is observable**… a later browser exit is never reported."* — *"**Binding all network interfaces is not supported.**"*
- `dsh-host-webserver`: *"**No server-wide TLS, authentication, or origin policy** — route owners such as `dsh-client-connection` enforce their own request policy. Binding a non-loopback address still exposes unprotected routes and static assets to that network."*

**State / persistence**
- `dsh-session-persistence-jsonl` / `dsh-session-projection-cache`: the log is authoritative; checkpoints may be **stale but never ahead**; incompatible records are ignored or backed up.
- `dsh-session`: a reader meeting an unrecognized event type **without** `ignorable` **must refuse to reconstruct** the session rather than silently drop it.

**Non-goals implied by the shape of the API (no README states these as goals)**
- No server-push channel for the transcript other than `session/follow`; no REST-style session resource.
- No runtime introspection of the Remote surface (no `OPTIONS`/manifest endpoint; unclaimed `/api` → 404).
- No logout, no session revocation endpoint, no user accounts.
- No multi-window/multi-tab coordination protocol; per-tab client state, shared server state, authority-bound cookie.

---

## 7. Parity checklist for a different frontend

| # | Requirement | Exact artifact |
|---|---|---|
1 | Mint/obtain the cookie | `GET /?token=<launch token>` → `303` + `Set-Cookie: dsh-auth-<b64 sha256(authority)>=v1.…` (exactly one `token`, `GET /` only) |
2 | Unary envelope | `ClientRequest` / `ServerResponse` in `dsh-client-connection/lib/types/rpc.d.ts`; body payload is `{ args: {...} }` |
3 | Stream mux envelope | `RemoteStreamClientMessage` / `RemoteStreamServerMessage` in `dsh-api-gateway/lib/types/stream-protocol.d.ts` |
4 | Command surface | every `lib/typert.remote-client.d.ts` · `TypertRemoteMap` (16 `session/*` + `skills/list` + `fileReferences/list` + siblings) |
5 | Event vocabulary | `KNOWN_SESSION_EVENT_TYPES` (56) + per-event shapes in each owner's `lib/types/*.d.ts` |
6 | Envelope invariants | `SessionWireEvent` + `SessionEventLikeEntry` (`'event'` vs `'transient'`) |
7 | Transcript rebuild | `session/follow` snapshot → contiguous `replace`/`prepend`/`append`/`settle-assistant`; `loadOlder`=50, `loadThrough`=200 |
8 | Optimistic sends | `beginSubmission` → `requestId` → durable `user/message.source.rpcId` / `SessionQueuedItem.rpcId` |
9 | Answer path | `$events` waterfall (`approval/request`, `user-questions/request`) + `POST /api/$events/result` |
10 | Reconnect | generation on `$events` `ready`; 500 ms→10 s at 50–100 % jitter; fresh follow snapshot, **not** a cursor |
11 | Two carriers, one session | unary commands on `POST /api/…`; every stream (incl. the transcript) on the one `/api/remote.mux` socket |
12 | Live host events | `$events` allowlist (17 `emit` + 2 `waterfall`) — this, not the session stream, is how approval/question prompts arrive |
13 | Must **not** assume | there is no `session/resume`, no `session/compact`, no `settings` project/session scope, no `workspace/list`, **no `workspaceFiles` write operation** |

**Biggest single risk to parity:** item 4 is build-time only. There is no runtime capability manifest, so a foreign frontend must either vendor the generated `typert.remote-client.d.ts` maps or reconstruct them by reading `/api/remote.mux` behaviour. Nothing in the shipped code publishes them over the wire.

**Cheapest honest shortcut:** items 1–3 + 5–6 are the whole protocol; item 4 is the only place where a foreign frontend must mirror a build artifact rather than an endpoint. If the product only needs *one* transcript view, the required endpoint set collapses to
`session/create`, `session/prompt`, `session/cancel`, `session/updateQueue`, `session/list`, `session/follow` + `$events` for approval/questions — seven endpoints and one socket.
