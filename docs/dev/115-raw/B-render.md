# B — DSH browser UI: everything the conversation window renders

**Read-only research report.** Root: `/home/deploy/.nvm/versions/node/v24.15.0/lib/node_modules/@deepseek-ai/dsh/`; sub-packages in `<root>/node_modules/@deepseek-ai/`.
Every fact below cites the package + file it came from. Chinese product terms are kept verbatim with the English dictionary value alongside when it differs.

Source files referenced most:
- `dsh-client-ui-conversation/lib/client.js` (16 864 lines) + `lib/types/client/contract/*.d.ts`
- `dsh-client-ui-chat/lib/client.js` (8 369 lines) + `lib/types/client/chat/*.d.ts`
- `dsh-client-ui-tool/lib/client.js` (2 394 lines)
- `dsh-client-locale/lib/client.js` — the shared `common` namespace dictionary
- Each in-scope package's `README.md` / `README.zh.md`

---

# 0. How the window is assembled (the contract that everything else hangs off)

**Three registries own the transcript.** `dsh-client-ui-conversation` owns two and `dsh-client-ui-chat` owns one target:

| Registry | Owner | What registers into it |
|---|---|---|
| `ctx.uiConversation.events` | ui-conversation | event **Definitions** (`kind`, `target`, `match`/`start`/`update`) that turn Session events into view nodes |
| `ctx.uiConversation.views` | ui-conversation | target **snapshot builders** (`chat`, `trajectory`) |
| `ctx.slots` — `conversation.chat.node`, keyed | ui-conversation declares, ui-chat renders | the keyed React renderer per node `kind` |

Facts: `dsh-client-ui-conversation/README.zh.md` L28 ("`UiConversation.events` 是 event Definition 的唯一 registry，`UiConversation.views` 是 target snapshot builder 的唯一 registry…两者都拒绝重复 key、保持注册顺序、返回幂等 disposer"); `dsh-client-ui-chat/lib/client.js:3689-3774` (`registerChatNodeRenderers`).

**The `conversation.chat.node` keyed seat — the complete registered set** (`dsh-client-ui-chat/lib/client.js:3690-3773`):

`user`, `steering`, `context`, `system-prompt`, `assistant-step`, `command`, `manual-compaction`, `compaction`, `model-retry`, `turn-error`, `turn-max-tokens`, `turn-process`, `turn-tail`, `unknown`
— plus, registered by other packages: `tool-call` (`dsh-client-ui-tool/lib/client.js:2370`), `workflow-run` (`dsh-client-ui-workflow-run/lib/client.js:635`), `command-input` (`dsh-client-ui-goal/lib/client.js:529`).

**Registered `conversation.*` slots in the whole installed tree** (grep of `dsh-client-ui-*/lib`):

```
conversation.approval.detail          conversation.session
conversation.chat.commandview         conversation.session.header
conversation.chat.node                conversation.session.header.actions
conversation.chat.turnTail            conversation.session.header.corner
conversation.composer                 conversation.session.header.lineage
conversation.composer.bar             conversation.session.header.utilities
conversation.composer.dock            conversation.trajectory.images
conversation.hero.agentPreset         conversation.view
conversation.hero.brand.mark          conversation.input.attachments
conversation.hero.workspace           conversation.input.dock
conversation.hero.workspace.directoryFlow  conversation.input.left
conversation.message.images           conversation.input.model
conversation.input.overlay            conversation.input.plan
conversation.input.right
```
(`conversation.session`'s children per `dsh-client-ui-conversation/lib/client.js` — the `view` list holds the tabs.)

**The node data model** (`dsh-client-ui-conversation/lib/types/client/contract/records.d.ts`) — `ConversationNode` union at L249:

```ts
type ConversationNode =
  UserMessageNode | AssistantMessageNode | SteeringMessageNode | ContextMessageNode |
  ModelRetryNode | TurnErrorNode | TurnMaxTokensNode | ToolResultNode | CommandNode |
  CompactionSummaryNode | UnknownSurfaceNode;
```

- `AssistantBlock` (L26) is exactly five kinds: `text` | `reasoning` | `image` | `tool-call` (`{callId,name,argsRaw}`) | `other`.
- `ToolCallBlock = RunningToolCall | ToolResultNode`, with recursive `subCalls` (L173, L262) — **the Runtime, not the UI, owns call/result pairing and recursion** (`dsh-client-ui-tool/README.zh.md` L12).
- Assistant block ordering: "Assistant content blocks sorted by what a UI target presents" (L25).

**Two targets, one tab strip.** `resolveActiveView` + `role="tablist"` with one `role="tab"` per registered view (`dsh-client-ui-conversation/lib/client.js:15087-15098`). Registered views: `chat` labelled `对话`/`Chat` (`dsh-client-ui-chat/lib/client.js:8288-8293`, locale `view.chat`) and `trajectory` labelled `轨迹`/`Trajectory` (`dsh-client-ui-trajectory/lib/client.js:8224-8229`, locale `view.trajectory`). Selection rule (README.zh.md L43): "有效且已注册的持久化选择优先，其次是已注册的 `chat`，否则不渲染 View；绝不选择第一个已注册 View." Persisted preference is read **before paint** from `localStorage["dsh.conversation." + sessionId].view`; the constant is `DEFAULT_VIEW_ID = "chat"`.

## 0.1 `dsh-client-ui-renderer` is the slot renderer, NOT a block registry

This matters: the brief calls it "the renderer/block registry", and it is not. `grep -i block dsh-client-ui-renderer/lib/client.js` returns **nothing**, and its bundle has **zero CJK characters** — no labels, no icons, no block kinds. It owns exactly two things:

1. **Mount.** `apply(ctx)` installs `new SlotRegistry(ctx).install(createSlotRenderer())` and reflects `ctx.uiRenderer = { mount }`. `mountApp(container, app)` looks for `container.querySelector(":scope > [data-dsh-boot]")`: if present it `hydrateRoot`s through `BootHandoff`, a one-layout-frame pass-through that keeps the kernel's DOM (className + innerHTML) visible, then renders `app()`; otherwise it `createRoot`s and `flushSync`es. The returned disposer unmounts the React root. `buildRenderApp` is literally `() => ctx.slots.renderSlot("root", {})` (`lib/client.js:933-936, 1399-1442`).
2. **The `SlotRegistry`** — the composition primitive every other package in this report registers into (`lib/types/client/registry.d.ts`; implementation inlined into `dsh-web-frontend/dist/assets/index-*.js`):
   - **Four slot kinds**, each validated at register time:
     - `single` — one cell; a second registration **at the same priority throws**: `single slot "${name}" already has a registration at priority ${p} (registered by ${registrant}) — register at a different priority to shadow it (lowest renders)`.
     - `keyed` — requires `options.key`; the cell is the key; a duplicate `(key, priority)` throws.
     - `list` — requires `options.id`; the cell is the id; a duplicate `(id, priority)` throws.
     - `chain` — requires `options.select`; every entry participates.
   - **Ordering**: on insert, `list` sorts by `(priority ?? 0) || (order ?? 0)`; **all other kinds sort by `priority` alone** (stable, so equal priority keeps registration order). `entriesOfSlot` walks in sorted order, **skips abdicated entries**, and takes the `first live entry per cell`.
   - **Outlet semantics**: `single` = first live entry, else `opts.fallback ?? null`, and if entries exist but all are dead → `<div data-slot-error=key>`; `keyed` = the winner whose `options.key === opts.entryKey` with the same fallback/dead-cell rule; `chain` = call each `entry.select(ownerProps)` in priority order, **a selector throw is treated as declined** and logged (`chain selector crashed in '${slotKey}' (${registrant}), treating as declined:`), first non-null wins and receives `{...ownerProps, matched}`; `list` re-sorts by `order ?? 0` at render and additionally emits a `<div data-slot-error>` placeholder row for a declared-but-unregistered id.
   - **Error isolation**: each entry renders inside a `SlotErrorBoundary`. `SlotAssemblyError` (missing provider / boot order) is **rethrown** — "a miswired shell must fail loud" — while any other throw renders `<div data-slot-error=slotKey>`, calls `onEntryError`, and for non-chain kinds **abdicates** the entry so the outlet re-renders onto the next survivor. The React key is per-entry identity, so a winner change remounts the boundary.
   - **Ownership**: an entry may only `renderSlot` a child it declared itself, else `SlotOwnershipError: slot '${key}' is not declared by this entry's children`; calling after disposal throws `StaleAuthorizationError`.
   - `root` is a **`single` slot** seeded by the core, and the context-level `renderSlot` refuses any other key (`ctx-level renderSlot only renders 'root' (got "${key}")`). Registering into `root` from a second entry shadows the frame; the documented way to float a surface is `shell.overlay`.
   - `ctx.slots.inject(key, callback)` runs the callback synchronously when the slot is already declared, otherwise after the declaring `register()` commits, and re-runs it when the declaration changes.
   - The invariant companion asserts that every `'slots/changed'` dispatch happens **after** the slot version was bumped.

The real "block registry" is §0 above: the `ConversationNode` union + the keyed `conversation.chat.node` slot + the `AssistantBlock` switch inside ui-chat.

**The keyed dispatch, verbatim** (`dsh-client-ui-chat/lib/client.js:1613-1622`):
```js
renderSlot("conversation.chat.node", routedOwner, {
  entryKey: routedNode.kind,
  hookContext: turnData,
  fallback: <JsonBlock label={t("message.unknownSurface", {type})} />
})
```
So an unknown node kind renders the JSON fallback, and a slot entry that throws renders `<div data-slot-error>`.

---

# 1. Complete inventory of what a DSH transcript can show

## 1.1 The chat (transcript) node kinds

All row shapes below are `dsh-client-ui-chat` unless marked otherwise. Locale namespace is `chat`.

### `user` — human message
Right-aligned bubble (`UserStyleBubble`, `lib/client.js:1349`). Carries optional `referenceLabels` (session references) and `skillNames`. Actions = `MessageIconActions` with `clock: "start"` (`:1355-1361`). Interrupted/frozen user text is not a node kind; only assistant prefixes freeze.

### `steering` — interjection admitted mid-turn
Rendered by the **same** `UserMessageNodeView` (`dsh-client-ui-chat/lib/client.js:3695-3699`). Data type `SteeringMessageNode` carries `messageId` "shared with its pre-admission inbox occurrence" (`records.d.ts:88-93`). Pending (not yet durable) steering appears separately as `PendingSteeringBubble` in the live composer band, not as a node (`dsh-client-ui-chat/lib/client.js:2551`).

### `assistant-step` — model output for one step
`AssistantMarkdown` (`dsh-client-ui-chat/lib/client.js:3046`), block-by-block (**:3046-3095**):
- `text` → `MarkdownText` with `streaming`, `fileMentions`, `pathImages` (local absolute POSIX paths are rewritten to a same-origin workspace-file URL — `AssistantMarkdown.d.ts:localPathMediaUrl`).
- `reasoning` → `ReasoningRow` (`dsh-client-ui-chat/lib/client.js` reasoning CSS `lcKema_root`): a disclosure at `data-variant="think"`, `data-state = running|ok`, leading `IconThinkOutline14` size 14, title `message.think` = `思考` / `Think`, then a 2×2 separator dot and the summary. **Collapsed by default with a pinned 24 px collapsed height.** Collapsed summary = first line when settled, **last** line while running, with all `**` stripped; expanded body is the complete text with `white-space:pre-wrap`. Running adds the 300 px gradient sweep (2.6 s) plus a visually hidden `row.running`.
- `image` → consecutive image blocks are grouped and sent to `renderMessageImages({images, align:"start"})`.
- `tool-call` → **rendered to nothing here**; the `tool-call` node renders it (switch `case "tool-call": break;`).
- `other` → `JsonBlock` labelled `message.unknownBlock` (`未知内容块` / `Unknown content block`) with `json.truncated` = `… 已截断，共 {total} 字符` / `… truncated, {total} characters total`.
- Whole-block guard: returns `null` if there are no non-tool-call blocks and it is not streaming/interrupted.
- Interrupted turns append a `message.stopped` marker: `已停止` / `Stopped` (`:3092`).
- Streaming attribute: `data-streaming` on the root (`:3086`).

### `system-prompt` — the model-visible system prompt
`SystemPromptRow` (`dsh-client-ui-chat/lib/client.js:3246-3275`): a **collapsed disclosure by default**, icon `IconBrowseOutline16` size 14, title `message.systemPrompt` `系统提示词` / `System prompt`, or `message.systemPromptUpdate` `系统提示词更新` / `System prompt update` for an in-history update. Expanded body = `OpaqueBody` with the exact model-visible text and real line breaks inside a 141 px scrollport (`.XrJvXW_body` CSS `max-height:141px`, `lib/client.js:820`).

Visibility rules (README.zh.md L31, verbatim content): a row exists for **each nonempty appended `system/message`** including a complete prompt at the head of a headerless window; same-step header does not duplicate it. Also for a non-empty initial request / explicit message-series start / a `system/message` surface replacement whose text differs (reads the **last nonempty surviving system node in surface order** at the `request/header`), and for a non-initial request whose preceding header is outside the loaded window. Resume repeats the row even when system text is unchanged; config-only or tool-only changes, tool steps and retries never repeat it; a `system/message` event is **never** rendered as a conversation message. Empty or out-of-window system nodes create no row until paging arrives.

### `context` — injected context
`ContextInjectionRow` (`dsh-client-ui-chat/lib/client.js:850-895`): collapsed disclosure, icon `IconContextInjectionOutline16` size 14 (or `ReferenceIcon kind="session"` with `data-context-recall-icon` for recall). Title is `message.contextInjection` `上下文注入` / `Context injection` or `message.contextRecall` `跨会话召回` / `Session recall` when `provenance.role === "recall"`.
Six declared forms (`contextBody`, `:772-815`; `KnownContextForm` = `instructions|catalog|snapshot|notice|relay|recall`):
| form | body shows | collapsed row |
|---|---|---|
| `instructions` | the files this context reconciled, then their text, `<system-reminder>` framing kept verbatim | source label only |
| `catalog` | published entries as a list read from `source`, not re-parsed from prose | source label only |
| `snapshot` | the named contributions in order; the "supersedes earlier snapshots" sentence becomes a caption, not reprinted | source label only |
| `notice` | what just happened, with the model-facing text beneath | a **one-line summary** rides the collapsed row |
| `relay` | sender (opaque session id shown as a field) then what it said | source label |
| `recall` | which sessions, and **how much survived**: `保留 {retained} 条 · 省略 {omitted} 条` / `{retained} kept · {omitted} omitted`, plus `已截断` / `truncated` | source label |
`null` / unreadable form → `OpaqueBody` (model-facing text as text). Rendered form is what the row is labelled with, not the declared one (`ContextBody.d.ts`).
Literals: `message.context.instructions.loaded/added/updated/removed` = `已载入/已新增/已更新/已移除`; `message.context.catalog.replaced` = `替换目录` / `Replacement catalog`; `message.context.catalog.more` = `…还有 {count} 条` / `… {count} more`; `message.context.snapshot.supersedes` = `取代先前的快照`; `message.context.relay.from` = `来自会话 {session}` / `From session {session}`.

### `model-retry`
`ModelRetryItem` (`dsh-client-ui-chat/lib/client.js:1383-1390`). Node is `LlmRetryEventData & {retryState}` with client-derived lifecycle `scheduled | started | cancelled` (`records.d.ts:111-125`). Copy: `message.retry.active` `正在重试模型请求`; `message.retry.cancelled` `模型请求重试已取消`; `message.retry.started` `已重试模型请求`; `message.retry.scheduled` `等待重试模型请求`; `message.retry.status` = `{label}（{retry}/{maximum}） · {seconds}s`; `message.retry.delay` `重试延迟：`; `message.retry.failure` `失败原因：`.

### `turn-error`
`TurnErrorItem` (`:1392-1397`). Title `message.turnError` `本轮运行失败` / `This turn failed`. Known code has localized copy — `message.failure.auth` `API 密钥无效` / `API key is invalid` — otherwise the sanitized provider message (empty string when a known code owns the copy). Node fields: `code`, `message` (`records.d.ts:127-138`).

### `turn-max-tokens`
`TurnMaxTokensItem` (`:1399-1401`). `message.maxTokens` `已达到输出 token 上限` / `Output token limit reached` plus hint `message.maxTokens.hint` = `回答被截断，已有输出保留在对话中。发送“继续”可让模型接着输出。` / `The reply was cut off; earlier output is preserved in the conversation. Send "continue" to let the model resume.` Position: between the closing assistant and the turn tail so the tail stays the turn's last node (`CHAT_SYNTHETIC_SEQ_OFFSETS.maxTokensNotice = .05`, `:1505`).

### `compaction` (automatic) and `manual-compaction`
- `CompactionItem` (`:1376-1381`) driven by `CompactionSummaryNode`: `summary`, `summaryEventSeq`, `shadowedItemCount`, `shadowedTokenCount` (all nullable) (`records.d.ts:183-197`).
- Copy: `message.compaction` `上下文已压缩` / `Context compacted`; `message.compaction.running` `正在压缩…` / `Compacting context…`; `message.compaction.completed` `已压缩 {items} 条历史记录（约 {tokens} tokens）` / `Compacted {items} history items (~{tokens} tokens)`; `message.compaction.expand` `点击查看压缩摘要` / `View compaction summary`; `message.compaction.unavailable` `压缩摘要不可用` / `Compaction summary unavailable`; `message.compaction.commandTitle` = `compact`.
- The README is explicit that the shadowed conversation **stays visible above the marker**: "The framed checkpoint payload is an instruction envelope written for the model and never renders" (`records.d.ts:186-192` doc comment).

### `command`
`CommandNodeView` (`:3187-3200`) dispatches through the keyed child slot `conversation.chat.commandview`; fallback is `GenericCommandCard` (`:3110-3160`):
- leading: `IconApiOutline14` when ok/running, `StateDot state="error"` when error;
- title = command name, or `command.title` `指令` / `Command`;
- summary = outcome text, else `command.running` `执行中…` / `Running…`, `command.failed` `指令失败` / `Command failed`, `command.done` `已完成` / `Completed`;
- body only when the text contains a newline; rendered in a `<pre>` with `max-height:260px`;
- running state gets the shared shimmer sweep (300 px gradient, `animation:2.6s ease-out infinite`, disabled under `prefers-reduced-motion`).

### `turn-process` — the compact-mode folding control
`TurnProcessNodeView` (`:3277-3304`). **Not a data row — a synthetic control.** Shape: full-width `<button>` (`height:33px`, bottom `0.5px` border, padding `0 0 8px`, margin-bottom 8px when closed), label 14 px/24 px, chevron `IconChevronDownOutline14` rotated `-90deg` closed → `0deg` open. Data attributes for tests: `data-turn-process`, `data-turn-process-messages`, `data-turn-process-tool-calls`, `data-turn-process-subagents`, `aria-expanded`.
Label = `" · "`-joined non-zero counts, in this order (**:3281-3285**):
- `message.turnProcess.toolCalls.one/other` = `{count} 次工具调用` / `{count} tool call(s)`
- `message.turnProcess.messages.one/other` = `{count} 条消息` / `{count} message(s)`
- `message.turnProcess.subagents.one/other` = `{count} 个 subagent` / `{count} subagent(s)`
All three zero → `message.turnProcess.thoughtForAWhile` = `已思考` / `Thought for a while`.

### `turn-tail` — the completed-turn footer
`TurnTailNodeView` (`:3637-3682`). Children slots: `conversation.chat.turnTail` (**chain**) and `conversation.chat.assistant-actions` (**list**).
Renders: the turn-tail slot chain, then `MessageIconActions` with `clock: "end"`, `text = assistantText(closing.blocks)`, `onBranch = () => forkAt(closing.finalNode.seq)`, `branchUnavailable = data.branchUnavailable || hasLaterChatNode`, `extraActions` = the assistant-actions slot (feedback lives here), `usageAction` = `TurnUsagePanel` + `TurnTimePanel`.
- `data-turn-tail={turn}`, `data-actions-reveal = isLatestTurn ? "always" : "hover"` — i.e. **actions are always visible on the latest turn and only on hover for older turns** (`:3659`).
- `data-chat-anchor-key="call:<id>"` and `data-chat-call-id` DOM contract used for paging and selection (`dsh-client-ui-tool/README.zh.md` L60).
- Completed-turn footer sits **20 px** below preceding prose/extension content (`dsh-client-ui-chat/README.md` L41).

### `unknown`
`UnknownNodeView` (`:1403-1412`) → `JsonBlock` labelled `message.unknownSurface` = `未知 surface 事件：{type}` / `Unknown surface event: {type}` with the raw payload and `json.truncated`.

### `tool-call` (owned by `dsh-client-ui-tool`)
See §1.2.

### `workflow-run` (owned by `dsh-client-ui-workflow-run`)
See §1.6.

### `command-input` (owned by `dsh-client-ui-goal`)
Right-aligned user-style bubble labelled `commandInput.aria` `指令输入` / `Command input`; the leading `/goal` token is a mono code chip, the objective stays body text. **No timestamp, no copy, no branch.** Rebuilt from the run log on reload. It never creates a `user/message` or a model turn.

### Live (non-durable) transcript-adjacent rows
`dsh-client-ui-chat/lib/client.js:2551-2560`: `PendingSteeringBubble` per pending-steering item, and `PendingSubmissionBubble` per visible local submission (the optimistic echo). `dsh-client-ui-chat/README.md` L11: "Local transcript and steering submissions appear immediately, remain in their original surface, and disappear atomically when authoritative Session records arrive, while queued submissions stay outside Chat."

### Loading / error / navigation chrome
- `chat.loadingHistory` `载入历史…` / `Loading history…` while `openState === "loading"`.
- `chat.loadError` `历史加载失败：{message}（{code}）` / `Failed to load history: {message} ({code})` while `openState === "error"`.
- `hasMore` → a `chat.loadOlder` button `加载更早` / `Load earlier`, disabled while loading, label `loading` (`加载中…`) while in flight.
- `!atBottom` → floating `回到底部` / `Back to bottom` button with `IconChevronDownOutline14` (`:2581-2596`).
- Running turn indicator: `TurnStatus` with `chat.deepDiving` `深度求索中...` / `Deep diving...`.
- Turn rail (right edge, 28 px frame, hidden under 900 px container width, CSS `:1626`): marks 10 px apart, 20 px max width; `markUnloaded` opacity .6 width 8, `markPreview` width 18, `markBusy` animated, `markActive` width 20. Preview card `100px` max height, width `min(300px, 100cqw - 120px)`, prompt clamp 1 line, response clamp 3 lines. Labels: `chat.turnNavigation.label` `轮次导航`, `.jump` `跳转到第 {turn} 轮`, `.jumpLoad` `加载并跳转到第 {turn} 轮`, `.turn` `第 {turn} 轮`.

## 1.2 Tool-call rows (`dsh-client-ui-tool`)

**Tree, not a second panel.** `ToolCallTree` walks one root `ToolCallBlock` with its recursive `subCalls` and dispatches **root and every descendant through the same keyed `tool.call.toolview` slot** (`dsh-client-ui-tool/README.zh.md` L60). "Every card is read in place in the call tree; there is no second, full-height presentation of a selected call" (README.md L65).

**Dispatch table** — `TOOL_VARIANTS` (`dsh-client-ui-tool/lib/client.js:814-831`):

| wire tool name | variant | generic row title |
|---|---|---|
| `bash` | `bash` | `tool.title.bash` `Bash` |
| `pwsh` | `bash` | `tool.title.pwsh` `Pwsh` (via `TOOL_TITLE_KEYS`) |
| `read`, `read_image`, `web_fetch`, `cordis_package_inspect`, `cordis_runtime_inspect` | `read` | `tool.title.read` `读取`/`Read`, `tool.title.readImage` `读取图片`/`Read image`, `tool.title.inspect` `查看`/`Inspect` |
| `web_search`, `grep`, `glob` | `search` | `tool.title.search` `搜索`/`Search`, `tool.title.grep` `Grep`, `tool.title.glob` `Glob`, `tool.title.webSearch` `网页搜索`/`Search` |
| `write` | `write` | `tool.title.write` `写入`/`Write` |
| `edit` | `edit` | `tool.title.edit` `编辑`/`Edit` |
| `run_code` | `code` | `tool.title.code` `代码`/`Code` |
| `cordis_run` / `cordis_stop` / `cordis_undefine` | `others` (+ title key) | `运行 Cordis 插件` / `停止 Cordis 插件` / `移除 Cordis 插件` |
| anything else | `others` | `tool.title.generic` `工具调用` / `Tool call` |
(`dsh-client-ui-tool/lib/client.js:796-841`.)

**Registering a business tool view** (README.zh.md L34-40):
```ts
ctx.slots.inject('tool.call.toolview', () =>
  ctx.slots.register({ name: 'tool.call.toolview', key: '<wire tool name>' }, BusinessToolRow))
```
Owner payload `ToolCallOwnerProps` = `callId`, `toolName`, frozen `block`, optional `cwd`/`home`, session-authorized `loadImage`, and `openFile` / `inspect` callbacks. Path summaries relativize to Session cwd first, then replace a leftover POSIX host home with `~`; `filePath` and the host open keep the authored path.

**Keyed `tool.call.toolview` entries that actually exist in this build**:
`bash`? no — `bash` is generic-terminal. Registered keys: `ask_user_question`, `bash`, `edit`, `write`, `read`, `read_image`, `grep`, `glob`, `todo_write`, `web_search`, `web_fetch` (all `dsh-client-ui-tool`); `present` (`dsh-client-ui-deliverables:952`); `skill` (`dsh-client-ui-skill:233`); `cordis_define`, `cordis_run`, `cordis_stop`, `cordis_undefine` (`dsh-client-ui-cordis:1376-1411`).

**Generic row model** (`toolRowModel`, `dsh-client-ui-tool/lib/client.js:951-972`):
- `state` = not settled → `running`; `error.code === "interrupted"` → `stopped`; `isError` → `error`; else `ok`.
- summary = first line of the variant's preferred arg key (`SUMMARY_KEYS`, `:882-898`): bash `["description","command"]`; read `["path","file_path","url"]`; search `["query","pattern","url"]` (a `queries` array joins with `, `); write/edit `["path","file_path"]`; code `["description"]`; fallback to the first non-empty string arg, then to the first line of raw args, and finally to the `callId` when args are empty.
- unknown tool name → summary becomes `` `${toolName} · ${base}` `` (`:958`).
- `formatToolBody` (`:933-942`) pretty-prints `JSON.stringify(parsed, null, 2)`; `run_code` shows `parsed.code` verbatim.
- `resultText` (`:857-863`): text blocks verbatim, other block shapes pretty-JSON, joined by `\n`; empty content on a failed call falls back to `` `${error.name}: ${error.code}` ``.
- `errorSummary` = first line of the result text when state is error.

**Per-family card behaviour** (README.zh.md L46, plus the models):
- **shell / terminal** (`terminalCardModel`, `:684-724`): running and settled *foreground* standard `bash`/`pwsh` and `terminal_send` use the terminal card at root and inside Code Dispatch. Returns `null` (generic path) when the call is `background`, when `isError`, when a shell call is `persistent`, when it is a spilled result, or when output is missing. Standard shell results parse a trailing `\n[exit code: N]` or `\n[killed by signal: X]` marker (`parseExitStatus`, `:663-682`); no marker ⇒ exitCode 0. A displaced or omitted exit marker cannot establish success.
- **read**: line window, `read.window` `显示 {shown} / {total} 行` / `Showing {shown} of {total} lines`, collapse aria `read.collapseAria` `收起内容`, expand `read.expandRest` `… 其余 {count} 行` / `… {count} more lines`.
- **diff** (write/edit): `diff.files.one/other` `{count} 个文件`, `diff.collapseAria` `收起差异`, `diff.expandRest` `… 其余 {count} 行`.
- **search** (grep/glob/web_search): `search.paths` `{shown} 个路径`, `search.paths.truncated` `显示 {shown} / 共 {total} 个路径`, `search.matches` `{shown} 处匹配 · {files} 个文件`, `search.matches.truncated`, `search.noResults` `无结果`; card model requires `meta.truncated: boolean` and a valid `sources[]` (`webCardModel`, `:768-792`) or falls back to generic.
- **web fetch**: `web.http` `HTTP`, `web.noResults` `未找到结果`, `web.sourcesTruncated` `来源列表已截断`, `web.contentTruncated` `内容已截断`.
- **image** (`read_image`): gallery renders through the tool-owned `tool.call.images` slot.
- **ask_user_question**: card `max-height:360px`, padding `16px 20px`, radius 12; question text in `--dsw-alias-label-tertiary`, answer in `--dsw-alias-label-primary`, both `white-space:pre-wrap`. Successful rows pair call questions with result answers **by stable id**; cancelled/interrupted rows show the verdict and the original questions and **never invent answers** (README.md L46). Locale for the row: `ask.rowTitle` `提问`/`Ask question`, `ask.waiting` `等待回答`/`waiting`, `ask.cancelled` `已取消`/`cancelled`, `ask.cancelledDetail` `本轮已取消，未提交回答`, `ask.interrupted` `已中断`/`interrupted`, `ask.interruptedDetail`, `ask.answered` `{answered}/{total} 已回答`/`{answered}/{total} answered`, `ask.skipped` `未回答`/`Not answered` (`dsh-client-ui-conversation/lib/client.js:13724-13731`).
- **todo_write**: `todo.rowTitle` `更新任务清单` / `Update to-do list`, `todo.completed` `{done}/{total} 已完成` / `{done}/{total} completed` (`dsh-client-ui-tool/lib/client.js:2267`).
- **fallback**: "Unsupported, malformed, or ambiguous inputs fall back to flattened Tool input/result text."
- **Structured cards validate hard and bail to generic.** Every structured model returns `null` (→ generic row) on anything it cannot prove (`dsh-client-ui-tool/lib/client.js:125-410`):
  - `read` card requires a root (non-descendant) settled non-error call with a non-empty `file_path`, optional positive-integer `offset`/`limit`, **persisted `meta`** `{path, offset ≥ 1, lines[{number, text}] strictly increasing, totalLines, lang?}` **and** a result body matching exactly `/^<path>[^\n]*<\/path>\n<type>file<\/type>\n<content>\n([\s\S]*)\n<\/content>$/u`.
  - `diff` card requires `write`/`edit` (a `str_replace_editor` **settled** call returns `null`) and either a derivable intended diff or validated applied `meta.diffs`; for `write` an empty applied set still falls back to the intended diff.
  - `search` card requires `grep`/`glob` (empty `grep` pattern or blank `glob` pattern → generic; `glob` uses `pattern`, `grep` uses `pattern` + optional `include` without a leading `!` and balanced braces), `meta.truncated: boolean`, integer `meta.total ≥ 0`, and either `meta.shape === "matches"` with validated `meta.files` or `meta.shape === "paths"` with a string array. Truncation also carries a `recovery` = flattened result content.
  - `web` card requires a root settled non-error `web_search` (non-empty `queries` strings) or `web_fetch` (non-empty `url`), `meta.truncated: boolean`, validated `sources[]` (`url` required; `title`/`snippet`/`publishedAt` optional strings) and, for fetch, an integer `meta.statusCode`.
  - **Host `presentCall` / `presentResult` values never enter the client** — the cards derive only from first-party raw event fields (`dsh-client-ui-tool/README.md` L46).
- **state chrome**: running rows get the shared shimmer sweep `.o3BgMG_root[data-state=running] … dsh-tool-row-sweep` (300 px, 2.6 s, infinite; `dsh-client-ui-tool/lib/client.js:1144`).
- **`Inspect`** opens the trajectory view; a file-path summary opens through `openFile`, routed by the chat view to the right Sidebar's text preview (README.md L65).
- **copy**: generic tool rows reuse the `ui-conversation` `conversation` locale namespace for titles/chrome; `copy`/`copied` come from the `common` namespace (`复制`/`复制成功`, `Copy`/`Copied`).

**`present` tool row** (`dsh-client-ui-deliverables:210-241`): title `交付文件`/`Present files`; states `正在交付`/`Delivering`, `已交付`/`Delivered`, `交付失败`/`Delivery failed`, `已中断`/`Interrupted`; collapsed content = status word + comma-joined `args.files[].path`; expandable to a `<pre>` of the joined result content plus an `查看调用`/`Inspect call` button.

**`skill` tool row** (`dsh-client-ui-skill:138-209`): height 24 px, icon `IconSkillOutline16` (error → `StateDot error`, stopped → `StateDot warning`), title `Skill` (same in zh and en), summary = error first line, else the requested skill name. Running shimmers. Expanded = an `Instructions` card (`说明` / `Instructions`), `max-height:260px`, header strip uppercase 11 px, `<pre>` with the exact durable tool output, plus a hover-revealed `查看`/`Inspect` pill. Visually hidden state words: `正在加载 skill` / `skill 加载失败` / `skill 加载已中止` (Loading skill / Skill load failed / Skill load stopped).

## 1.3 Composer-dock cards and header surfaces

These are **not** transcript rows — they sit above/around the composer or in the session header.

| Surface | Slot | order | Default | Notes |
|---|---|---|---|---|
| **Todo panel** `任务`/`To-dos` | `conversation.input.dock`, id `todo` | 0 | **collapsed** | header button with `IconChecklistOutline14`, per-status counts, chevron; `max-height:180px` list; glyphs 14×14 in a 16 px cell: completed = ring+check (success colour), in_progress = gradient ring + `animation:1s linear infinite` spin (business colour), pending = dashed ring `stroke-dasharray:2.4 2.4` |
| **Goal bar** | `conversation.input.dock`, id `goal` | 10 | shown when a non-complete goal exists | one 36 px row, `IconGoalOutline16`, phase label, ellipsised objective, 28 px round icon actions; edit swaps the row for an inline input + Save/Cancel; Enter commits, Escape cancels |
| **Jobs** | `conversation.session.header.actions`, id `job-list` | 20 | closed; absent with zero jobs | badge counts running+stopping; row shows kind chip, label, status, ticking duration |
| **Subagents** | `conversation.session.header.lineage` | — | closed | trigger + `/`-separated count; catalog tree, rows 50 px |
| **Schedule** | `conversation.session.header.actions`, id `schedule-catalog` | 10 | closed; **disabled in the shipped Web graph** unless the Schedule overlay patch is applied | read-only reminder list |
| **Open In…** | `conversation.session.header.utilities` | — | absent when no workspace dir or no named app | split button, remembered app persists in `dsh.open-in-app.choice` |
| **Plan-mode chip** | `conversation.input.plan` | — | seat empty when plan mode is off | warn-coloured `Plan ×` pill that runs `/plan off` |
| **Model picker** | `conversation.input.model` | — | — | composer seat + `/model` popup |
| **Permission preset** | General-settings row + `/permission` popup | — | — | — |
| **Cordis panel** | `sidebar.footer.action`, id `cordis-panel` | — | closed; auto-opens on a new approval request | frame-wide, not session-scoped |

**Todo panel detail** (`dsh-client-ui-conversation/lib/client.js:16379-16460`): `progressLabel` = `done` / `active` / `pending = todos.length - done - active`, **zero segments omitted**, joined with `" · "`. Copy `todo.progress.done` `{done} 已完成`, `.active` `{active} 进行中`, `.pending` `{pending} 待处理`; `aria-label` = `todo.title`; `data-testid="todo-panel"`.

**Goal bar detail** (`dsh-client-ui-goal`): phases `进行中的目标`/`Ongoing Goal`, `未运行的目标`/`Inactive Goal` (active but disarmed), `已暂停的目标`/`Paused Goal`, `受阻的目标`/`Blocked Goal` (bar `title` = blocked reason). Actions `保存目标`/`Save goal`, `取消编辑`/`Cancel edit`, `暂停目标`/`Pause goal` (only when active **and** armed), `恢复目标`/`Resume goal` (paused, or active-but-disarmed), `编辑目标`/`Edit goal`, `清除目标`/`Clear goal`. **No round/continuation counter is rendered client-side** — `Rounds: {n}/{max}` only appears in the `/goal` **command result text** produced by `dsh-command-goal/lib/index.js:70`.

**Jobs detail** (`dsh-client-ui-jobs`): live = `running` + `stopping`; status verbs `运行中`/running, `正在停止`/stopping, `已完成`/completed, `已取消`/cancelled, `已失败`/failed. Dots: running→ongoing, stopping→warning, completed→done, killed→warning, failed→error. Ordering: live first by ascending `startedAt`, then settled by descending `finishedAt` (missing treated as 0). Duration vocabulary hours is the widest (`{hours}小时{minutes}分`). Tooltips `已运行 {duration}` / `耗时 {duration}`. **The job id is never rendered** (React key only), and the package is read-only — no kill, no output view, no streaming (README.md L76).

**Subagent catalog detail** (`dsh-client-ui-subagent`): row `label = entry.label ?? entry.id`; secondary line = `[title, mode, activity].join(" · ")` with mode `一次性`/`one-shot` or `可继续`/`continuable` and activity `正在运行`/`running` or `当前未运行`/`not running`; trailing metrics = summed **four disjoint token buckets** (`uncachedInputTokens + outputTokens + cacheReadTokens + cacheWriteTokens`) formatted `{value} tok`, and the active duration. Counts come from walking `origin === "subagent"` summaries up the chain, stopping at ordinary forks. **No transcript row, no nested indentation, and no child-report display exist in this package** (README.zh.md L105).

## 1.4 Approvals, questions, feedback

**Approval** (`dsh-client-ui-approval`, README is only 47 lines; `lib/client.js` read for the rest):
- Takes over the whole `conversation.composer` slot.
- Shape: `div[data-approval-key]` → card with a **strip** (a dot + `等待审批` / `Waiting for approval`), a scrollable `role="group"` body labelled `detail.aria` `审批详情` / `Approval details` whose headline is `pending.reason` or `工具 {toolName} 请求越权执行` / `Tool {toolName} requests privileged execution`, an optional tool-owned detail slot `conversation.approval.detail` keyed by `callId`, and an action row.
- **Exactly two buttons**: `拒绝` / `Reject` (outline, answers `"rejected"`) and `允许一次` / `Allow once` (primary, answers `"allowed-once"`). Both disable while `answered`.
- Render identity `key = "approval:<n>"` (a monotonically increasing counter) — this is the one-shot remount axis. `kind = "approval"` so Session pending-interaction consumers can see it.
- Known limitation, verbatim-ish (README.md L34): "The panel exposes transient decisions only — it supports allow-once and reject; persistent permission policy remains owned by Host-side approval packages." **There is no "allow always" button.** In this session approval prompts are disabled, so the decision never reaches the UI at all.

**User questions** (`dsh-client-ui-user-questions`): the composer is replaced by an interactive question surface.
- Single-select answers advance immediately; Enter continues, Shift+Enter newlines; during IME composition Enter only confirms the candidate (`README.zh.md` L28).
- Multi-select drafts keep selected labels while a custom answer is edited, so a submission can carry both `selected` and `custom`; single-select custom stays mutually exclusive.
- Question detail reuses `MarkdownText` (GFM, untrusted policy); the card is height-limited with header/nav/submit pinned and a shared inner scroll region.
- `跳过本题` / `Skip this question` emits the existing empty `{ selected: [] }`; dismissing rejects the whole wait with `ASK_CANCELLED`.
- Copy: `error.incomplete` `请先完成这道问题。`, `error.unanswered` `请选择一个选项或填写自定义答案。`, `nav.prev` `上一题`, `nav.next` `下一题`, `nav.minimize` `收起问题卡片`, `nav.maximize` `展开问题卡片`, `nav.cancel` `放弃整组问题`, `option.recommended` `推荐` / `Recommended`, `custom.placeholder` `输入你的答案` / `Type your answer`, `action.skip` `跳过本题` / `Skip this question`, `action.next` `下一题` / `Next`.
- **plan-review card** (intent set by `dsh-plan-mode` on `exit_plan_mode`): a `计划待审` / `Plan review` strip, the plan as scrollable markdown, and a decision row `去聊天里说` / `Chat about it`, `拒绝` / `Refuse`, `确认执行` / `Approve`. Approve/Refuse answer with the asker's own option labels; `Chat about it` rejects with `ASK_CANCELLED` so the editor comes back.
- Election rule: the specialized card only takes over when it can emit **every** answer the request allows — exactly one question, intent declared, plan present as `detail`, the named approval labels supplied, and binary single-select.
- Known limits: drafts live only for the current page + Session (never written to host, `localStorage`, or disk); **only one request owns the editor at a time**.

**Message feedback** (`dsh-client-ui-message-feedback`):
- Contributes to `conversation.chat.assistant-actions` with `order: 10` → Like/Dislike pair in the finalized assistant message's action row, **between copy and branch** (`README.zh.md` L28).
- Both thumbs **open the dialog** (seven categories + an optional detail box, all optional); submitting records the rating with the chosen content and fires a thank-you toast. Clicking an already-recorded rating **retracts it directly, with no dialog**.
- Recorded ratings show a **filled icon that is visible without hover** (`:28`).
- Categories: `任务结果` / Task result, `指令理解与遵循` / Instruction understanding and following, `产品功能与交互` / Product features and interaction, `稳定性和速度` / Stability and speed, `资源使用与费用` / Resource usage and cost, `安全隐私与权限` / Security, privacy, and permissions, `其他` / Other.
- `/feedback` with no text (menu pick **or** typed-and-sent) opens the same dialog for the Session; `/feedback <text>` still goes to the host command and shows a confirmation row.
- `note-too-large` is a **host** policy: `maxNoteBytes` is 8192 in the Web bundle; the dialog does not pre-validate, so an over-long message note fails at submit. Session-level notes have no cap.
- Conflict: `version-conflict` responses carry the authoritative entry and reconcile the view without re-fetching (`error.conflict` `这条反馈已在别处改动，已显示最新状态`).
- Limits: **no cross-tab push**; **trajectory and waterfall views do not render feedback controls** even though their assistant nodes carry the same `messageId`.

## 1.5 Trajectory view (`dsh-client-ui-trajectory`) — the second tab

A per-turn event log table plus an interactive time overview. It is a *pure projection* of the same Session window (its own Definitions; it never reads or mutates the Chat snapshot — README.zh.md L46).

- Table columns: `column.input` `输入`/`Input`, `column.output` `输出`/`Output`, `column.think` `思考`/`Think`, `column.time` `时间`/`Time`, `column.model` `模型`/`Model`, `column.tools` `工具`/`Tools`.
- Row kinds (`kind.*`): `system` `系统`/**SYSTEM**, `user` `用户`/**USER**, `context` `上下文`/**CONTEXT**, `compacted` `已压缩`/**COMPACTED**, `message` `消息`, `assistant` `助手`/**ASSISTANT**, `tool` `工具`/**TOOL**, `subtool` `子工具`/**SUBTOOL**, `sub` `子项`/Sub.
- Groups: `turn.label` `第 {turn} 轮` / `Turn {turn}`, `group.message` `消息`, `group.step` `步骤 {step}` / `Step {step}`, `group.compaction` `压缩 {seq}` / `Compaction {seq}`, and a standalone `section.betweenTurns` `轮次之间` / `Between turns` for compaction requests that ran on their own.
- Statuses: `status.failed` `失败`, `status.pending` `等待中`, `status.completed` `已完成`.
- Inspector tabs (`tab.*`): Summary, Raw Output, Preview, Raw, Source, Payload, Result, Schema, Timing, Diff, System Prompt, Tools, Options, Usage.
- Timing vocabulary: `timing.started` `开始时间`/Started, `timing.totalDuration` `总时长`/Total duration, `timing.ttft` `首 token 延迟`/TTFT, `timing.generation` `生成`/Generation, `timing.throughput` `吞吐量`/Throughput, `timing.duration` `时长`, `timing.source` `计时来源`, `timing.sessionTimestamps`, `timing.request`, plus explicit "unavailable" strings (`不可用`/Not available, `未记录`/Not recorded, `步骤开始时间不可用`, `首 token 时间不可用`, `用量不可用`, `输出 token 数不可用`, `时长过短`/Duration too short).
- Usage buckets: `usage.input` `输入`, `usage.cached` `缓存读取`, `usage.cacheCreated` `缓存写入`, `usage.output` `输出`, `usage.reasoning` `推理`, `usage.content` `内容`, `usage.other` `其他`, `usage.tokens` `Token`; scopes `本次请求`/This request and `会话累计`/Session cumulative; `未报告用量`/Usage not reported.
- Sources: `source.user` `用户`, `source.plugin` + `source.pluginNamed` `插件 · {plugin}`, `source.goal` `目标`, `source.goalRound` `目标 · Round {round}`, `source.unknown` `未知`, `source.notRecorded`, `source.messageJson`.
- Toolbar: duration mode toggle (`时长`, `使用实际时长`/Use actual duration ↔ `使用等宽操作`/Use equal-width operations), `轮次` expand/collapse all turns, `调用` expand/collapse all calls, search (`搜索轨迹`/Search trajectory, placeholder `搜索`).
- Layout strings: `layout.compacting` `正在压缩上下文…`, `layout.compactionFailed` `上下文压缩失败`, `layout.compacted` `上下文已压缩`, `layout.toolCallOnly` `仅工具调用`, `layout.imageOnly` `图片 ×{count}`, `layout.fileAttachments` `文件 ×{count}`, `layout.initialSystemPrompt` `初始系统提示词`, `layout.systemPromptUpdated` `系统提示词已更新`, `layout.toolsUpdated` `工具已更新`, `layout.systemPromptAndToolsUpdated`, `layout.compactionInterrupted` `上下文压缩在完成前被中断。`
- Overview: bars project real start time and duration; assistant bars split recorded TTFT from decode time; **hover 500 ms** reveals exact timestamps and durations; drag-select focuses the table to records active anywhere in the closed interval; wheel zooms the time domain; right-click clears the selection, right-drag pans on a zoomed viewport.
- Virtualisation: only a visible window + small buffer is mounted; the initial React data derives from the **last 50 target Nodes** ending at the tail (`README.zh.md` L52). Text-only streaming frames preserve a virtual row's key and height, reuse the measurement, and do not re-write the bottom scroll position. Pure projection `groupTrajectoryVirtualRows` attaches separator-only records (which have no height) to the next content row so the virtualizer never owns a zero-height item; a terminal separator keeps its CSS lower-marker clearance as a standalone item. Row identity comes from `trajectoryVirtualRecordKey` with a suffix for synthetic fold summaries.
- **Per-record data model** (`trajectory-record.d.ts`, `TrajectoryCellProps`) — this is the field list a reimplementation must supply: `index` (1-based `#N`), `recordId?`, `kind`, `text` (non-Markdown summary/prefix, CSS-ellipsised), `previewMarkdown?`, `opensTurn?`, `sourceSeq?`, `messageSource?`, `requestOnly?` (separator-only anchor for an auxiliary request with no visible record), `inputDetail?`, `promptDetail?` (a `ConversationPromptSnapshot`), `systemPromptDetail?`, `previousPromptDetail?`, `outputDetail?`, `thinkingDetail?`, `sourceBlocks?`, `outputBlocks?`, `schemaDetail?`, `assistantMetrics?` (`{timingRecorded, stepStartTime, firstTokenTime, completedTime, usageProvided, outputTokens}`), `result?`, `resultPreviewMarkdown?`, `callId?`, `isError?`, `timeSeconds` (**`null` when no duration is known — this is the field that makes "Time stays blank while running" true**), `startedAt?`, `input?`, `cacheRead?`.
- Known limitation (README.zh.md L90): **"进行中时 Time 保持空白"** — `partial` and `runningCalls` rows show a running state but never invent a duration, so the Overview renders only a start mark. Also: "记录选择与时间线选择位于 Trajectory 内部，不提供锚点深链接" (no deep links).
- It also has its own history paging strings: `history.loadingTrajectory` `正在加载轨迹…`, `history.loadEarlier` `加载更早的历史`/Load earlier history, `history.clickToLoadEarlier` `点击加载更早的历史`, `history.loadingEarlier` `正在加载更早的历史…`.

## 1.6 Workflow runs (`dsh-client-ui-workflow-run`)

One `<section data-workflow-run data-run-status>` per durable top-level run, on the `workflow-run` chat-node key.
- Run header: 32 px, `IconChevronRightOutline14`, title = run name (max-width 42 %, ellipsis), then a separator dot + member count + status.
- Status vocabulary: `运行中`/Running, `已完成`/Completed, `失败`/Failed, `已取消`/Cancelled, `已中断`/Interrupted (dots: running→ongoing, completed→done, failed→error, cancelled|interrupted→warning).
- Member count `{count} 个成员` / `{count} member(s)`.
- Phases: `未分阶段`/Unphased for an omitted name, `空阶段名`/Empty phase name for an empty string; phase tail shows the aggregate status summary joined with `" · "` (`运行中 {count}`, `已完成 {count}`, `失败 {count}`, `已取消 {count}`, `已中断 {count}`) — completed members are only counted first when the phase also has interrupted members.
- Members: 16 px state-dot slot, truncating name, fixed 64 px status column, min-height 24 px; `空成员名`/Empty member name fallback.
- Navigation: **only running members that are locally addressable** — child id in the ordinary session list, `origin === "subagent"`, `parentId === sessionId`, and still marked running. Terminal members are kept for review but the node never offers a cold Session entry.
- Folding: initial `open = mode !== "clean"`, i.e. **running / failed / cancelled / interrupted levels are open by default and completed levels are closed**; first abnormal edge auto-opens once; normal completion auto-closes once but **defers while focus is inside** the content; a new running member under an already-completed phase reopens both the phase and the outer run.
- Limits (README.zh.md L88-90): only top-level calls from `dsh-tool-workflow` produce these records (nested PTC calls and direct `WorkflowEngine` consumers do not); navigation is deliberately live-only; **"节点只显示运行、阶段、成员身份与状态：脚本、输出、错误、日志、用量、静态拓扑与控制操作都不属于本界面"** — no script/output/error/log/usage/topology/controls.

## 1.7 Cordis / dynamic plugin events (`dsh-client-ui-cordis`)

- Frame-wide panel at `sidebar.footer.action` (`id: cordis-panel`), **not inside the conversation**. Badge shows `running` count (label `{count} running` verbatim in *both* languages); data attributes carry both `data-cordis-badge` and `data-cordis-approval-badge`. Panel `width:420px`, `max-height:60vh`, groups rows into `当前会话`/`This session` then `其他会话`/`Other sessions`, awaiting-approval rows first; **auto-opens when a new awaiting-approval request id appears**.
- Status labels: `待激活`/Ready, `待审批`/Awaiting approval, `Client 待激活`/Client ready to activate, `运行中`/Running, `运行失败`/Run failed; card-only `已移除`/Removed and `已有更新`/Newer run available.
- Actions: `仅允许此版本`/Allow this version only, `允许此插件的后续版本`/Allow future versions of this plugin, `拒绝`/Decline, `运行`/Run, `停止`/Stop, `移除`/Remove, `重试`/Retry, `回退`/Roll back, `查看`/Inspect. Version block shows `当前：{packageId}` / `待切换：{packageId}`.
- Transcript cards (in-conversation): `cordis_define` = read-only record (name, purpose, source tabs Host/Client, result, `Inspect`); `cordis_run` = mode/plugin/package/run id/status/result, optionally hosting the plugin's own business view through `tool.view.cordis`; `cordis_stop` / `cordis_undefine` = compact action rows.
- `@pluginId` source inserts `@<pluginId>` which the toolkit turns into a pinned reference context for the model.
- **Render failures are shown in the panel, not the transcript**: `{slot} 渲染失败，已恢复默认界面：` (default UI restored) vs `{slot} 渲染失败：` (held).
- Limits: an already-expanded panel misses registry changes that announce nothing (`cordis_define`, and undefining a non-running definition); a request-only row can be answered but not acted on; rows can disappear for the duration of one read; **any page can answer any request** (approval is frame-wide by design); a card whose call head fell out of the event window loses its label.

---

# 2. Information-processing rules (the 信息处理方式)

## 2.1 Turn bounding
A turn is the `turn/start` … `turn/end` span. The chat assembler attaches every node to a `turn`/`step` location (`location.turn`, `location.step`, `location.kind ∈ {turn, step, unresolved}`), and `ChatLocationNodeIndex.getTurn(turn)` / `getStep(turn, step)` return the ordered node keys (`dsh-client-ui-chat/lib/types/client/contract/snapshot.d.ts`).

**Synthetic ordering offsets** (`CHAT_SYNTHETIC_SEQ_OFFSETS`, `dsh-client-ui-chat/lib/client.js:1505-1512`) keep existing rows from reordering:
```
interruptedAssistant  -0.9
interruptedFollowup   -0.8
processControl        -0.1
maxTokensNotice       +0.05
finalizedFollowup     +0.1
```
and `orderedVisibleChatNodes` (`:5116-5124`) sorts by `anchor → rank → originalAnchor → key`, where the process control gets `rank -1` (before process candidates) or `+1` (after the opening human input), and late process members get `rank 2`. Net rule, verbatim from the README: **"A newly available process control is inserted without changing the relative order of existing rows: opening human input precedes the control and process rows from their first projection, while System prompt remains above that input."**

## 2.2 What collapses by default, and when
Setting: **Settings → General → `对话显示` / `Conversation display`** (`settings.transcript.title`), description `控制已完成轮次的过程内容` / `Controls process content in completed turns`, choices `标准` / `Normal` and `紧凑` / `Compact`. Persisted in the `ui-chat` settings namespace as field `transcriptView`, values `["normal","compact"]`, **default `"compact"`** (`dsh-client-ui-chat/lib/types/chat-settings.d.ts:4-12`; registered at `lib/client.js:8169-8175`). Normal renders all process rows and **no** turn-process control at all.

### The exact fold gate (`ChatNodeSeat`, `dsh-client-ui-chat/lib/client.js:1551-1576`)
```js
storedEntry       = storedTurnProcessEntry(state, spec.turn)          // per-session store
processOpen       = storedEntry?.answerStep === spec.answerStep
processWindowReady= spec && presentation && compactTranscript && spec.answerAnchorSeq !== null
                    && presentation.turn === spec.turn && presentation.turnClosed && !historyIncomplete
processMember     = !TURN_PROCESS_INDEPENDENT_KINDS.has(kind)
                    && anchorSeq >= spec.processStartSeq && anchorSeq < spec.answerAnchorSeq
ownsDisclosure    = kind === "turn-process" || (kind === "assistant-step" && data.step === spec.answerStep)
foldable          = processWindowReady && (processMember
                      || ownsDisclosure && (hasExternalProcess || spec.inlineReasoning))
controllerInactive= kind === "turn-process" && !foldable        // the control renders null
compactAnswer     = isAnswerStep && foldable && presentation.compactAnswer && !open   // → 8px gap
processHidden     = controllerInactive || (foldable && processMember && !open)
```
`presentation` is derived at `:4729-4757`: `turnClosed = location.turn.status === "closed"`; `hasExternalProcess` = any non-independent node inside `[processStartSeq, answerAnchorSeq)` that is not the answer step; `compactAnswer` = **no user/steering message after the opening human and before `answerAnchorSeq`**. `historyIncomplete` is literally `hasMore` (`:2539`) — so while older history is still loadable, no control renders and **no member is hidden**.

Hidden seats are **not unmounted**: `useSearchableHidden` sets `hidden="until-found"` plus a `beforematch` handler that re-opens the group, so browser find still reaches hidden process rows (`:1484-1505`). CSS `body>[data-turn-process-inline][hidden]{margin-bottom:-16px}` removes the flow gap of a hidden reasoning row (`:2934`).

In Compact mode:
- While a turn is open: context injection, reasoning, assistant material, tool rows and retry rows stay expanded.
- At `turn/end`, the **latest step** becomes the final-answer boundary only when it contains non-blank text, an image, or an unknown visible block, **and no tool-call block** (`latestAnswer`, `dsh-client-ui-chat/lib/client.js:6751-6755`). Everything before that boundary (context injection, reasoning, earlier assistant material, tool rows, retry rows) then collapses by default.
- User and steering messages, system prompt, error, max-token and turn-tail rows **stay outside** the process group.
- A closed turn with **no** final answer keeps all process evidence visible.
- "While older history remains available through Load earlier, process controls stay absent and no members are hidden; once history is complete, every eligible closed Turn uses the collapsed default immediately" (README.md L48) — gated by `historyIncomplete: hasMore`.
- Automatic collapse **never hides keyboard focus**: if it would, the group stays open and focus stays put; a manual close focuses the process control first.
- The session-scoped store records **only manually expanded Turn + answer-Step generations**; a different answer generation starts collapsed again (`Stable Chat Node Seats` / `session-scoped store` rule).
- Independent kinds set (`TURN_PROCESS_INDEPENDENT_KINDS`, `dsh-client-ui-chat/lib/client.js:1415-1420`): `system-prompt`, `user`, `steering`, `turn-process`, … — these never become process members.
- Spacing: a closed control sits **8 px** above its answer **only when no independent input intervenes**; otherwise the collapse leaves 8 px between control and answer (`:48`).

## 2.3 Counts computed
- **Flow-item spacing** (`dsh-client-ui-chat/lib/client.js:1508`): every non-hidden non-empty flow item gets `margin-top: var(--dsh-chat-flow-gap,16px)`; the answer step gets `[data-turn-process-answer]{--dsh-chat-flow-gap:8px}`; `.flowItem:empty{display:none}`. Content width is `var(--dsh-chat-content-width)` (default 748 px) and the user bubble max-width is `min(calc(var(--dsh-chat-content-width,748px)*.702), 82%)`. Each seat carries `data-chat-anchor-key`, `data-chat-flow-key`, **`data-chat-flow-kind` = node kind**, `data-chat-turn`, and `data-turn-process-member` / `-hidden` / `-answer` (`:1544-1623`).
- **Turn-process counts** (`updateProcessState`, `dsh-client-ui-chat/lib/client.js:6787-6821`):
  - `messageCount` — incremented per `assistant/message` with `surfaceOp === "append"` that has reply content; a **per-step** map is kept, and when there is a final answer the displayed `messageCount` is the sum over steps **strictly before** the answer step (`:6761`).
  - `toolCallCount` — incremented per `tool/call` that is **not** a subagent delegation.
  - `subagentCount` — incremented per `tool/call` that **is** a subagent delegation. Delegation detection (`isSubagentDelegationTool`, `:1439-1441`): `name === "subagent" || name.startsWith("subagent_")`. Control tools such as `send_message` and `list_agents` are deliberately excluded.
  - Tool and subagent figures are therefore **mutually exclusive**; system prompt and context injection contribute **no** count.
- **Transition / step statistics** (`StatsPills` + `deriveStats`, `dsh-client-ui-chat/lib/types/client/chat/StatsPills.d.ts`): `turns`, `steps`, `llmMs` (summed step/start→assistant/message), `toolMs` (summed tool/call→tool/result), `ttftMs` over `ttftSteps`, `decodeMs`/`decodeTokens` over steps that also report output tokens. Displayed as composer-adjacent pills `data-composer-stats`; `{turns} 轮 {steps} 步` / `{turns} turns {steps} steps`; the pill row is `null` when `steps === 0` **and** there are no tokens. Stats dialog titles: `会话统计`/Session statistics, `Token 用量`/Token usage, `模型用时`/LLM time, `工具调用用时`/Tool time, `首 token 平均（TTFT）`/Avg time to first token (TTFT), `输出速度（TPS）`/Tokens per second (TPS), `缓存命中 {percent}%`/Cache hit {percent}%.
  - **Two sources, one shape**: the durable whole-log `sessionStats` projection is preferred; `deriveStats` over the loaded window is only the fallback "for assemblies without the projection". Same for token accounting → `tokenUsage` projection.
- **Subagent counts** (header trigger): `descendantCount = max(healthy direct children, descendants.count)` where `descendants` walks `origin === "subagent"` summaries up the chain and **stops at ordinary forks**, cycle-guarded; `runningCount` increments per running subagent ancestor.
- **Job counts**: `liveCount = running + stopping`; badge shows live when >0 else total.
- **Deliverables**: produced-file vocabulary deduped in first-seen order; `present` files deduped keeping the **latest declaration before the closing reply**.
- **Todo counts**: `done`/`active`/`pending` segments, zero omitted (see §1.3).

## 2.4 What is hidden / summarized / shown verbatim
- **Shown verbatim**: system-prompt text with real line breaks; `<system-reminder>` framing inside `instructions` contexts ("the framing is part of what the model read, so hiding it would misreport the request"); tool result text; the `Instructions` card of a `skill` row; an opaque context body.
- **Summarized for the collapsed row**: `notice` contexts get a one-line summary; tool rows collapse to a first-line arg summary; `present` collapses to a comma-joined path list; the turn-process control collapses a whole turn to counts.
- **Deliberately omitted**: a snapshot context's "supersedes earlier snapshots" sentence is not reprinted beside the sections; the compaction checkpoint's framed payload **never renders**; the `user/message` framing of a compaction checkpoint never renders; a goal `command-input` bubble has no timestamp/copy/branch; the jobs list never paints the job id; the trajectory Overview never invents a duration for a running record; the subagent catalog deliberately does **not** distinguish completion/failure/cancellation.
- **Bounded**: context bodies `max-height:141px`; command bodies `max-height:260px`; ask-question cards `max-height:360px`; todo list `max-height:180px`; turn-rail previews 50 chars of prompt / 120 chars of response (1 and 3 clamped lines, card `max-height:100px`); deliverables show at most **6** file chips with a `+ N 个文件` remainder label driven purely by CSS container widths (687/583/479/375/271 px); declared delivery cards collapse above **4**.

## 2.5 Streaming / incremental merging
- Definitions receive a unified `SessionEventLike` with `type`, `seq`, `time`, `data`; the assembler distinguishes durable vs client-only transient entries by the outer entry `type`. `start` receives only a durable event; the assembler **rejects a transient start** (`dsh-client-ui-conversation/README.md` L30).
- Definitions that do not consume assistant deltas return `null` for `assistant/live-chunk`.
- Replacement windows and revision gaps **rebuild from the complete loaded window**; contiguous append, prepend and assistant-settlement revisions use **incremental assembly**.
- Settlement removes only the named attempt's transient matches, applies the optional durable entry, and replays affected Contexts and dependents **without replacing unrelated target nodes**.
- Runtime states a node can hold: `running`, `settled`, `interrupted` (frozen partial), `unloaded`, `unresolved` (`dsh-client-ui-chat/lib/client.js` kinds list).
- Optimistic local echo: `chat`-local transcript/steering submissions render immediately and disappear **atomically** when the authoritative record arrives; the echo retires once when the prompt's `rpcId` is observed in the queue or history (`dsh-client-ui-conversation/README.md` L49).
- Trajectory keeps a completed reply's assembled blocks, timings and usage in the target State while the shared Session window keeps raw Events (README.zh.md L52).

## 2.6 Errors and retries
- Tool call: `error.code === "interrupted"` → `stopped`; `isError` → `error`; unresolved → `running`; otherwise `ok`. The row's error summary is the **first line** of the result text.
- Interrupted assistant prefixes render with a `已停止` / `Stopped` marker and no usage row.
- Turn error has a localized copy for a known code (`API 密钥无效` / `API key is invalid`) and otherwise the sanitized provider message.
- Retry is a durable `model-retry` node with a client-derived `scheduled | started | cancelled` lifecycle; a retry that fires before the failed turn aborts is `cancelled`; a retry turn that starts flips it to `started`. Rendered as a native `<details>`; the summary carries `role="status"` with `message.retry.status`; the details grid shows `重试延迟：` + ms and `失败原因：` + message; `maximum` renders `∞` when `mode === "always"`; the countdown ticks every **250 ms** while active. `code === "AUTH"` maps to `message.failure.auth` (`API 密钥无效` / `API key is invalid`).
- **Turn end reasons** (host payload, `dsh-session/lib/types/types.d.ts:166-201`): `turn/end: {turn, reason}` with `kind ∈ completed | aborted | blocked | error | max-tokens | interrupted`. The chat target does not switch on this directly — `aborted` surfaces as an interrupted assistant prefix + `已停止`, `max-tokens` as the `turn-max-tokens` node, `error` as `turn-error` — but the vocabulary is what a reimplementation must emit.
- Independent `/compact` failures surface as a trajectory-level copy code `trajectory.compaction-interrupted` (`dsh-client-ui-trajectory/lib/types/client/copy-codes.d.ts`).

## 2.7 Token / cost usage — when shown, when suppressed
- **Per-turn usage row** (`TurnUsagePanel`, `dsh-client-ui-chat/lib/client.js:3490-3550`): an IconActions pill with a click-open dialog. Trigger label `message.turnUsage.consumed` = `用量 {total}` / `Usage {total}`, aria `message.turnUsage.title` `本轮用量` / `Turn usage`, icon `IconDatabaseOutline16`.
- Dialog rows: `提供方 / 模型` / Provider / model (`{provider}/{model}`, comma-joined when multiple routes), `缓存命中` / Cache hit (`{n}%`), `未缓存输入` / Uncached input, `缓存读取` / Cached input (only when `cacheReadTokens !== undefined`), `缓存写入` / Cache write (only when present), `输出` / Output, and a `（其中推理 {tokens}）` / ` ({tokens} reasoning)` suffix. Counts use `{count} tok` with exact digit grouping (`number.groupSeparator`).
- **Guard** (`dsh-client-ui-chat/README.md` L36, and `deriveTurnTokenUsage`/`normalizeUsage`/`aggregateAttempts` at `:6910-7140`): the row appears only when the loaded window includes `turn/start` (`context.start?.event.type === "turn/start"`) **and every started model attempt reports safe, exact usage**:
  - `normalizeUsage` requires non-negative **safe integers** for `inputTokens` and `outputTokens`; each optional bucket must also be a safe integer; `reasoningTokens <= outputTokens`; `knownPrompt = inputTokens + (cacheRead ?? 0) + (cacheWrite ?? 0)` must be a safe sum; if `totalTokens` is present it must be a safe integer with `totalTokens - outputTokens >= knownPrompt`, and when **both** cache buckets are known the exact prompt must equal `knownPrompt`; if `totalTokens` is absent, **both** cache buckets must be present and the total is derived.
  - `aggregateAttempts` returns `undefined` if any input/output/total sum is unsafe; each optional bucket is summed **only when every attempt reported it** (`cacheRead.every(isCount)`), same for reasoning; `routes` exist only when **every** attempt carries `provider` + `model`.
  - `deriveTurnTokenUsage` walks the turn-local durable events as a small state machine (`idle → open → settled`, `by: "message" | "retry"`) and marks the whole thing `invalid` on any missing / duplicated / out-of-order boundary or contradictory total. **No attempt is ever inferred from a usage sample.**
  Unavailable optional buckets are omitted from the row; **incomplete or contradictory accounting hides the entire detail** rather than presenting a partial total.
- **Session-level usage pill** (`UsagePill`): shown when `billedInputTokens(usage) > 0 || usage.outputTokens > 0`, where billed input = the three disjoint prompt-side buckets. `cacheHitPercent` returns the integer text while integer rounding stays below 100, otherwise the minimum decimal precision that still rounds below 100; a full hit returns `100`; **no billed input returns `null`** (and the pill is then hidden).
- **Turn time panel** (`TurnTimePanel`): `message.turnTime.title` `本轮用时和速度` / Turn time and speed, `.duration` `本轮总用时` / Total run time, `.speed` `输出速度（TPS）`, `.ttft` `首 token 用时（TTFT）` / Time to first token (TTFT). Shown when `runMs !== undefined` (`turn.start` **and** `turn.end` both in window). Standalone strings: `message.ranFor` `用时 {duration}`, `message.tokensPerSecond` `{tps} tok/s`.
- **Latency semantics** (`dsh-client-ui-chat/lib/types/client/contract/turn-metrics` docs): turn TTFT is the turn's **lowest-step** request-dispatch-to-first-token reading and is only meaningful when the turn start is inside the loaded window; decode time alone is meaningless without recorded first-token time.
- **No cost/money figure exists anywhere in these packages.** Only tokens. Usage also appears in the trajectory view under `usage.*` and as a per-subagent four-bucket sum in the subagent catalog.
- **Suppressed entirely** when: no `turn/start` in window, an interrupted assistant prefix (no `messageId` ⇒ no actions at all), or accounting invalid.

## 2.8 History paging
- "The transcript reflects the loaded Session window — older transcript nodes become available only after Session Controller loads the preceding event page" (`dsh-client-ui-chat/README.md` L72).
- **Page size and cut rules** (Session Controller + `dsh-client-ui-conversation/lib/client.js:3166-3168`): `session.loadOlder()` and the open path both use `maxMessages: 50`; `loadThrough` loops with **200**. A page counts only `user/message` and `assistant/message` with `surfaceOp === "append"`, and the cut is pulled back to `min(message.seq, ...sourceEventSeqs)` so **a page never splits a message from the tool calls it consumed**; `hasMore = cut > 0`.
- The window model is `SessionEventWindow = {entries, hasMore, revision, change}` with `change.kind ∈ replace | prepend | append | settle-assistant`. Only the gateway enforces page contiguity (`assertPage` → `history page is discontinuous`); there is **no runtime guard** in `ui-conversation` that rejects a transient entry inside a prepend — that is contract-level only.
- The window is gated by `hasMore`; while true, `Load earlier` renders and **turn-process folding is disabled for every turn** so nothing is hidden that the user cannot yet inspect.
- Turn navigation is **wider than the window**: the rail merges loaded turns with the host `turnOutline` projection so **every started turn gets a fixed-pitch mark 10 px apart**; a ladder taller than the frame scrolls inside it with gradient fades. Activating an unloaded mark **pages history through that turn's `turn/start` seq** and then lands on its row (`navigateToTurn` → `loadThrough(item.anchor.seq)`, `dsh-client-ui-chat/lib/client.js:2495-2520`). Without the projection the rail falls back to loaded turns only.
- Semantic anchors survive both prepend and renderer remount: `pagingAnchor`/`anchorElement` + `data-chat-anchor-key` keep a specific row at a specific offset (`:2505-2523`). Unloaded previews read "its prompt (or just the turn number)" until the turn settles.
- Trajectory: opens positioned at the tail; the table hides real records behind an explicit loading row until the initial tail settles; a disabled loading state shows while an earlier page loads; only the visible row window plus a small buffer is mounted; semantic row keys and ARIA indices survive a prepend.

## 2.9 Scroll ownership (`dsh-client-ui-chat/README.md` L55)
Constants (`dsh-client-ui-chat/lib/client.js:1929-1995`): `SCROLL_SAMPLE_INTERVAL_MS = 500`; the scroller is `from.closest("[data-conversation-scroll]") ?? from` (the shell's scroll body when present, otherwise the view-local scroller); `readerMovedScroll(top, floor, observed) = |top - min(observed, floor)| > 0.5` so browser shrink-clamping and the app's own writes never transfer ownership; **bottom = distance ≤ 25 px**; the reading line is `viewportTop + min(96, clientHeight * 0.2)`; the paging anchor is hit-tested via `document.elementsFromPoint` at the viewport top (stopping at the composer seat) with a binary-search fallback over `[data-chat-flow] > [data-chat-flow-key]:not(:empty):not([hidden])`.
State: React `atBottom` + refs (`observedTop`, `anchor`, `pendingJump`, `jumpLanded`, `jumpRepageHead`, `firstSeq`, `opened`, `followSig`). `chatScroll.save(null)` means "pinned"; `save(position)` stores `{scrollTop, anchorKey, anchorTop}` in an **in-memory `Map` inside the chat plugin** — `ChatScrollPosition = {anchorKey, anchorTop, scrollTop}` (`lib/types/client/contract/slots.d.ts:96-100`). Scroll position does **not** survive a reload; view/draft preferences do (localStorage keys `dsh.conversation` and `dsh.conversation.<sessionId>`, field `.view`).
- Scroll ownership lives in the Chat target, not the composer.
- **Opening**: with a saved position, restore `scrollTop` then correct by the anchor row; with none, `toBottom(el)` (pinned). Never auto-scroll on open when a position exists.
- **Pinned scroll deliveries without reader movement update follow ownership immediately**, before later layout changes can invalidate their floor.
- **Reader movement stays pending until the sampling interval or `scrollend`, even inside the follow threshold**, so layout growth cannot erase a small scroll gesture.
- While pinned to the floor, a `ResizeObserver` on the column and the composer seat follows the new floor (`scrollTop = scrollHeight`) and selects the latest loaded turn **without reading row geometry**.
- **Prepend**: when an anchor exists and `firstSeq` decreased, `scrollTop` is corrected by the anchor row's new `flowTop`.
- **Appends snap to bottom** only when a user/steering node was appended, a pending steering id appeared, a submission echo appeared, or `tipMoved && atBottom`. A `followSig` string (`openState:firstSeq:lastKey:order.length:running:lastSteeringId:lastSubmissionId`) guards against snapping an inertial scroll.
- Once the reader moves away, following stops until they return within 25 px; flow-height changes then preserve the top position and the **reading-line geometry** selects the active turn (walk `turnNavigationItems` to the greatest turn ≤ the reading line).
- Turn-rail previews paint above sticky Markdown code-block banners; the rail frame stays inside the transcript band above the composer (rail `position:sticky; top:0; z-index:7`; `--turn-rail-band = 100dvh - composer-height`).
- Trajectory requires the shell to float the composer over a full-height table and reserves the composer's live height so the last rows stay reachable (`dsh-client-ui-trajectory/README.zh.md` L56).
- **Completion collapse does not depend on tail-follow position**, so a reader up in the transcript may see it reflow.
- **Turn-rail numbers** (`:1657-1663`, CSS `:1626`): `TURN_SPACING_PX = 10`, `RAIL_INSET_PX = 6`, `FADE_PX = 24`; preview budgets `PROMPT_PREVIEW_LIMIT = 50`, `RESPONSE_PREVIEW_LIMIT = 120` with whitespace collapsed and an ellipsis when clipped (`:4659-4692`). The rail renders `null` for fewer than 2 items. Frame height `min(natural, band − 64px, 420px)`, width 28 px. Hidden below **900 px** container width.

## 2.10 Copy to clipboard, per kind
- Shared `common` namespace: `copy` `复制`/`Copy`, `copied` `复制成功`/`Copied`, `copy.failed` `复制失败`/`Copy failed`; right-click variants `copy.value` `复制值`/Copy value, `copy.json` `复制 JSON`, `copy.path` `复制属性路径`, `copy.prettyJson` `复制格式化 JSON`, `copy.compactJson` `复制紧凑 JSON`, `copy.optionsHint` `{action}；右键点击可选择复制方式` / `{action}; right-click for copy options` (`dsh-client-locale/lib/client.js`).
- **User and assistant messages**: one `MessageIconActions` copy button per message. `onCopy` calls `writeClipboard(text)`, is single-flight (`copyPending`), flips the icon to `IconCheckOutline16` and the tooltip to `copied` for **1000 ms**, then reverts. Before that, the tooltip/label is `copy` (`dsh-client-ui-chat/lib/client.js:2453-2500`). The copied text is `text`: for a user/steering bubble the bubble's plain text; for the turn tail `assistantText(closing.blocks)` — the concatenated visible **text** blocks of the closing assistant message (tool calls excluded).
- **Assistant text is also copied implicitly via the same row** — there is no separate per-block copy.
- **Tool cards**: primitive-level copy labels (`copy`/`copied`) inside the diff/read/search/web/primitives; tool titles and row chrome reuse the `ui-conversation` `conversation` locale namespace (`dsh-client-ui-tool/README.md` L103).
- **Cordis code blocks**: `Copy` / `Copied` (identical in zh and en — `dsh-client-ui-cordis` locale `body.copy` `复制`, `body.copied` `已复制`).
- **JSON blocks** (unknown surface / unknown block): `JsonBlock` with `json.label` `JSON`, `json.expandNode`/`json.collapseNode`, and `json.truncated` / `markdown.truncatedCharacters` for the truncation note; copy is offered through the shared copy menu.
- **Markdown code blocks**: `code.copyLabel` / `code.copiedLabel` from `markdownLabels(t)` wired to `t("copy")`/`t("copied")`.
- **Uncopyable by design**: the goal `command-input` bubble (no copy action at all), the compaction checkpoint, system-prompt rows (no explicit copy control — only the disclosure body), and the trajectory table rows (the inspector has Raw/JSON tabs instead).
- **Clipboard *form***: a reference chip serializes to canonical text — file selections keep the natural `@path` / `@"path with spaces"` form, a folder becomes the canonical `@dir/` mention, and a session becomes `@[label](dsh-session:…)` (`dsh-client-ui-reference/README.zh.md` L32-34, L56).

---

# 3. The composer / input half

Owned mainly by `dsh-client-ui-conversation`; the selectors live in their own packages.

## 3.1 The composer surface
- **Shell CSS/DOM constants** (`dsh-client-ui-conversation/lib/client.js:14689-14966`): `WIDTH_PREF_KEY = "dsh.conversation.contentWidth"`, `CONTENT_MIN = 640`, `CONTENT_EDGE_BUDGET = 176`. `resolveContentWidth` = the stored pref clamped to `(640, max(640, column − 176))`, else `clamp(column * 0.64, 680, 920)` — mirroring CSS `--dsh-chat-content-width: clamp(680px, 64%, 920px)`. Root `div[data-phase = settling|hero|active]` → header slot → `div.body > div.scrollBody[data-conversation-scroll]` (holding `conversation.session` then `div.composerSeat[data-composer-seat]`) → two `div.widthHandle[data-side=left|right][data-width-handle][data-dragging?]` (pointer capture, rAF-throttled **symmetric** resize, commits the localStorage key). Header `min-height: 76px; padding: 10px 28px 0 20px; border-bottom: .5px solid var(--dsw-alias-border-l3)`. Key CSS vars: `--dsh-composer-text-max-height: 336px`, `--dsh-composer-stack-gap: 6px`, `--dsh-composer-side-clearance: 16px`, `--dsh-composer-dock-inset: 8px`, plus `--dsh-composer-height` and `--dsh-conversation-viewport-height` written by a `ResizeObserver`.
- Active phase makes the composer seat `position: sticky; bottom: 0; z-index: 7` with a 36 px gradient; `settling` hides it (`visibility: hidden`); with a composer overlay the scroll body becomes `overflow: hidden auto` and the seat becomes `position: absolute`.
- Header breadcrumbs come from `deriveAncestry` (walk `byId`, stop when `origin !== "subagent"`, cycle-guarded): `nav.crumbs[aria-label = session.hierarchy]` (`会话层级` / `Session hierarchy`), a literal `"/"` separator, and `crumb` / `crumbSubagent` / `crumbCurrent[disabled]` buttons. The view tab list (`role="tablist"`, `gap: 36px`, 2 px active underline) renders only with more than one view.
- **This package owns the scrollport container, not the transcript scroll position**: there is no transcript `scrollTop` assignment anywhere in `ui-conversation`. Its only scroll arithmetic is the composer's own caret reveal and a wheel handoff that forwards `host.scrollTop += e.deltaY` to `el.closest("[data-conversation-scroll]")` when the composer's inner scroller is at its top/bottom edge. This confirms Chat is the sole transcript scroll owner; chat's to-bottom offset falls back to `var(--dsh-composer-height, 152px) + 16px`.
- `data-*` attributes owned by the shell: `data-conversation-scroll`, `data-composer-seat`, `data-phase` (root and contenteditable = `input.phase ?? "inert"`), `data-composer-card`, `data-input-scroll`, `data-composer-input`, `data-composer-placeholder`, `data-conversation-header-corner`, `data-queue-dock`, `data-submission-echo`, `data-width-handle`/`data-side`/`data-dragging`, `data-testid="todo-panel"`, `data-status`.
- **One resident Lexical editor.** `ComposerContentEditable` binds a single shell-owned editor to a resident `<div contentEditable role="textbox" aria-multiline="true" data-composer-input>`; it is mounted for both the no-Session and Session states so "switching between the two never swaps the element tree". Editability has exactly one writer (`dsh-client-ui-conversation/lib/client.js:15132-15168`).
- Reference chips are **atomic decorator nodes** carrying the owner's serialization identity, expanded at submit through the owner codec; claimed slash commands stay styled leading text; folder text references carry the folder glyph as an icon prefix; decorator React faces are portaled per `NodeKey`, so text edits around a chip never remount it (`:15170-15179`).
- Placeholders: `placeholder.default` `发消息或创建任务, / 调用指令, @ 文件或对话` / `Message or run a task, / commands, @ files or sessions`; `.hero` `描述你想要构建的内容, / 调用指令, @ 文件或对话`; `.workspace` `选择一个工作区开始` / `Choose a workspace to start`; `.unavailable` `会话不可用`; `.parentOffline` `父会话已离线，无法继续发送；仍可停止当前运行`; `.steerQueue` `Cmd/Ctrl+Enter 插话发送全部排队消息`. Whitespace hides the placeholder; a whitespace-only draft with no attachment cannot be sent.
- Hero (empty session) copy: `hero.headline` `探索未至之境` / `Into the Unknown`, `hero.preview` `预览版` / `Preview`, `hero.chooseWorkspace` `选择工作区` / `Choose workspace`.

## 3.2 Send / Stop / queue / steer
- Buttons: `input.send` `发送消息` / `Send message`, `input.stop` `停止生成` / `Stop generating`, `input.send.queue` `排队发送` / `Queue message`, `input.send.steer` `插话发送` / `Steer message`.
- **Busy-Enter setting**: Settings → `繁忙时的发送行为` / `Send behavior while busy` — `settings.enter.title`, `.description` `智能体运行时 Enter 键和发送按钮的行为；Cmd/Ctrl+Enter 使用另一行为` / `What Enter and the Send button do while the agent is running; Cmd/Ctrl+Enter uses the other behavior`, choices `排队发送`/Queue and `插话发送`/Steer. Stored in the **Host-backed `ui-conversation` settings namespace**.
- The setting governs **Enter and the running Send button together**; while the Send button is enabled (no upload pending) over a plain message draft its label names the resolved mode (`排队发送` / `插话发送`), and `Cmd/Ctrl+Enter` uses the other mode. Idle sessions, empty drafts, and `/` command lines keep the plain `Send` label.
- Disabled Send and Stop buttons **suppress their tooltips** — including the Stop button that becomes a disabled Send button when the turn ends.
- **Three delivery placements** (`dsh-client-ui-conversation/README.md` L49): idle → transcript; busy + Queue → `QueueDock`; busy + Steer → the pending-steering surface. Attachment ids are held through admission and disposed with the Session scope.
- **Optimistic commit**: Enter clears the draft, the occurrence table and the undo history in one transaction, keeps the composer in `plain`, and runs the send as a **detached attempt**, so typing and further sends continue during the flight. One paint is yielded, then images are encoded through the browser's native `FileReader` data-URL path and files cite staged receipts. Concurrent failures are restored **together in submission order** until the user edits the restored content; command submissions keep the frozen `submitting` phase.

### The literal submission state machine (`dsh-client-ui-conversation/lib/client.js`; types in `contract/input.d.ts:310`)
Phases `plain | adjudicating | claimed | submitting`; events `draft-changed | claim | enter | adjudicated | adjudication-failed | submit-settled | sink-settled | send-committed | release`; effects `adjudicate | begin-submit | default-sink | notice | commit-draft{retainSuffixOf}`.

| from | event | to | effects |
|---|---|---|---|
| claimed | draft no longer starts with `claim.token` | plain | — |
| claimed | `enter` | **submitting** | `begin-submit{args = draft after token}` |
| plain | `enter`, draft empty | plain | — |
| plain | `enter`, draft starts with `/` | **adjudicating** | `adjudicate` |
| plain | `enter`, ordinary text | **stays plain** | `default-sink` + `commit-draft{retainSuffixOf}` |
| adjudicating | `adjudicated{claim}` | submitting | — |
| adjudicating | `adjudicated`, outcome `undefined` | plain | detached default sink |
| adjudicating | `adjudicated`, other defined outcome | plain | — |
| adjudicating | `adjudication-failed` | plain | `notice{error}` — **never a silent downgrade** |
| submitting | `submit-settled` ok | plain | `commit-draft{retainSuffixOf}` |
| submitting | `submit-settled` fail, live draft equals the snapshot and still starts with the token | **claimed** | — |
| submitting | `submit-settled` fail otherwise | plain | `notice{error}` |
| any | `sink-settled` (must be in `detached`) | — | `notice{info iff ok && outcome.kind !== 'error' else error}` |
| any | `release` | plain | claim cleared; inflight + all detached aborted |
Adjudicated / submit-settled / adjudication-failed require the inflight seq to match; sink-settled requires a successful `detached.delete(seq)`. Command attempts hold the **single frozen** inflight slot; default sends are concurrent in `detached: Map<seq, AbortController>`.

`commitDraft(retainSuffixOf)` deletes only the typed prefix when the draft still starts with the snapshot (so text typed during the flight survives), otherwise clears the root, and **always dispatches the Lexical history-cut so Cmd-Z cannot resurrect sent content**. An attachment-only send commits `send-committed` (no suffix retention) and restores attachments to the **head** of the rail on failure. Failed detached sends restore in ascending seq joined by `"\n\n"` only when the draft is empty or is the last-restored revision; any other edit clears the failure buffer.

`beginSubmission` mints a **fresh `randomUUID()` per call** (the requestId is reused only for the first `prompt` attempt), appends `{requestId, placement, time, text, attachments}` to `pendingSubmissions` synchronously, sets `promptAttempted`, and computes `placement = running ? (mode === 'steer' ? 'steering' : 'queued') : 'transcript'`. Retirement is `{reason:'observed'}` from a durable `user/message` with `source.kind === 'user'` and a string `source.rpcId`, or from a matching queue row; `{reason:'failed'}` retires immediately.

### Editor internals
Lexical editor created as `createEditor({namespace:"dsh-composer", nodes:[ReferenceChipNode, TextRefNode]})`; `HISTORY_MERGE_DELAY_MS = 1000`; `REFERENCE_PLACEHOLDER_RE = /[\uE100-\uE11D\uFFFC]/gu` strips forged chip placeholders from paste and persisted drafts. Chips are decorator nodes whose `getTextContent()` is the clipboard projection and whose `isKeyboardSelectable()` is `false` (atomic arrows/Backspace). The keymap is registered at **CRITICAL** priority (before `@lexical/plain-text`); the IME guard is `event.isComposing || event.keyCode === 229` **plus** a root composition watch holding the guard for **10 ms** after `compositionend` (Safari delivers the closing keydown after compositionend); Shift+Enter falls through to a newline; Enter with `event.repeat` or `!canSubmit()` is ignored; otherwise `submit(event.ctrlKey || event.metaKey)`. Paste reads `clipboardData.items` files → `intakeFiles`, then `text/plain` (refused while `machineBusy || locked`).

### Send-label / stop resolution
`resolveSubmitMode(preferred, running, gesture, steeringAvailable)`: **not running, or not steer-capable → always `"queue"`**; running + steer-capable: `gesture === 'enter'` → the stored preference, `'accelerated'` (Cmd/Ctrl+Enter) → **the opposite**.
`primaryStops = running && subagent === null && (empty || blocked !== undefined)`; `interruptible = running && continuable` (**a separate Stop button renders before the primary when `subagent.address.mode === "continuable"`**); `primaryLabel` = `input.stop` when stopping, else `input.send.queue`/`input.send.steer` only when `running && steeringAvailable && !disabled && !uploadsPending && plainMessageDraft` (`input.phase === "plain"` and the draft does not start with `/`), else `input.send`. **The primary button is icon-only** (up-arrow / stop square); the label is tooltip + `aria-label` only. Pending file uploads → a toast `file.stillUploading` and the draft is retained. `canSteerQueue = !locked && !machineBusy && !commandMenuOpen && empty && running && steeringAvailable && queue.some(placement==='queued')` → Cmd/Ctrl+Enter calls `steerQueue()` FIFO; `session/steer-unavailable` and `session/queue-item-not-found` are swallowed, other failures notify `queue.steerFailed`. A command submission short-circuits with `command.attachmentsUnsupported` when the command rejects attachments; the `submitting` phase refuses attachment add/remove.

## 3.3 Queue dock (slot `conversation.input.dock`, id `queue`, order 20)
- Row model: `{id, messageId, placement:'queued'|'steering'|'context', rpcId?, content, preview, text: string|null}`. Rows are the union of durable `queue` rows with `placement === "queued"` and still-unadmitted pending submissions.
- `rowCount === 0` → `null`. **One row renders inline** (with its own lead icon); **two or more default to collapsed** behind a count header carrying `IconQueueOutline14` + `queue.count` `{n} 条排队消息` / `{n} queued messages` + `queue.sending` when a queued echo is outstanding. `collapsed` defaults **true**; `expanded = !collapsed || interactionActive`; `listVisible = rowCount === 1 || expanded`. The header's chevron points down when expanded, up when collapsed; the header is disabled while editing/busy.
- Row actions (all disabled while `busy !== null`; the whole action group requires `queueMutable = subagent === null || address.mode === "continuable"`): **Edit** (`IconEditOutline16`; disabled with tooltip `queue.edit.unsupported` when `row.text === null`; opens an inline `input.editor[aria-label=queue.edit]`, Enter saves, Escape cancels), **Save** (`IconCheckOutline16`, `queue.save`, disabled on blank), **Cancel edit** (`IconCloseOutline16`, `queue.cancelEdit`), **Remove** (`IconTrashOutline16`, `queue.removeFailed`, sends `{kind:'remove'}`), **Steer** (`IconSendOutline14`, disabled unless running, tooltip `queue.steer.unavailable` = `仅运行中可插话发送`, `queue.steerFailed`). Edit payload = `{kind:'edit', content:[{type:'text', text}]}`.
- Text copy: `{n} 条排队消息`, `发送中…`, `排队消息图片`, `排队文件 {name}`, `编辑排队消息`, `包含非文本内容，暂不支持编辑`, `保存排队消息`, `取消编辑`, `删除排队消息`, `插话发送`, `仅运行中可插话发送`, `编辑失败：这条消息可能已经开始发送。`, `删除失败：…`, `插话发送失败，请重试。`
- Queued echo rows (`data-submission-echo`): images as `img.thumb[src=previewUrl][alt=queue.image]`, files shown as `queue.file{name}`, preview through `projectUserText`, a `role="status"` `queue.sending`, and three **permanently disabled** buttons titled `queue.sending`. A matching Host queue row replaces the echo and enables each action per its normal text-content / running-state requirement. **Prompt acknowledgement alone does not enable queue actions.**
- Preview: sent text via the shared inline reference projection (wire session forms fold to their label), images as thumbnails and files as compact name+size cards, in original attachment order.
- CSS: panel `border-radius: 12px 12px 0 0`; list `max-height: 180px`; row `height: 36px`.

## 3.4 Slash commands (`dsh-client-ui-commands` + `dsh-client-ui-input-trigger`)
- Typing `/` opens the matching surface — a registered popup, the host command's input, or direct execution. **"命令行绝不会被静默降级为普通提示词"** (the command line is never silently downgraded to an ordinary prompt).
- Three dispatches: a host descriptor with `input` → `leadingInput`; a registered `CommandUiSpec` → dispatched by kind (`popupSelect` or `action`); everything else → `execute`.
- Contributions (`ctx.commandUi.register`) or **decorations** (`ctx.commandUi.decorate`) of existing host commands. A decoration adds a bare-invocation popup while the host command keeps its directory row, argument declaration and lifecycle accounting; a decorated name **never fires when the session directory has no host row**.
- Discovery: `CommandDirectory` is the single wire-derived cache, **keyed by session**, fetched by `ctx.remote.commands.list(sessionId)` (failure → `command.list failed: ${code}: ${message}`), with statuses `cold | pending | ready | failed`, single-flight and epoch-guarded so a superseded pull can never overwrite a newer one. **Subagent sessions short-circuit to `[]`.** Soft invalidation on `commands/change`, per-session reset on `agent-preset/selected`, hard reset + prewarm on `connection/reset`. A ready snapshot is not demoted while a repull flies.
- Matching: space and Enter resolve against the session command directory; `matchSpace` answers synchronously from the cache; `matchEnter` force-waits for the cache on a SubmitAttempt and **rejects when prewarm fails**. Menu query = case-insensitive **ordered subsequence** of the command name. `rankByName` (inlined from ui-primitives) lowercases the query, keeps names containing it as an ordered subsequence, and sorts `prefix desc → score desc → original index asc`; the scorer gives **+8** when the matched character is at index 0 or follows `-`/`_`, **+4** for an adjacent subsequent match, and **+1 − gap** for a gapped one.
- Dispatch tables: the **menu** column tries (1) an available contribution → popup/action → `handled`; (2) the host descriptor (absent → `undefined`); (3) an available decoration → `handled`; (4) `desc.input !== undefined` → a `leadingClaim`; (5) otherwise it consumes the token and runs a detached execute. The **space** column excludes contributions and only a host descriptor with `input` may claim. The **enter** column requires a leading `/`; contributions and decorations act on the **bare token only**; an unknown or malformed line falls through to the default sink unless a host descriptor matched.
- Execution returns `{kind:'success'}` **regardless of handler outcome** (the host durably logs `command/run` + `command/done`, and the outcome becomes a persistent flow node); an unmatched line returns `{kind:'error', text: "unknown or malformed command: " + line}`; a refused call throws `command.execute failed: ${code}: ${message}`. On success the browser also emits a **local** `command/executed(sessionId, name, result)` confirmation that other clients never receive.
- Known host command descriptions (`HOST_DESCRIPTION_KEYS`, substituted **only when `command.description === en[key]`**): `compact` `压缩以上对话内容` / Compact older conversation history, `export` `将当前会话内容导出为 ZIP` / Download this Session log as a ZIP archive, `feedback` `发送关于当前会话的反馈` / record feedback about this session, `goal` `设置或查看长期任务目标` / set or view the goal for a long-running task, `permission` `切换权限预设（沙箱模式与审批策略）` / Switch the permission preset (sandbox mode + approval policy), `plan` `进入或退出计划模式` / Enter or leave plan mode. **The client hardcodes no command list** — every row comes from `command.list`.
- Popup shell: options load **once per open**; the search box is a **pure local filter** over `label` *or* `detail` (blank keeps all) — the provider is never re-queried. ↑/↓ drive the filtered highlight; Escape dismisses and refocuses the composer; ←/→ are left to the native caret; a pointer-down outside the card dismisses unless a confirmation is pending. Select is single-flight. `MAX_HEIGHT = 320`; card `min-width: min(220px,100%)`, `border-radius: 20px`, positioned `bottom: calc(100% + 4px)`; the selected option shows `IconCheckOutline16`. The popup registers into `conversation.input.overlay` as `id:"command-popup", order:1` — **the `/` trigger menu is order 0 in the same list slot**.
- **Attachments**: a slash command only continues when it declares `input.attachments`; every other command path throws the localized `attachmentsUnsupported` rejection — `/{command} 不接受附件，请先移除附件` / `/{command} does not accept attachments; remove them first` — as a **transient toast**, leaving the draft and attachment cards in place. Precisely: an enter submission with attachments resolves only through a route that accepts them — a `popupSelect` contribution/decoration and a bare host detached execute all throw; a host `input` throws unless `desc.input.attachments === true`; an `action` runs regardless. Handler *error results* keep the draft.
- Limit: after the session is destroyed, a detached command-result notice falls back to `console` because `SessionInput.notify` targets the triggering composer.

## 3.5 Input triggers (`/`, `@`)
`dsh-client-ui-input-trigger` owns the pipeline (pure core in `src/core/`, DOM-free), `MenuView` self-registers into `conversation.input.overlay`.
- Both `/` and `@` are detected **at the cursor**; source groups render under header rows. Candidate groups in this build: `command` `指令`/Commands, `skill` `技能`/Skills, `subagent` `子智能体`/Subagents, plus the reference package's file/folder and session groups and cordis's plugin group. (`TriggerChar = '/' | '@'` — exactly two characters.)
- **Detection is a pure core** with these exact grammars (`dsh-client-ui-input-trigger/lib/client.js:12-115`):
  - `@` uses the shared file-reference grammar — quoted `/(?:^|\s)(@"([^"]*))$/u` first (the query may span whitespace), then plain `/(?:^|\s)(@([^\s]*))$/u`. **`user@host` never triggers**: the `@` must be at the start of the draft or after whitespace.
  - `/` scans backward from `caret-1`; whitespace ends the scan; for each `/` the word-boundary rule is tested and, if it fails, **the scan continues** (this is how URL slashes are skipped).
  - `boundaryOk`: true at index 0, after `\s`, or after punctuation; false after `[\p{L}\p{N}_]`; plus two `/`-only carve-outs (a `/` directly after `/` is dead; a `/` after `:` where the character two back is not whitespace is dead).
  - Guard tiers: `plain` (both live), `claimed` (`/` suppressed, `@` live), `frozen` (detection returns `null` immediately).
  - `position` is `leading` iff the trigger is the first non-space character, else `inline`. `TriggerHit` carries `{trigger, query, quoted, position, span}` and the shell stamps `span.draftRev`.
- **Menu reducer**: one group per source, status `pending`; a new `hit` opens a **new generation** and resets all existing groups to pending **while keeping their items** (stale-while-revalidate); a settle outside the current generation is dropped; **all groups ready-and-empty auto-closes**; a failed source silently removes its group; `move` cycles the highlight across ready items of ready groups with wraparound; **keyboard and pointer share one highlight** (last input wins); stale/no-op events return the identical state reference so subscribers skip re-render.
- **Candidate fetching happens in the source, not the pipeline** — the pipeline forwards `{query, quoted, position, drilled, signal}` and aborts the previous generation. The `/` source fuzzy-matches; the `@` source forwards `query` to host RPCs.
- Keyboard arbitration (`up|down|enter|escape|tab` → `consumed|pick-highlighted|pass`): composing (IME) or closed menu ⇒ `pass`. `up`/`down` move the highlight → `consumed`; `escape` stops the fetch and closes → `consumed`. `enter` with no highlight ⇒ `pass`, with an unready highlight ⇒ `consumed`, otherwise a pick → `pick-highlighted`. `tab` with no highlight ⇒ `pass` (native focus traversal survives), unready ⇒ `consumed`, vanished item ⇒ `pass`, a `drill: true` item → a drill pick → `consumed`, otherwise an ordinary pick → `pick-highlighted`.
- Space/Enter adjudication: `onSpace` only fires when the hit is `leading`; it polls `matchSpace` in **roster order** and the first non-`undefined` wins (`handled` ⇒ the caller `preventDefault`s). `adjudicate` iterates every source whose trigger the line starts with — so `@…` and `/…` lines both get a chance — and the first non-`undefined` wins; aborts throw.
- **MenuView** (`MAX_HEIGHT = 320`, comment: *"Design cap on the list height (figma SLASH 39:26572 MenuDropdown)"*): row DOM ids `dsh-slash-option-${source}-${index}` drive `aria-activedescendant` and `scrollIntoView({block:'nearest'})`; `role="listbox"` sits on the **scrolling viewport** rather than the shell so the breadcrumbs can be a non-option header; `aria-label` = `触发候选建议` / `Trigger suggestions`. A group title row is skipped when `showGroupTitle === false` **or** any item carries a `section`, otherwise it is `t(group.source)` — and an unknown source name renders as the key itself. A pending empty group shows two skeleton rows (`role="status"`, widths `32%` and `48%`). Item rows are `role="option"`, pick on **mousedown** with `preventDefault()` so focus never leaves the textarea; a `drill: true` row shows `进入目录` / `Browse folder` + `<kbd>Tab</kbd>` + a chevron `role="button"` annotated `进入目录`. Dismissal is a capture-phase document `pointerdown` **outside both the list and its closest `[data-composer-card]`**. CSS: root `z-index:100; max-height:320px; border-radius:20px; padding:4px; position:absolute; bottom:calc(100% + 4px); left:0; right:0`; item `min-height:40px; padding:8px 10px; font-size:14px; border-radius:10px`; active background `var(--dsw-alias-interactive-bg-hover)`.
- Loading `正在加载…` / `Loading…`; crumbs `目录导航` / `Folder navigation`.
- Limits (README.zh.md L76-78): **only a global source tier exists** (per-session source shadowing is designed but not enabled); `InputTriggerCandidate.icon` is claimed to be **rendered as literal text** — ⚠️ **contradicted by the compiled code**, which passes `item.icon` to `ReferenceIcon kind={…}` (see §6); the single `conversation.input.overlay` SlotMap merge lives in this package while ui-conversation owns the anchor/children/lifecycle, purely because of the dependency direction.

## 3.6 References (`@`) — `dsh-client-ui-reference`
- One combined **`@` source**, `name: "reference"`, **`showGroupTitle: false`** — so there is no source-title row; grouping is expressed with per-item `section` headers instead.
- Unquoted `@token` lists **files first, then sessions** (deterministic concatenation), firing `fileReferences.list` and `sessionReferenceResolver/candidates` **together** via `Promise.all`; `@"…` (quoted) skips sessions entirely. The list is a completion menu, not a search results page. A failed domain contributes `[]` for that domain only while the other still lists — **candidate failure is intentionally quiet**.
- Group headers: `section.files` `文件与文件夹` / `Files & folders`, `section.sessions` `对话` / `Sessions`; `candidate.noCwd` `（无工作目录）` / `(no cwd)`; breadcrumb root `工作区` / `Workspace`.
- **Breadcrumbs exist only when `drilled === true` AND the query contains a `/`.** Crumbs start at the root and add one per path segment; the **last** segment gets `current: true`, rendered by MenuView as disabled + `aria-current="location"`. Every crumb payload is the same directory drill payload as a folder row, so "return to a step" and "descend a level" are one outcome. A segment the grammar cannot represent aborts the whole header.
- **The `@path` grammar** (`formatFileMention`, duplicated from `context/file-reference/src/grammar.ts`): `path = kind === 'directory' ? candidate.path + "/" : candidate.path`; reject if the path matches `/[\u0000-\u001f\u007f-\u009f"]/u`; if the path has no whitespace (or the user explicitly opened a quote) emit `@path`; otherwise a directory emits `@"dir/` — **opening quote only, intentionally unterminated** so the drill can continue — and a file emits `@"path"`.
- **Pick outcomes** (the `onPick` `action` distinguishes them):
  - directory, settling pick (row body or Enter) → `{insert:{source:"reference", ref: mention, label: "<label>/", appearance:"folder", clipboardText: mention}}` — a folder icon, a trailing-slash label;
  - directory, drill (Tab or the trailing chevron) → `{text: mention, continue: true}` — plain editable path text with the menu kept alive at the trailing slash;
  - file → `{insert:{…, appearance:"file", clipboardText: mention}}` where the mention is the natural `@path`/`@"path"` form;
  - session → `{insert:{…, appearance:"session", clipboardText: mention}}` where both the hidden `ref` and the clipboard are the canonical `@[label](dsh-session:…)` mention.
- `codec = {clipboardText: ref => ref, serialize: ref => Promise.resolve(ref)}` — **the mention string is what reaches the model, verbatim**; serialization never reconstructs identity from the visible title.
- The chip itself is rendered by **ui-conversation**, not this package: `onPick`'s `insert` becomes a scoped `slash/input-insert-reference`; the input machine CAS-checks `span.draftRev === this.rev`, replaces the span with `$createReferenceChipNode(ref)` plus one separating space (unless one already follows). `ReferenceChipNode` is a Lexical **DecoratorNode** (`getType() === "reference-chip"`) carrying `__source`, `__ref`, `__label`, `__appearance`, `__clipboardText`, `__invalid`; it is atomic (one delete removes the whole chip) and each occurrence is tracked with its own `occurrenceId`/`occurrenceSeq`. The React body renders a literal `"@"` marker span when `appearance` is undefined, otherwise `ReferenceIcon kind={appearance} size={14}` (i.e. the glyph is `file` / `folder` / `session`); `title` = the label; `__invalid` renders error colour + `opacity:.7` + line-through. CSS: `.chip{vertical-align:bottom;background:var(--dsw-alias-interactive-bg-hover);max-width:240px;height:22px;color:var(--dsw-alias-state-business-primary);user-select:none;cursor:default;border-radius:6px;align-items:center;gap:3px;padding:0 6px;line-height:22px;display:inline-flex}`.
- Session rows reuse the host session list's `updatedAt` and the **same relative-time buckets** as that list (`刚刚`/now, `{n}分钟`/`{n}min`, `{n}小时`/`{n}h`, `{n}天`/`{n}d`, `{n}个月`/`{n}mo`, `{n}年`/`{n}y`); a session not in the list falls back to the candidate's own creation time. File rows omit the redundant parent path while a drilled breadcrumb header is showing.
- **Dedupe: there is none anywhere on this path.** No `Set`/`seen` filter exists in this package, in `dsh-file-reference`, or in the composer's insert path. Every insert creates a new chip occurrence, so inserting the same path twice yields two chips, and the same file may appear in the candidate list as often as the host provider returns it.
- Limits: the browser never scans files (a host `ctx.fileReferences` provider must be mounted); session search is metadata-only — session id, cwd, and log-backed latest title, **not message bodies or full transcripts**; session-reference preparation failure happens **after** prompt acceptance and terminates that agent turn.

## 3.7 Attachments (`dsh-client-ui-attachment` + ui-conversation slots)
- Slots it fills: `conversation.input.attachments`, `conversation.message.images`, `conversation.trajectory.images`, `tool.call.images`.
- Draft rail: images and generic files in one non-wrapping horizontal rail, **all entries 64 px tall**; images are 64 px square thumbnails; generic files are 240 px-wide cards with 16 px radius, a blue gradient document icon, file name, and uppercase extension + byte size. Overflow pages via edge arrows; the scrollbar stays hidden; a new entry scrolls the rail to its end.
- Per-file upload state: spinner in the icon slot; a determinate progress bar once the transport reports bytes, **indeterminate before the first report**; retry on failure. Upload copy: `file.uploading` `上传中…` / `Uploading…`, `file.uploadFailed` `上传失败，点击重试` / `Upload failed; click to retry`, `file.retry` `重试上传 {name}`.
- Remove button appears on hover or keyboard focus and **stays visible on touch devices**.
- Message images: one user message places files and images in the same right-aligned wrapping arrangement in source order. `UserStyleBubble` splits the content into `{text, attachments, rest}`; the attachment row sits **above** the bubble with `data-message-attachments`. A message with exactly one image and no other attachment renders it at **240 px on the long edge** (aspect clamped to `[0.25, 4]`, never upscaled; `object-position` becomes `center top` below a 0.25 ratio and `left center` above 4; unknown dimensions fall back to a 240×240 box); with multiple attachments every image is a fixed **64 px square** alongside 240×64 px file cards. Residual non-text blocks render as `JsonBlock` labelled `message.extraBlock` (`附加内容块` / `Extra content block`). Reference labels append `引用会话 · {labels}` / `Referenced session · {labels}` joined by `、` / `, `. Clicking a loaded image opens the document-level lightbox; a failed load shows a retry control.** Limits, verbatim-ish: **no zoom and no download** ("预览仅以适配视口的尺寸渲染原图"); **focus is not trapped** — it sets `aria-modal` and restores focus, but Tab can still reach the page behind.
- **Intake paths (all three live in ui-conversation, not in the attachment package)**: (1) the paperclip — a `Tooltip` labelled `file.attach` `添加附件` around a button with `IconPaperclipOutline16`, clicking a hidden `<input type="file" multiple>`; **no `accept` attribute**; disabled when `subagent !== null || locked || machineBusy || addFiles === undefined`. (2) Paste — the Lexical `PASTE_COMMAND` intercepts `clipboardData`, takes every `items` entry with `kind === "file"`, calls `intakeFiles(files)`, then pastes `text/plain`; with files and no text it prevents default. (3) Drag & drop — **document-level** `dragenter`/`dragover`/`dragleave`/`drop` plus a `window dragend`; acts only when `dataTransfer.types.includes("Files")`; `dragover` sets `dropEffect = canAcceptDrop ? "copy" : "none"`; a depth counter handles nested enter/leave; `canAcceptDrop = subagent === null && !locked && !machineBusy && addFiles !== undefined`.
- **Generic-file card** (`FileCard`): exactly `240px × 64px`, `border-radius: 16px`, `padding: 0 12px`, `gap: 10px`; 28 px type glyph (or a 20 px / 2 px-border spinner while uploading), name 14 px/22 px weight 500 ellipsised, a 12 px/15 px tertiary meta line, the remove button, and a progress track `height:2px; bottom:5px; left:12px; right:12px` filled in `--dsw-alias-brand-primary`. Meta rules: uploading → `file.uploading`; error → `file.uploadFailed` (meta and card border turn error-coloured) and the **whole body becomes a `<button aria-label={file.retry}>``; ready → `[extension.toUpperCase().slice(0,8), fileSizeText(bytes)].join(" ")`. Progress width = `min(1,max(0,progress))*100%`; **an absent progress value renders the indeterminate animation** (a 35 %-wide bar with the `file-card-progress` keyframes) — that is the pre-first-byte state.
- Remove button: `IconCloseFill14` size 12 at `top:4px; right:4px`, `opacity: 0` → `1` on `:hover`/`:focus-visible`, and **forced visible under `@media (pointer:coarse)`**.
- Exact rail geometry: `scrollbar-width:none`, `display:flex; gap:10px; align-items:stretch; overflow:auto hidden`, items `flex:none; height:64px`, rail `min-width:0; margin-bottom:-6px; padding:2px 10px 0`. Edge arrows are 24 px round buttons at `left:4px` / `right:4px`, recomputed on scroll, on item-count change and via a `ResizeObserver`; the vertical wheel pans horizontally and is consumed exclusively (non-passive listener). A rail mounting over an existing draft keeps its start position; a newly added item is revealed at the end.
- Lightbox internals: `createPortal` to `document.body`; `role="dialog" aria-modal="true"`; a mask div with `onMouseDown = onClose`; closes on a window-level `Escape`, a mask press, or the close button; focuses close on mount and **restores focus to the opener** on unmount; `z-index:1000; padding:40px; position:fixed; inset:0`; image `object-fit:contain; max-width:min(100%,1600px); max-height:calc(100vh - 80px); border-radius:12px`.
- Tile variant geometry: `width/height/min-width/min-height:64px`, `border-radius:16px`, `cursor:zoom-in`, `border:.5px solid var(--dsw-alias-border-l2-darkmode-thin)`, `background:var(--dsw-alias-interactive-bg-hover)`; the frame enforces `min-width/min-height:44px`.
- Drop overlay: a full-viewport invitation with an illustration, a title, and — once it would accept — a limit line. `attachment.dropTitle` `文件或图片拖动到此处即可添加`, `attachment.dropDesc` `图片限制：最多 {count} 张，每张 {size}` / `Image limit: up to {count} images, {size} each`, `attachment.dropBlocked` `当前无法添加文件或图片`. **The overlay only presents state** — accept/reject is decided by the owner's document-level listener.
- Validation copy: `image.unsupportedType` `仅支持 PNG、JPG、WebP、GIF 格式的图片`, `image.tooMany` `一条消息最多添加 {count} 张图片`, `image.fileTooLarge` `单张图片不能超过 {size}`, `image.totalTooLarge`, `image.tooManyPixels` `图片分辨率过大，请压缩后重试`, `image.dimensionTooLarge`, `image.modelUnsupported` `当前模型不支持图片，请切换支持图片的模型`, `image.sendFailed`.
- **The numbers** come from the host `imageLimits` projection (`{maxImageBytes, maxImagesPerMessage, maxMessageImageBytes, maxImagePixels, maxImageDimension, mediaTypes}`), read via `useProjection("imageLimits")`. Authoritative host defaults are in `dsh-attachment-local/lib/index.js`: **20 MiB per image**, **20 images per message**, **200 MiB message total**, **64e6 pixels**, **8192 px dimension**, media types `image/png`, `image/jpeg`, `image/webp`, `image/gif` (`:888-896`, `:993-998`). ⚠️ The **fixture/replay** path in `dsh-client-connection/lib/client.js:3188-3200` hard-codes a **different** set — 5 MiB / 20 / 100 MiB / 4e7 px / 2000 px — so the effective limits depend on where the value came from. Client-side enforcement covers only **3 of 5** (`intakeFiles`): count, per-image bytes, message total; `maxImagePixels` and `maxImageDimension` are host-enforced and only surface through `attachmentErrorText` (reason codes `IMAGE_TOO_MANY_PIXELS`, `IMAGE_DIMENSION_TOO_LARGE`, `TOO_MANY_IMAGES`, `IMAGE_TOO_LARGE`, `IMAGES_TOO_LARGE`, `INVALID_IMAGE`/`IMAGE_TYPE_MISMATCH`, `MODEL_DOES_NOT_SUPPORT_IMAGES`, `FILE_NOT_STAGED`). `imageSizeText(bytes)` = MiB as an integer or 1 decimal + `"MB"`.
- Limits on intake: continuable subagents **disable attachment intake entirely** and skip the local echo, because their transport does not preserve the browser request id.

## 3.8 Model selection (`dsh-client-ui-model-selection`)
- Two surfaces over **one** per-session directory owned by `ModelDirectoryResolver` (`ctx.modelDirectories`): the `/model` popupSelect contribution and the composer seat `conversation.input.model`. Both load via `session.models` and commit via `session.selectModel` through the same `ModelDirectory` instance, so a switch made in one is exactly what the other shows next.
- Grouping: models grouped by provider. The composer menu shows model and effort names only; the `/model` popup additionally shows provider names and catalog descriptions. The two built-in DeepSeek model descriptions are localized; external provider descriptions stay as authored.
- Copy: `command.description` `选择本会话使用的模型`; `trigger.fallback` `选择模型` / `Select model`; `trigger.loading` `正在加载模型…`; `trigger.aria` `选择模型，当前 {model}`; `trigger.ariaEffort` `选择模型，当前 {model}，推理等级 {effort}`; `menu.aria` `模型与推理等级` / `Model and reasoning effort`; `menu.model` `模型`; `menu.effort` `推理等级` / `Effort`; `effort.providerDefault` `Default`; `option.deepseekV4Flash.description` `快速、高效且经济；适合目标明确、常规或并行任务。`; `option.deepseekV4Pro.description` `更强的自主编码、知识与复杂推理能力；适合复杂或质量优先的任务，但成本更高。`; `status.loading` `正在刷新模型列表…`; `action.reload` `重新加载`; `option.loadError` `目录加载失败：{message}`; `warning.groupLoad` `{name} 加载失败：{message}`; `empty.models` `没有可用的模型。`; `empty.efforts` `当前模型未提供推理等级。`; `blocked.composer` `当前模型不可用，请先选择模型`.
- Effect timing: the full selection takes effect **from the next request**; a running step keeps the model and effort it started with.
- Unroutable session → the package registers a composer block whose own copy disables input; it clears without a reload when routing returns. **`null` before first load, or after a failed load, never blocks**, and catalog membership never blocks either.
- Limits: no draft-time or addressed-subagent selection; catalog names are **presentation only** (selection/persistence use provider/model/effort ids); a provider whose catalog or exact-model metadata query fails is listed as a **non-selectable failure row** until reload; effort cannot be typed freely, and no Effort row appears when the adapter has no reasoning metadata.

## 3.9 Permission presets (`dsh-client-ui-permission-presets`)
- General-settings row changes the **default for future sessions only** — "改变它绝不会切换或改写当前会话". `/permission` changes **the current session** and marks its current preset.
- Built-in labels: `仅可查看` / **Read Only**, `工作区内修改` / **Workspace Write**, `完全权限` / **Full access**. `custom` is a display state only, never a target. Unknown kebab-case names render Title Case; explicit host labels pass through. Preset descriptions come from the host and may be written in the other language.
- Selecting commits the literal command line `/permission <preset>`. The decoration only replaces the **bare** invocation; the with-argument path typed directly still switches.
- **`完全权限` / Full access always requires an explicit risk acknowledgement**: a `confirmation` payload rendered by the shared popup shell as an in-page risk gate — `确认启用完全权限？`, description `启用完全权限后，新会话将减少确认步骤…`, acknowledge `我已了解风险，并愿意继续`, `取消`, `启用完全权限`.
- Both surfaces confirm a change **only after the host pushes the changed permission state** (`只在宿主推送更改后的权限状态后确认变更`).
- Limit: the settings row is Web-only (non-Web clients can still switch the current session via `/permission`).

## 3.10 Plan mode chip (`dsh-client-ui-plan`)
- Warn-coloured `Plan ×` pill in the `conversation.input.plan` seat when the host-computed projection says plan mode is the effective target; otherwise the seat is empty.
- Clicking sends `/plan off`; disabled while locked/leaving (single-flight on a `leaving` state). Failure shows an inline `role="status"` error with `退出 plan mode 失败` / `Failed to exit plan mode` and the chip **stays until the projection confirms the exit**.
- While plan mode is effective the composer textarea placeholder switches to the plan task hint (README: `describe your task to generate plan`), unless the owning surface supplies its own placeholder. Accessibility description: `plan mode 已开启，按下关闭` / `Plan mode on, press to turn off`.
- Limits: plan mode is **guidance, not an execution sandbox** — read-only enforcement needs a separate sandbox and approval policy; the badge belongs to the **default** composer and is temporarily replaced by a whole-composer pending interaction (such as a plan review); there is **no inactive plan control** on the tool row.

## 3.11 Agent preset (`dsh-client-ui-agent-preset`)
- Surfaces: a **new-session chip** (opens with the deployment default and stages a choice for the next blank session; the staged value is cleared once used), a **session-title label**, and a **settings section** managing the roster.
- Presets are fixed at session creation; changing the choice or the default only affects sessions created afterwards.
- Roster cards: the copy dialog is the **only** way to create a preset (the browser never edits assembly text); every custom card keeps a "open the preset's own file" location action; the default can be set from either surface; delete removes the preset directory while sessions already assembled from it keep running. Shipped presets open in a **read-only viewer** with no location or delete.
- A roster row carrying `broken` renders as a flagged card with body and copy disabled ("a copy of a broken preset is just another broken preset"); broken custom rows keep location and delete so the file can be fixed and the ghost directory cleared. The card front still shows the preset's own description, the host's reason hangs on the badge as a hint line, plus a visually hidden `alert` for assistive tech.
- Refused staging shows a transient banner above the composer column (the chip label has already bounced back).
- If the deployment ships no presets, these controls stay hidden and every session uses the host assembly.
- Limits: presets without metadata are listed **by id** (display text is optional; unnamed copies deliberately fall back to the directory name); the shown path is **text, not a link** when the host has no desktop opener; assembly edits made outside the browser are invisible to the page — the roster re-reads only on its own operations, `settings/changed`, and `connection/reset`.

## 3.12 Open In… (`dsh-client-ui-open-in-app`)
- Session-header split button: the primary button opens the session's workspace directory (`cwd`) in the remembered app; the chevron lists every directory app the host detected. Persisted choice key: **`dsh.open-in-app.choice`**; a no-longer-installed choice falls back to the first available entry.
- Primary label/icon: the remembered app's real icon (macOS bundle icon, Windows executable icon, Linux theme icon) or a generic placeholder; tooltip `在本地打开` / `Open locally`; `open.title` `在 {app} 中打开工作目录`.
- Busy/error: a completed launch does **not** change the button's appearance — the dimmed waiting state appears only after **250 ms** in flight; a failed launch shows an error tooltip and a red outline for **2 s** (`open.error` `打开失败` / `Failed to open`).
- Menu labels `访达`/Finder, `文件资源管理器`/File Explorer, `文件管理器`/Files, `终端`/Terminal; `menu.toggle` `选择打开方式`, `menu.aria` `打开方式` / `Open in`.
- Limits: the dictionary gates the menu — a host catalog entry with no `app.<id>` entry in both dictionaries stays invisible rather than showing a bare id; **availability is read once per page**, so an app installed while the page is open needs a reload (and a host restart).

## 3.13 Approval & question takeovers of the composer
- `conversation.composer` is a generic **chain** slot whose owner currency is `{ sessionId, session, pendingInteraction }`; a selector is required and entries are tried **ascending priority then registration order**, the first non-null wins and arrives as `matched`; all-null falls through to the shipped composer bar. **With no Session the chain is not consulted at all** (`fallbackOnly: sessionId === undefined`). The shell keeps the default composer **mounted beneath** a takeover.
- Shipped occupants: **approval** `select: pendingInteraction instanceof PendingApproval`, `priority: 1`; **user-questions** `select: pendingInteraction instanceof PendingQuestion`, no priority declared; **subagent** `select: selectReadOnlySubagent`, `priority: -10` (returns `{reason:'one-shot'}` for a one-shot child; `null` when `parentAvailable !== false`; `{reason:'parent-unavailable'}` only when the child is **not** running).
- ⚠️ **A question displaces an approval**: approval declares precedence `() => 0` while user-questions declares `1` (or `2` for the plan-review card), and only **one** pending interaction is published per session — the highest precedence wins, ties going to the later domain.
- The default priority when omitted **could not be determined**: the election lives in `SlotCore` (`@deepseek-ai/dsh-client-ui-slots`), which is **not installed anywhere in this tree** (only referenced from `dsh-client-ui-renderer/lib/client.js:954`).
- Composer blocks (`ComposerBlock { reason: string }`, `ctx.conversation.blocks`) are the generic mechanism for "this session's composer is inert, here is the localized reason" — model-selection uses it for an unroutable session (`当前模型不可用，请先选择模型` / `This model is unavailable — select one to continue`), rendered as `blocked` + `placeholder` by `ui-conversation`.
- The subagent read-only takeover replaces the composer with a centred frame (min-height 54 px, radius 14 px, `margin: 0 24px 20px`, `role="status"`): `一次性子代理记录` / `One-shot subagent record` + `一次性任务不支持后续消息，可在这里查看完整执行记录。` / `One-shot tasks do not accept follow-ups; review the full execution record here.`, or `此子代理暂时只读` / `This subagent is read-only for now` + `父会话当前不在线，重新打开父会话后即可继续发送消息。` / `The parent session is offline; reopen it to continue sending messages.`

## 3.14 Context meter (composer dock)
`dsh-client-ui-conversation/lib/client.js:15328-15530`. Renders **`null` until a provider reports both pressure and a route capacity**.
- `usedTokens = pressure.projectedTokens ?? pressure.pressureTokens`; `percent = min(100, round(usedTokens / contextWindow * 100))`.
- Ring: `14px` viewBox, radius `5.5`, stroke 2, `stroke-dasharray = [C*percent/100, C]`, rotated −90°.
- Trigger `aria-label = context.aria` = `上下文已用 {percent}%` / `{percent}% of context used` — the template is split on a `"\0"` marker so each locale owns its own word order.
- Panel: `role="dialog"`, `aria-label = context.used` (`上下文已用` / `of context used`), `width: 264px`, positioned `bottom: calc(100% + 8px)`, `z-index: 100`. Header shows `~{used} / {window}` compact. A 4 px segmented bar with `gap: 1px`, `margin: 10px 0 12px`, each segment `min-width: 2px`, **scaled by `percent * rowTokens / total`** (or one `total` segment at `width: percent` when the breakdown is absent/zero). Legend rows in fixed order `context.system` → `context.tools` → `context.messages` with tints `--dsw-static-neutral-bluish-400`, `#a78bfa`, `--dsw-static-blue-450`; each value prefixed `~`.
- Closes on outside `pointerdown` or Escape.
- **There are no thresholds, no percent-based colours and no warning state** — the fill is `--dsw-alias-label-tertiary` at every percent; the only state is panel `open | closed`.

---

# 4. Explicit non-goals / limitations (「已知限制」)

Collected verbatim-ish from each README's *Known limitations and deferred work* section:

**`dsh-client-ui-renderer`**
- **应用首帧会等待全部客户端 entry** — the boot kernel hands over the mount point only after the loader roster settles; per-region readiness remains deferred.
- **slot 渲染没有 Suspense 集成或逐 entry 惰性加载** — the complete plugin roster settles before the renderer mounts the root.

**`dsh-client-ui-chat`**
- **transcript 只反映已加载的 Session 窗口** — earlier nodes appear only after Session Controller loads the preceding page. Turn navigation is wider than the window (rail merges loaded Turns with `turnOutline`; each started Turn gets a fixed-pitch mark, 10 px apart; a taller ladder scrolls inside its frame with gradient fades); activating an unloaded mark pages history through that Turn's `turn/start` seq first. Without the projection the rail falls back to loaded Turns only.
- **导航预览按卡片尺寸截断** — one prompt line (50 characters) and up to three response lines (120), on loaded and unloaded Turns alike; an unloaded Turn's response arrives from the outline only once the Turn settled, so an open Turn previews its prompt (or just the Turn number) until then.

**`dsh-client-ui-conversation`**
- **只有已注册 target 可以渲染** — the shell deliberately has no implicit fallback target beyond the registered `chat` preference.

**`dsh-client-ui-tool`**
- **Host 不把 `run_code` 暴露为 PTC mode 程序 binding** — production events produce **one dispatch level**; the recursive Runtime/UI contract supports nesting but it is not exercised.
- **第一方工具视图集中在本包** — they *can* migrate to their owning business packages independently via the keyed slot; today they are colocated.
- **工具文案复用 `ui-conversation` locale namespace** — tool titles, row chrome and Cordis-free primitive labels use that dictionary; presenter models keep locale keys or data rather than rendered wording.

**`dsh-agent-tool-presentation`** (model-plane only — no UI half exists in this package)
- **运行时仍在宿主平面** — a preset can select PTC mode but cannot supply the TypeScript runtime it needs; a deployment composing none can compose no `ptc` preset.
- Required field table: `mode` is **required**, values `native` | `ptc` | `both`; `ptc` presents only `run_code` plus a generated SDK and the rule that only `run_code` may be called directly; `native` presents every schema as a function definition. **One agent declares one presentation; a second declaration in the same composition is refused, not merged.**

**`dsh-client-ui-trajectory`**
- **进行中时 Time 保持空白** — `partial` and `runningCalls` rows show a running state but never invent a duration, so the Overview renders only a start mark and never a live span. This is enforced structurally: the record's duration field is `timeSeconds: number | null` and the panel renders nothing for `null`. Record and timeline selection live inside Trajectory; **no anchor deep links**.

**`dsh-client-ui-plan`**
- **Plan 模式是引导而非执行沙箱** — enforcing read-only planning needs a separate sandbox and approval policy.
- **徽章属于默认 composer** — a whole-composer pending interaction (e.g. plan review) temporarily replaces the InputBar and its badge.
- **无未激活 plan 控件** — entry uses the shared Command source; a capable-but-inactive session shows no plan entry on the tool row.

**`dsh-client-ui-goal`**
- **Host 状态与 preset 无关** — switching an active session to `minimal` keeps the Host-owned goal; `/goal` and the goal tools disappear but the strip can still edit/pause/resume/clear.

**`dsh-client-ui-jobs`**
- **行是只读的** — a job's streaming output and human-initiated interruption are separate stages. Interruption additionally owes an unanswered model-facing decision: `kill()` marks the terminal delivery as already reported, so an interrupt written to the current contract leaves the model believing its job is still running.
- **列表不等于注册表自己的集合** — it shows what one session can see over the wire, so jobs owned by another session never appear; a process restart empties the list while the `run_in_background` cards that started those jobs remain in the transcript. **Ownerless jobs** (started with no live `Agent`) conversely appear in *every* session's list, consistent with what `list(caller)` reports.

**`dsh-client-ui-subagent`**
- **目录没有持久化结果** — activity and timing cannot distinguish completion, failure or cancellation, and the UI exposes no Activation identity; stop capability is limited to the current-turn Stop on the editor for a running continuable child.
- **`@` 引用仍是显示标题文本** — duplicated or renamed labels are ambiguous, so they deliberately get no continuation semantics.

**`dsh-client-ui-workflow-run`**
- **只有经 `dsh-tool-workflow` 发起的顶层调用会生成这些记录** — nested PTC-mode calls and direct `WorkflowEngine` consumers do not.
- **导航刻意只面向实时运行** — terminal members stay for review, but the node never offers a cold Session entry.
- **节点只显示运行、阶段、成员身份与状态** — scripts, outputs, errors, logs, usage, static topology and control operations are all outside this UI.

**`dsh-client-ui-deliverables`**
- **提及匹配只认精确路径或唯一 basename** — suffix mentions stay inert until real closing-message shapes demand loosening.
- **终端创建的文件需要显式交付** — call `present` to declare a file so native open works.
- **声明不保存文件内容** — after reopening or transferring a Session the source file must still be reachable from the currently viewed Session filesystem; missing file, directory, or symlink final path returns 404.
- **目录没有打开目标** — a chip opens a file in the right Sidebar's text preview, which is file-only and offers no native folder-open action.

**`dsh-client-ui-skill`**
- **仅含工具结果的 history 页使用通用行** — keyed dispatch requires the paired tool call to be inside the Runtime window; when paging leaves the call outside, the result has no tool identity. This client presentation feature will not extend the history protocol to recover it.
- **文本是唯一依据** — a reference is ordinary draft text; the same token typed by hand is the same reference, and the host gesture boundary judges the emitted text, not the menu interaction. Chip visuals come from a lexicon scan; there is **no occurrence identity, position tracking, or structured reference payload** in the prompt protocol.
- **预热落定之前打开的菜单** — no skill candidates appear on that keystroke; the next keystroke re-polls the settled cache.

**`dsh-client-ui-commands`**
- **脱离会话后，分离结果 notice 回退到 console** — the fire-and-forget path delivers results to the triggering composer via `SessionInput.notify`; once the session is destroyed, console output is the only surface left.

**`dsh-client-ui-reference`**
- **候选失败有意保持静默** — when a Remote discovery call is unavailable or fails, that domain simply produces no candidate rows. Session-reference preparation failure happens after prompt acceptance and terminates the agent turn.
- **浏览器侧不扫描文件** — Web completion needs a mounted host `ctx.fileReferences` provider; the browser cannot fall back to its own filesystem.
- **会话搜索仍仅使用元数据** — discovery filters by session id, cwd and the log-backed latest title; **it does not search message bodies or full transcripts**.

**`dsh-client-ui-attachment`**
- **灯箱无缩放与下载** — the preview renders the original only at a viewport-fitting size.
- **灯箱不锁定焦点** — it sets `aria-modal` and returns focus on close, but Tab can still move to the page behind it.

**`dsh-client-ui-message-feedback`**
- **备注大小是宿主策略** — deployments configure `maxNoteBytes` (8192 in the Web bundle); over-long notes are rejected by the host with `note-too-large`. The dialog does not pre-validate, so an over-long message description fails **at submit**, not while typing; Session-level notes have no cap.
- **无跨标签页推送** — a rating from another tab is visible only after reconnect or the next conflict response; the controller does not consume feedback-log events.
- **仅限对话视图** — trajectory and waterfall views do not render feedback controls, although their assistant nodes carry the same `messageId`.

**`dsh-client-ui-user-questions`**
- **未提交草稿的生命周期限于当前页面与 Session** — Session navigation preserves drafts while the Session scope stays on the page; a full page refresh, a pruned Session, or a pending request re-delivered with a new local identity starts from an empty draft. The store **never writes drafts to the host, `localStorage`, or disk**.
- **每次只有一个请求拥有编辑器** — later pending requests stay in the conversation snapshot and appear after the earlier one settles.

**`dsh-client-ui-approval`**
- **The panel exposes transient decisions only** — it supports allow-once and reject; persistent permission policy remains owned by Host-side approval packages.

**`dsh-client-ui-model-selection`**
- **无创建期或已寻址 subagent 选择** — both entries require an existing ordinary session's agent; there is no draft-time model selection folded into session creation, and continuable subagents deliberately expose no separate model-selection affordance.
- **目录名仅供呈现** — selection and persistence use provider/model/effort ids; a provider whose catalog or exact-model metadata query fails is listed as a non-selectable failure row and stays so until reload.
- **不能任意输入推理强度** — the composer only offers the efforts the exact model publishes; when the adapter carries no reasoning metadata there is no Effort row at all.

**`dsh-client-ui-permission-presets`**
- **设置行仅限 Web** — non-Web clients can still switch the current session through `/permission` but do not get this browser contribution.
- **预设描述来自宿主** — a description written in the other language may sit beside the localized built-in label.

**`dsh-client-ui-schedule`**
- **仅含活动记录** — terminal delete and dispatch transitions remove the row; the ordinary transcript remains the only reminder-delivery history.
- **浏览器派生时间** — local and relative time labels use the viewer's browser locale, timezone and clock; they are presentation values, not durable Schedule facts.
- **只读界面** — creating and deleting reminders remains the Schedule tool's job; the catalog has no mutation, Retry, acknowledgement, Toast or delivery-receipt semantics.
- **要求 Session 打开成功** — on an open failure it hides even when a tentative cached value exists, because strict Session replay is still authoritative.

**`dsh-client-ui-input-trigger`**
- **只有全局 source 层** — per-session source registration (per-session shadowing) is designed but not enabled; the ledger records the trigger condition, namely a real per-session source need.
- **`InputTriggerCandidate.icon` 以文本渲染** — `MenuView` puts that string straight into the icon slot; wiring the design-system icon enum waits on that enum shipping.
- **overlay 的 SlotMap 合并归属与槽位所有权分离** — the single `conversation.input.overlay` merge lives in this package while ui-conversation owns the anchor, children declaration and lifecycle, because the dependency direction is ui-conversation → ui-input-trigger.

**`dsh-client-ui-agent-preset`**
- **没有元数据的 preset 按 id 列出** — display text is optional; unnamed copies deliberately fall back to the directory name instead of looking identical to their source. Resolution is the shared `presetDisplayText` pure function from `dsh-agent-presets/display`.
- **展示的路径是文本，不是链接** — with no host desktop opener the card shows the directory for manual copying; the browser cannot open a location on the host filesystem itself.
- **组装编辑对页面不可见** — files are edited outside the browser and no file-change is broadcast, so the roster re-reads only on its own operations, `settings/changed`, and `connection/reset`.

**`dsh-client-ui-open-in-app`**
- **词典把守菜单** — a new host catalog entry with no matching `app.<id>` in both dictionaries stays invisible rather than showing a bare id; extending the catalog means extending the host package and this package's locale together.
- **可用性每页只读一次** — an app installed while the page is open appears only after a page reload (plus a host restart on the host side).

**`dsh-client-ui-cordis`**
- **已展开的面板看不到「不广播任何东西」的注册表变化** — `cordis_define`, and undefined a non-running definition, change the registry without an announcement, so an expanded panel keeps stale rows until it is collapsed and reopened. Run requests are the exception: they block the model, so they render their own row and trigger a read.
- **只有请求、没有清单的行可应答但不可操作** — it offers approve and decline only, because run/stop controls need registry rows the read has not delivered.
- **行可能消失一次读取的时长** — an orchestrating arm carries a session but deliberately no label, so an approved request whose registry read has not landed has no row until it does; in practice the read is triggered when the request arrives.
- **渲染失败是本页自己的读数，而且它来得太晚、赶不上 run 的回执** — the panel shows the last crash *this* page saw, so a package rendering fine here while crashing in another tab shows nothing here; the model can only learn by asking (`cordis_inspect_self`).
- **某一页的装载失败对其他页不可见** — the host settles one dispatch on the first load report, so a page whose browser half fails after another page confirmed still reads as running elsewhere.
- **任何页面都可以应答任何请求** — approval is frame-wide by design; narrowing "who may answer" is deferred.
- **call head 掉出事件窗的卡片会丢掉标签** — the define card takes name and purpose from the call arguments, so a session long enough to truncate them leaves the card naming itself only by call id; the panel is unaffected because the host inventory carries the labels.

**Cross-cutting limitation observed but not in any README:** `dsh-client-ui-chat`, `-conversation`, `-trajectory` document no client-side cost/money display — only token counts exist.

---

# 5. What depends on DSH-specific backend data (unreproducible without a matching backend)

Flagged by how strongly another product would need an equivalent server-side contract.

### 5.1 Hard dependencies — the block type only exists because DSH's session model emits it

| Rendered thing | Backend contract required | Evidence |
|---|---|---|
| `turn-process` folding | `turn/start`, `turn/end`, `step/start`, `step/end`, plus `assistant/message` with `surfaceOp: "append"` and a `finalNode` marker on the last step. The entire "final-answer boundary" rule is computed from those. | `dsh-client-ui-chat/lib/client.js:6700-6860` |
| `system-prompt` row | `system/message` events, `request/header` events, and the loaded-window/page ordering that lets `inspectSystemPrompt` pick "the last nonempty surviving system node in surface order". Without `request/header` + surface-order paging the row cannot be placed correctly. | `dsh-client-ui-conversation/README.md` L34; `dsh-client-ui-chat/README.md` L31 |
| `context` rows with typed forms | `source` payload carrying a producer-declared form (`instructions`/`catalog`/`snapshot`/`notice`/`relay`/`recall`) and its structured fields. Unknown forms degrade to opaque text, so a product without this simply loses the cards. | `ContextBody.d.ts`, `dsh-client-ui-chat/lib/client.js:772-815` |
| `compaction` marker | `compaction/summary` event + a replacement `user/message` checkpoint + `shadowedItemCount`/`shadowedTokenCount`. | `records.d.ts:183-197` |
| `model-retry` | `llm/retry` and `llm/retry-started` events; the `scheduled/started/cancelled` lifecycle is client-derived from them. | `records.d.ts:111-125`, `dsh-client-ui-chat/lib/client.js:7049` |
| Turn-usage row | Every started model attempt must report **safe, exact** usage per step; the parser's strictness is defined entirely by DSH's `step/start` → `assistant/attempt` → `turn/end` sequence. | `deriveTurnTokenUsage`, `:7007+`; `README.md` L36 |
| `sessionStats` / `tokenUsage` / `todos` / `schedule` / `turnOutline` projections | DSH **session projections** delivered over `session/projection` frames, seeded from the history tail page. `StatsPills` says plainly that the durable whole-log projection is authoritative and the window fold is only a fallback. | `StatsPills.d.ts` doc comment; `dsh-client-ui-goal/README.zh.md` L46 |
| `jobsBySession` mirror | Session Controller folding of `session/jobs` frames; the client issues **zero RPC** and reads the mirror. | `dsh-client-ui-jobs/README.zh.md` L42 |
| Subagent catalog | `subagentsByParent`, per-child `origin: "subagent"` / `parentId` / `mode` / `activity` / `subagentTiming` / four disjoint `tokenUsage` buckets, plus `ctx.sessions.list` and `subagents/interruptByParent`. | `dsh-client-ui-subagent/lib/client.js:60-113`, `:171-179` |
| Workflow-run node | Four durable `tool-workflow/*` events (`run-start`, `agent-start`, `agent-end`, `run-end`) keyed by `runId`, plus `member.phase` grouping. | `dsh-client-ui-workflow-run/lib/client.js:571-615`; README.zh.md L88 |
| Deliverables | `write`/`edit`/`str_replace_editor` call arguments as the vocabulary **plus** a `present` tool with `files: [{path, description?}]`, plus host routes `/api/present.open` and `/api/present.host` returning `{name, available, fileManager}`. | `dsh-client-ui-deliverables/lib/index.js:4-6,125` |
| `skill` row + `/name` invocation | A host `skill` tool whose result text is the rendered skill body, and a `skills/list` remote with `modelInvocable`. | `dsh-client-ui-skill/lib/client.js:281-312` |
| Session references | `sessionReferenceResolver/candidates` + an `agent/pre-step` validator that captures model context; the canonical `@[label](dsh-session:…)` mention. | `dsh-client-ui-reference/README.zh.md` L34 |
| File references | A mounted host `ctx.fileReferences` provider; the browser cannot scan files. | `dsh-client-ui-reference/README.zh.md` L91 |
| Attachments / images | `session.attachment` reads, a session-authorized `imageUrl(sessionId, attachment)` cache, staged file receipts, and two concurrent Worker upload transports (`maxConcurrentFileUploads` default 2). | `dsh-client-ui-conversation/README.md` L12, L49 |
| Approvals | An **Agent-scoped Remote Event waterfall** carrying `{toolName, callId?, reason?}` with a result promise the listener resolves; `kind: "approval"` participates in the Session pending-interaction model. | `dsh-client-ui-approval/lib/client.js` `PendingApproval` |
| User questions | A host pending-question table with `ASK_CANCELLED`, question `intent`, options with labels, and an answerer waterfall; the `plan-review` intent is set by the host plan-mode package. | `dsh-client-ui-user-questions/README.zh.md` L36, L54 |
| Feedback | `messageFeedback.list/put/retract` with version CAS + `version-conflict`, `sessionFeedback`, host `maxNoteBytes`; ratings are **log-only** events that never enter model context. | `dsh-client-ui-message-feedback/README.zh.md` L44, L79 |
| Command directory | `command.list({sessionId})`, `command.execute`, a forwarded `commands/change` owner event, and per-command `input` / `input.attachments` declarations. | `dsh-client-ui-commands/README.zh.md` L46 |
| Model selection | `session.models` / `session.selectModel` / `llm/adapters-updated`, a `ModelDirectory` per session, and a **composer block** for an unroutable session. | `dsh-client-ui-model-selection/README.zh.md` L46 |
| Permission presets | A `permissions` projection + a `permission` settings descriptor + a confirmation payload shape, plus the host `/permission` command whose arguments carry the preset. | `dsh-client-ui-permission-presets/README.zh.md` L46 |
| Plan chip | A host-computed plan-mode projection where the effective target is `pending ? !active : active`, plus `/plan off` as a command. | `dsh-client-ui-plan/README.zh.md` L46 |
| Agent preset surfaces | `agentPresets/list|read|copy|deletePreset`, `settings/openAgentPresetDirectory`, and a settings `agent-presets.default` field. | `dsh-client-ui-agent-preset/README.zh.md` L46 |
| Open In… | `dsh-host-open-in-app` host routes for availability, real app icons and launch. | `dsh-client-ui-open-in-app/README.zh.md` L12 |
| Cordis panel & cards | `cordis/dynamic-package`, `cordis/dynamic-retract`, `cordis/request-run`, `cordis/request-run-resolved` announcements + a host inventory read + a `tool.view.cordis` business slot. | `dsh-client-ui-cordis/README.zh.md` L77 |
| Schedule | The `schedule` projection and the host Schedule overlay; **disabled by default in the shipped Web graph**. | `dsh-client-ui-schedule/README.zh.md` L12 |
| `openFile` / `inspect` routing | A right-Sidebar text preview target and a trajectory target; tool cards route `openFile` to the sidebar and `inspect` to the trajectory view. | `dsh-client-ui-tool/README.md` L65 |
| Trajectory | Whole raw Session window + `turnOutline` + paging through `turn/start` seq + `compaction/summary`. | `dsh-client-ui-trajectory/README.zh.md` L12 |

### 5.2 Soft dependencies — a product could approximate these
- **Tool cards** need only `tool/call` + `tool/result` with `name`, `argsRaw`, `content`, `isError`, `error{name,code}`, `meta`, `parentCallId`. A product could keep the card layout and drop the structured `meta` (web search `sources`/`truncated`, image metadata), falling back to the generic flattened row.
- **`present`** could be replaced by "the product's own deliverable tool", but the clickable-file UX and the native-open menu need host file/desktop access.
- **`skill`** could be any tool whose result is text and whose args carry a `name`.
- **Todo panel** needs a `todos` projection with `{content, status: completed|in_progress|pending}`.
- **Turn time panel** needs only `turn/start` + `turn/end` timestamps and per-step `timing` fields.

### 5.3 Package-level dependency notes
- **`dsh-client-ui-renderer` is not a block registry.** Despite the task description, its README (`README.md` L12, L28-36) is entirely about mounting the assembled React app: `ctx.uiRenderer.mount(container)`, `createSlotRenderer()`, `BootHandoff`, and the `useSyncExternalStore` adapter. It contains **no block kinds, no icons and no labels** (0 CJK characters in its bundle). The block/registry layer is `dsh-client-ui-conversation` + the keyed `conversation.chat.node` slot in each target package.
- **`dsh-agent-tool-presentation` has no UI half.** Its entire source is 40 lines of `lib/index.js`: a `Config` schema with `mode: native|ptc|both` and an `apply` that calls `ctx.tools.presentAs(mode)`, waiting on `ctx.codeRuntime` for PTC. Its "presentation" is *which tools the model sees*, not how a call renders. The UI half of tool presentation is `dsh-client-ui-tool`.
- **`dsh-client-ui-plan` is not the todo/plan transcript surface** — it is only the plan-mode composer chip. The todo panel is a composer-dock card in `dsh-client-ui-conversation`, and the `todo_write` tool row is in `dsh-client-ui-tool`.
- **`dsh-client-ui-subagent` has no transcript row.** Subagent spawns appear as ordinary `tool-call` nodes; the catalog, the read-only composer and the `@` source are all header/composer chrome.
- **`dsh-client-ui-ui-primitives` is not shipped as a separate package** in this install. `StateDot`, `DisclosureRow`, `Tooltip`, `Modal`, `IconChecklistOutline14`, `IconCopyOutline16`, `FileTypeIcon`, `LinkIcon`, `MarkdownText`, `CodeBlock`, `JsonBlock`, `writeClipboard` etc. are inlined into each consumer's `lib/client.js` bundle; the READMEs link to `../ui-primitives/README.md` which does not exist on disk. Their internals (exact dot art, chevron rotation, disclosure ARIA, markdown truncation policy) could **not** be read from an installed copy.

---

# 6. Places where packages disagree, where code contradicts a README, or where two sources give different numbers

1. **`dsh-client-ui-tool` README vs the actual `TOOL_VARIANTS` table** — the README lists "running `str_replace_editor` `create`/`str_replace`". In the code there is **no `str_replace_editor` entry** in `TOOL_VARIANTS`; the table has `read`, `read_image`, `write`, `edit`, `run_code`. `diffCardModel` even returns `null` for a **settled** `str_replace_editor` call (`dsh-client-ui-tool/lib/client.js:299-310`), so it falls to the generic row. Treat the code table as authoritative.
2. **`dsh-client-ui-input-trigger` README vs the compiled `MenuView`** — the README says `InputTriggerCandidate.icon` is rendered **as literal text** ("`InputTriggerCandidate.icon` 以文本渲染 … `MenuView` 把该字符串原样放进图标位"), but the compiled code passes `item.icon` to `ReferenceIcon kind={…}`. The README is stale; the code is authoritative. The underlying limitation it *means* (the design-system icon enum is not fully wired) may still hold for unknown values.
3. **`dsh-client-ui-model-selection` README vs the compiled composer menu** — the README says "composer 菜单只显示模型与推理强度名称" (the composer menu shows only model and effort names), but the compiled menu **does** render the provider `group.name` as a group heading (`lib/client.js:694-701`); only the row labels omit descriptions.
4. **Attachment/image numeric limits — two different sets exist.**
   - Host defaults (`dsh-attachment-local/lib/index.js:888-896,993-998`): **20 MiB** per image, **20** images per message, **200 MiB** message total, **64e6** px, **8192** px dimension, media types png/jpeg/webp/gif.
   - Fixture/replay path (`dsh-client-connection/lib/client.js:3188-3200`): **5 MiB**, 20, **100 MiB**, **4e7** px, **2000** px, same media types.
   Which one is in force depends on whether the value came from the host `imageLimits` projection or from fixture replay. Also: client-side enforcement covers only **3 of 5** dimensions (count, per-image bytes, message total); pixel count and dimension are host-enforced.
5. **`dsh-client-ui-chat` README (EN) is physically truncated** — the EN sentence breaks at "a closed control sits 8px above its answer o…"; the zh text spells out the actual rule: **8 px only when no independent input intervenes** ("只有中间没有独立输入时，收起控件才与正文相隔 8px"). The zh is authoritative.
6. **`dsh-client-ui-plan` dead copy** — `chip.off.aria` and `chip.off.title` are declared in both dictionaries but **never referenced**; no "off" state is ever rendered (the seat is simply empty). Likewise `dsh-client-ui-open-in-app` declares `menu.aria` (`打开方式` / `Open in`) but never uses it — the chevron's accessible name is `menu.toggle` (`选择打开方式` / `Choose an app to open in`). And `dsh-client-ui-cordis` declares `panel.approvals.aria` and `action.approve` but never references them.
7. **`dsh-client-ui-jobs` count strings** — the zh `count.live.one` and `count.live.other` are identical (`{count} 个后台任务运行中`), as are the `idle` pair; only the EN distinguishes singular/plural. Not a conflict, but a translation asymmetry worth copying deliberately rather than by accident.
8. **"Block registry" premise in the brief** — neither `dsh-client-ui-renderer` (slot renderer, zero CJK, no `block` token) nor `dsh-agent-tool-presentation` (40 lines of `mode: native|ptc|both` + `ctx.tools.presentAs`) contains a per-message-kind block registry. The registry is the `ConversationNode` union + the keyed `conversation.chat.node` slot (§0).
9. **`dsh-client-ui-ui-primitives` does not exist as an installed package** — three separate subagents confirmed it. Its symbols (`StateDot`, `DisclosureRow`, `Tooltip`, `Modal`, `Button`, `Menu`, `JsonBlock`, `MarkdownText`, `CodeBlock`, `FileTypeIcon`, `LinkIcon`, `ReferenceIcon`, `RiskConfirmation`, `rankByName`, `fileSizeText`, `projectUserText`, `writeClipboard`) are inlined into each consumer's bundle and into `dsh-web-frontend/dist/assets/index-*.js`. Likewise `@deepseek-ai/dsh-client-ui-slots` is not installed, so `SlotCore`'s **default chain priority** could not be determined, and neither could the internals (chevron geometry, hit areas, tooltip timing, markdown truncation policy, clipboard fallback).

---

# 7. Quick reference — the complete literal string inventory

All in-scope packages' `zh`/`en` dictionaries were extracted mechanically into `/tmp/dsh-ui/locales.txt` (1 374 lines) so the reader can look up any exact label. A second working artifact, `/tmp/dsh-ui/B-render.md`, is this report.

**Locale resolution order** (every `t("…")` call): `active dictionary → en dictionary → the shared `common` namespace dictionary → the key itself`. Several packages deliberately call keys they do not own; those are flagged in §6.

The shared `common` namespace dictionary is at `dsh-client-locale/lib/client.js` (`ok`, `cancel`, `close`, `copy`, `copied`, `copy.failed`, `copy.value`, `copy.json`, `copy.path`, `copy.prettyJson`, `copy.compactJson`, `copy.optionsHint`, `retry`, `loading`, `load.failed`, `submit`, `submitting`, `next`, `previous`, `skip`, `delete`, `edit`, `save`, `search`, `more`, `collapse`, `expand`, `back`, `brand.localBuild`, `unknown`, `none`, `truncated`, `json.label`, `json.expandNode`, `json.collapseNode`, `markdown.footnotes`, `markdown.truncatedCharacters`, `number.thousand`, `number.million`).

Locale namespaces per package: `chat` (ui-chat), `conversation` (ui-conversation), `plan`, `goal`, `job`, `subagent`, `workflowRun`, `deliverables`, `skill`, `cordis`, `trajectory`, `question` (user-questions), `approval`, `model` (model-selection), `permission` (permission-presets; a second `settings.permission` block for the settings row), `schedule.catalog`, `slash.menu` (input-trigger: keys `command`/`skill`/`subagent`/`loading`/`drill.*`/`crumbs.aria`/`suggestions.aria`), `reference`, `open-in-app`, `agent-presets` (agent-preset), `common` (locale base).

**Cross-namespace calls worth knowing** (they resolve through `common`): user-questions calls `submit`, `submitting`, `copy`, `copied`, `markdown.footnotes`; message-feedback calls `close`, `submit`, `submitting`; model-selection calls `retry`; the permission settings row calls `close`.
