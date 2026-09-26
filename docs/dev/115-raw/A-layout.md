# DSH browser-window shell/layout — cloning reference (Report A)

Scope: **shell + layout half** of the DeepSeek Harness Web GUI. Read-only research; nothing outside `/tmp/dsh-ui/` was modified; no servers started.

Package root: `/home/deploy/.nvm/versions/node/v24.15.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`
All 15 assigned packages were inspected: their `README.md`, `README.zh.md`, `package.json`, and compiled `lib/client.js`.

### Source legend (used in every citation below)

| Short | File |
|---|---|
| **L-R / L-Z** | `dsh-client-ui-layout/README.md` / `README.zh.md` |
| **L-J** | `dsh-client-ui-layout/lib/client.js` |
| **SB-R / SB-Z / SB-J** | `dsh-client-ui-sidebar/README{,.zh}.md` / `lib/client.js` |
| **SR-R / SR-Z / SR-J** | `dsh-client-ui-sidebar-right/README{,.zh}.md` / `lib/client.js` |
| **FL-R / FL-J** | `dsh-client-ui-sidebar-files/README{,.zh}.md` / `lib/client.js` |
| **DP-R / DP-J** | `dsh-client-ui-sidebar-documentpreview/README{,.zh}.md` / `lib/client.js` |
| **WS-R / WS-Z / WS-J** | `dsh-client-ui-workspace/README{,.zh}.md` / `lib/client.js` |
| **SE-R / SE-J** | `dsh-client-ui-session/README{,.zh}.md` / `lib/client.js` |
| **TH-R / TH-Z / TH-J** | `dsh-client-ui-theme/README{,.zh}.md` / `lib/client.js` |
| **ST-R, SG-J, SM-J, SP-J, SI-J, BR-J** | `dsh-client-ui-settings/README`, `-settings-general/lib/client.js`, `-settings-models/lib/client.js`, `-settings-plugins/lib/client.js`, `-settings-plugin-inventory/lib/client.js`, `-brand-official/lib/client.js` |
| **WF** | `dsh-web-frontend/dist/{index.html,manifest.webmanifest,assets/*.css}` |

Two conventions the whole client follows, worth knowing before any number below:

- **Everything is a slot.** The shell renders exactly one slot, `root` (`L-R:28` "The root slot composes the sidebar, main content, and right column"). `root` declares four children: `sidebar` (kind `single`, scope `root`), `main` (kind `keyed`, scope `root`), `rightbar` (kind `single`, scope `root`), `shell.overlay` (kind `list`, scope `root`) — `L-J:524-546`. `conversation` is the reserved key of `main` (`L-R:30`).
- **Package CSS is CSS-Modules, injected at runtime.** Each module is a string in the compiled JS appended as `<style data-plugin="<pkg>" data-plugin-css="<pkg>/X.module.css">` to `document.head`; local class names get a per-module hash prefix, e.g. `.pI_x6G_sidebarCol`, `.hHd-Xa_newSession`, `.YDXeBa_sessionRow`, `.bhn1Oq_list`, `.VOzbGW_overlay`, `.P3OORG_panel`. If the other product wants a *pixel* clone it should re-derive these numbers, not these hashed names.

---

## 1. The regions of the window

### 1.1 Region inventory

| # | Region | Slot / owner | Contents | When it exists | Sizing / resizing | Collapsible |
|---|---|---|---|---|---|---|
| 1 | **Frame** | `root` → `AppFrame` (ui-layout) | CSS grid, 3 tracks `sidebar px / minmax(0,1fr) / rightbar px` | always | `height:100%`; `transition: grid-template-columns var(--ds-transition-duration-slow) var(--ds-ease-in-out)` | — |
| 2 | **Left column** | `sidebar` (single) | one occupant only: ui-sidebar | always mounted | track = `0→56px` rail, else `clamp(264,420)px` | yes (rail) |
| 3 | **Left drag handle** | inside AppFrame | 8px invisible grab strip | only while `!sidebarCollapsed` | `width:8px; margin-left:-4px; z-index:11; cursor:col-resize; touch-action:none` | — |
| 4 | **Center column** | `main` (keyed) | `conversation` key → ui-conversation; or a global panel | always | `minmax(0,1fr)`, may go to 0 in extreme narrow | no |
| 5 | **Right column (track)** | `rightbar` (single) | ui-sidebar-right's per-session dock surface | always in DOM; zero width unless occupant asks for a track | `0` or `clamp(300, viewport*0.45 first open)` capped at `viewport*0.70` | yes |
| 6 | **Right drag handle** | inside AppFrame | 8px grab strip | only `rightbarShown && !rightbarFullscreen && normal.rightbar > 0` | same 8px geometry, `left: viewport - rightbar` | — |
| 7 | **Overlay layer** | `shell.overlay` (list) | currently `ui-commands` (slash-command popup `popupSelect`) and `cordis-client-runner` | always in DOM | `position:absolute; inset:0; z-index:20; pointer-events:none`; children re-enable pointer events | — |
| 8 | **Sidebar brand row** | `sidebar.brand.mark` + `sidebar.brand.name` (two singles) | fish/official mark, wordmark, build badge, collapse toggle | always | 60px tall expanded / 36px collapsed | — |
| 9 | **Sidebar panel list** | `sidebar.panellist` (list) | global-panel icon rows; **empty in the shipped composition** (`L-R:30` "No global panel is registered by the shipped composition") | only if someone registers | rows `min-height:36px` / `36×36` collapsed | — |
| 10 | **Sidebar workspaces area** | `sidebar.workspaces` (single) | the whole workspace/session browser (ui-workspace) | always | flex:1, scrolls; `scrollbar-gutter:stable` | — |
| 11 | **Sidebar footer** | `sidebar.footer.action` (single) + `sidebar.settings` (single) | footer actions; Settings trigger row | always | fixed to bottom, `flex:none` | — |
| 12 | **Conversation header** | `conversation.session.header` + `.actions` / `.utilities` / `.lineage` / **`.corner`** | conversation's own header; `.corner` holds the right-sidebar expand button | with a session | conversation package | — |
| 13 | **Right dock panel** | ui-sidebar-right, portaled into right column | tab strip (whole top edge), tab body, floats | with a session | `position:absolute; top:0; bottom:0; right:0; transform:translate(100%)` when hidden | yes |
| 14 | **Right panel floats** | `rightbar` occupant, portal | floating tabs | on demand | `position:fixed; inset:0; z-index:60; pointer-events:none` host | yes |
| 15 | **Settings dialog** | `sidebar.settings` → modal in an overlay | nav rail + section content | only while open | full-viewport overlay `z-index:1000`; panel `800×min(800,100vh-48)` | closes |
| 16 | **Onboarding modals** | `settings.onboarding` (list) | first-run notice, API-key onboarding | hero/blank-session only | `Modal`, `min(600px,100%)` | closes |
| 17 | **Browser chrome** | ui-layout presenter + ui-theme | `<title>`, `<meta name="theme-color">`, `html{color-scheme}`, `body[data-ds-dark-theme]` | always | — | — |
| 18 | **Boot placeholder** | `dsh-web-frontend` `#root` | logo/spinner card shown before plugins load | until first paint of shell | `height:100%; display:grid; place-items:center` | — |

There is **no** separate status bar, no top menu bar, and no left "activity bar" beyond the 56px rail. `#root{height:100%;margin:0}` and `body{…}` are the only page-level rules (`WF` `assets/index-DPX2bQLO.css`).

### 1.2 The frame and its column solver (the single most important piece of code to clone)

`L-J:36-45`:

```js
function computeColumns(viewport, sidebar, rightbar) {
  const s = sidebar === 0 ? 56 : clampWidth(sidebar, 264, 420);
  const available = viewport - s - 400;
  const r = rightbar === 0 || available < 300 ? 0
          : Math.min(available, clampWidth(rightbar, 300, viewport * RIGHTBAR_MAX_RATIO));
  return { sidebar: s, center: Math.max(0, viewport - s - r), rightbar: r };
}
```

Constants (`L-J:13-17`): `SIDEBAR_AUTO_COLLAPSE = 1024`, `RIGHTBAR_MAX_RATIO = .7`, `RIGHTBAR_DEFAULT_RATIO = .45`.
Store defaults (`L-J:340-351`): `sidebar: 280`, `rightbar: null`, `rightbarShown/Track/Fullscreen/Instant: false`, `viewportWidth: window.innerWidth`.

Behaviours fixed by the solver:
- **Collapsed sidebar is 56px, not 0.** `L-R:28` "spans 264–420px, defaults to 280px, and retains a 56px rail when collapsed".
- **Center is protected at 400px**; the right panel concedes first: "the frame first reduces the right panel to 300px, then reports insufficient room so its occupant closes it, and only then compresses the center further" (`L-R:28`).
- **Below 1024px the sidebar auto-collapses**; a manual toggle below that sets `narrowExpanded` and *re-expands over the squeezed center* (`L-J:10-12`, `L-J:364-368`).
- **Opening the right panel collapses a manually expanded narrow sidebar** (`sidebar === null` case: `L-J:381`; `L-R:28`).
- **`openRightbar` clears `narrowExpanded`**, and after fullscreen exit the frame installs its destination geometry with transitions suppressed first (`L-R:46`; `L-J:379-392`).
- Widening never auto-reopens: "insufficient room causes a deterministic close, never automatic reopening on widening" (`L-R:46`).
- Viewport is measured off the **frame element**, not the window, with `ResizeObserver` + rAF throttle (`L-J:208-232`).

Frame CSS (module `AppFrame.module.css`, `L-J:71`), verbatim:

```css
.pI_x6G_frame{background:var(--dsw-alias-bg-base);height:100%;
  transition:grid-template-columns var(--ds-transition-duration-slow) var(--ds-ease-in-out);
  grid-template-rows:100%;display:grid;position:relative;overflow:hidden}
.pI_x6G_frame[data-dragging]{transition:none}
@media (prefers-reduced-motion:reduce){.pI_x6G_frame{transition:none}}
.pI_x6G_sidebarCol{background:var(--dsw-specific-sidebar-fill);
  border-right:.5px solid var(--dsw-alias-border-l3);min-width:0;overflow:hidden}
.pI_x6G_centerCol{flex-direction:column;min-width:0;display:flex;overflow:hidden}
.pI_x6G_handle{cursor:col-resize;z-index:11;touch-action:none;width:8px;
  transition:left var(--ds-transition-duration-slow) var(--ds-ease-in-out);
  margin-left:-4px;position:absolute;top:0;bottom:0}
.pI_x6G_rightbarCol{min-width:0;position:relative;overflow:visible}
.pI_x6G_overlayLayer{z-index:20;pointer-events:none;position:absolute;inset:0}
.pI_x6G_overlayLayer>*{pointer-events:auto}
```

Frame data attributes set by the component (`L-J:281-285`) — a clone can reproduce the whole state machine with these: `data-sidebar-collapsed`, `data-rightbar-collapsed`, `data-rightbar-fullscreen`, `data-rightbar-instant`, `data-dragging`.

Drag handles: left-button only, `setPointerCapture`, rAF-throttled dx against the drag-start origin, `onPointerUp` commits a final `onDrag` then ends (`L-J:133-202`). Left handle writes `sidebarBase + dx`; right handle writes `rightbarBase - dx` (`L-J:253-262`).

**`ctx.layout` API** (the only cross-package surface; `L-J:399-439`):

| Method | Effect |
|---|---|
| `selectPanel(id)` | selects a registered `main` key; `null` returns to Conversation. Unknown id **throws** and leaves the current panel intact (`L-J:413`). |
| `beginNavigation()` | returns a fresh `AbortSignal`, aborting the previous one; does **not** cancel session creation (`L-R:44`). |
| `toggleSidebar()` | closed ⟷ contract default (280). |
| `openRightbar(track, fullscreen)` | reports the right panel's presentation. |
| `closeRightbar()` | reports hidden: no track, no handle. |

### 1.3 Overlays and layering (all hard-coded z-indexes)

`L-J:71` frame internals `z-index:11` (handles) / `20` (overlay layer); `SR-J` right panel `10` normal, `40` fullscreen, `60` float host; `SG-J` settings overlay `1000`. `SR-R` states the reason plainly: "**Hard-coded stacking.** The panel and the float host use fixed z-index values because the client has no z-index token layer yet."

### 1.4 Browser-level chrome

- `index.html`: `<div id="root">`, `<title>DeepSeek Harness</title>`, `<link rel="manifest">`, `favicon.svg`, viewport meta (`WF`).
- `manifest.webmanifest`: `name` "DeepSeek Harness", `short_name` "DSH", `display` **fullscreen**, `id`/`start_url`/`scope` `/` (`WF`).
- Document title logic (`L-J:55-68`): `document.title = title === undefined ? productTitle : \`${title} — ${productTitle}\``, where `productTitle` is the literal `"DeepSeek Harness"` (`L-J:263`) and `title` is the selected session's title, used **only while the Conversation is shown**. Unmount restores `productTitle`.
- `ThemePresenter` (`L-J:443-492`): sets `document.documentElement.style.colorScheme`, toggles `body[data-ds-dark-theme]`, sets `--dsh-content-font-size`, replaces the previously-applied token variables (it keeps `appliedTokens` as its retraction set), then reads `getComputedStyle(body).backgroundColor` into an owned `<meta name="theme-color">`. Dispose retracts every one of those writes.
- Build-time badge in the sidebar: `version[-commit][-dirty]` assembled from `DSH_CLIENT_VERSION`, optional 7-char `DSH_CLIENT_COMMIT_HASH`, `DSH_CLIENT_GIT_DIRTY=true`; no badge when version metadata is missing (`SB-Z:32`).

---

## 2. The left sidebar in detail

Owner: **`dsh-client-ui-sidebar`** is only the *shell*; the tree inside is **`dsh-client-ui-workspace`**. That split is an explicit limitation: "**Workspace browser behavior is composition-owned** — grouping, ordering, search, and row state belong to ui-workspace, not this shell" (`SB-R`).

### 2.1 Slots the sidebar publishes

| Slot | Kind | Occupant in shipped composition |
|---|---|---|
| `sidebar.brand.mark` | single, root | `ui-brand-official` → `FishLogo` (only when `DSH_CLIENT_BUILD_PROFILE=official`) |
| `sidebar.brand.name` | single, root | `ui-brand-official` → `BrandWordmark({includeMark:false})` |
| `sidebar.panellist` | list, root | nobody (no global panels shipped) |
| `sidebar.workspaces` | single, root | `ui-workspace` browser |
| `sidebar.workspaces.directoryFlow` | single, session | directory-picker `-native` or `-browse` |
| `sidebar.settings` | single, root | `ui-settings-general` SettingsRoot |
| `sidebar.footer.action` | single, root | — |

Brand fallback when the mark/name slots are empty: "the shell uses the fish mark and the localized local-build label" (`SB-Z:32`); locale key `common.brand.localBuild`.

### 2.2 Panes / tabs

There are **no tabs in the left sidebar**. The left sidebar is a vertical stack: brand row → global-panel list → workspaces region (flex:1, the only scrolling area) → footer (footer actions + Settings). The *tab* UI lives in the **right** sidebar (see §3). The left sidebar's "panes" in the user's sense are the **workspaces groups** produced by ui-workspace.

Sidebar locale dictionary — the whole thing (`SB-J:309-324`), zh is the key-set source of truth:

| key | 中文 | English |
|---|---|---|
| `session.new` | 新会话 | New Session |
| `session.new.label` | 新建会话 | New session |
| `toggle.open` | 打开侧边栏 | Open sidebar |
| `toggle.collapse` | 收起侧边栏 | Collapse sidebar |
| `panels.label` | 全局面板 | Global panels |

### 2.3 Left-sidebar geometry (from `SB-J` CSS)

- Root: `padding:6px var(--dsh-sidebar-inline-padding)` with `--dsh-sidebar-inline-padding:12px`; `font-size:14px`; `background:var(--dsw-specific-sidebar-fill)`; `color:var(--dsw-alias-label-primary)`; scrollbar rebound to the **l2** tokens (`--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2)`).
- Collapsed root padding: `18px 10px 6px` → content width = 56 − 20 = **36px**, which is exactly the collapsed control size.
- Brand row: `height:60px; margin-bottom:8px; padding:8px 0 8px 4px; gap:8px; justify-content:flex-end`; collapsed `height:36px; margin-bottom:12px`.
- Brand name: `height:24px; font-size:18px; font-weight:600; line-height:24px; letter-spacing:.04em`. Fallback brand name `17px`. Local-build brand is a 24px two-line block, title `12px/13px`.
- Build badge: `height:10px; font-size:6px; line-height:10px; font-family:var(--ds-font-family-code); border-radius:2px; padding:0 3px`.
- Icon buttons: `28×28; border-radius:50%` (`corner-shape:round`), collapsed `36×36`.
- **New Session button**: `height:38px; border-radius:12px; border:.5px solid var(--dsw-alias-border-l3); background:var(--dsw-alias-button-elevated-fill); margin:0 2px 8px; padding:8px 16px; gap:6px; font-size:14px; font-weight:500; line-height:22px`; hover `--dsw-alias-button-floating-hover`; collapsed → 36×36, transparent, no border.
- Panel row: `min-height:36px; border-radius:8px; padding:7px 8px; gap:8px; line-height:22px`; active `--dsw-alias-interactive-bg-active` + weight 500; focus-visible `outline:2px solid var(--dsw-alias-label-primary); outline-offset:-2px`.
- Motion: expand fade-in `.2s`; collapse "expanded content fades at its current width, the controls above share one fade-and-slide **49px** leftward into the 56px rail" (`SB-Z:40`; `@keyframes rail-in{0%{opacity:0;transform:translate(49px)}}`, `.15s`). The pinned footer shares only the fade, **no horizontal displacement**. A page that starts collapsed renders the rail statically. `prefers-reduced-motion` disables both transitions.
- Scrollbar affordance: while the pointer is **not** in the column the shell rebinds the thumb to `transparent`; "the thumb lingers **2 seconds** after the pointer leaves" (`SB-Z:44`). Row-shift space reservation belongs to the scroll container itself (ui-workspace), so showing a scrollbar causes **no reflow**.

### 2.4 Workspace / session browser (`dsh-client-ui-workspace`)

**Two browsing modes** (`WS-Z:32`): 分组 (`groupBy.workspace`, 按工作区 / WorkSpace) and 单列表 (`groupBy.flat`, In one list). Ordering is orthogonal: 手动排序 (`orderBy.manual`, Manual) and 最近更新 (`orderBy.updated`, Last updated). Persistence: the browser persists grouping + a per-account bookkeeping session order, keyed only for the current Workspace id, `Ungrouped` and the flat list; real Workspaces initialise from `WorkspaceView.sessionIds`, `Ungrouped`/flat from last-updated order.

**Row inventory per level**

*Section header* (`.bhn1Oq_sectionHeader`, `height:36px`, `border-radius:12px`, `justify-content:flex-end`, `gap:4px`, `margin-bottom:4px`): the section label (工作区/会话), then the collapsed **search** control, then header actions (view-options + add-workspace). In a rail it becomes `justify-content:flex-start`, `margin-bottom:12px`. Label max-width `45%`, hides with `translate(-4px)` + `max-width:0`.

*Workspace row* (`.YDXeBa_projectRow`) — **34px** tall:
- folder glyph `IconFolderClose16` / `IconFolderOpen16` (`16×20` slot); active (expanded **and** contains the current session) → `--dsw-alias-state-business-primary`.
- On hover the folder glyph is replaced by a chevron `IconTriangleRightFill14`, rotated 90° when open (`transform .15s`). Collapsed rows therefore show a folder, hovered rows a triangle.
- title `14px/20px` — the workspace label, or 未分组 / Ungrouped for `workspaceId === undefined`.
- hover-revealed actions (`gap:12px`): `…` menu (`IconEllipsisOutline16`) and `+` new-session-in-workspace (`IconPlusOutline16`).
- Hover card (only when `createdAt` is known): full label, home-abbreviated cwd, "创建于 {time}"; `copyText` = full cwd, label 已复制 / Copied.
- `role="treeitem"`, `aria-expanded`; `draggable` when a drag handle is wired.

*Session row* (`.YDXeBa_sessionRow`) — **32px** tall, `animation: row-in .15s`:
- `16×20` status slot holding **one** `StateDot` plus visually-hidden labels for every status.
- title `14px/20px` (`margin:0 6px 0 4px`; flat rows without a status drop the left margin).
- optional **active-schedule indicator**: `IconAlarmClockOutline16`, `16×20`, `role="img"`, `title`/`aria-label` = 有活动定时任务 / Has active scheduled task; it is **not** a button, has no Tab stop, and clicking its area opens the row. Appears when `SessionSummary.projectionValues.schedule` is a non-empty array, after the title and before the time.
- relative time `12px/20px` in `--dsw-alias-label-tertiary`; **hidden on hover** and replaced by the row-actions menu.
- row actions menu `…` with three items: 重命名 / Rename (`IconEditOutline16`), 分叉会话 / Fork session (`IconBranchOutline16`), 归档会话 / Archive session (`IconArchiveOutline20 size 16`). Menu is `portal:true`, `closeOnPointerLeave:true`.
- blank "new session" rows render no time and no actions.
- `role="treeitem"`, `aria-selected`; selected row gets the same hover background (`--dsw-alias-interactive-bg-hover`) — there is no distinct selected tint. While a global panel is active, session rows do **not** show the selected style (`WS-Z:54`).

*Search result row* (`.YDXeBa_searchResultRow`) — `min-height:48px`, two lines: line 1 = status dot + title (`14px/20px`) + optional schedule indicator; line 2 = workspace name (max-width `40%`, tertiary) + snippet (`12px/17px`, secondary). `role="treeitem"`, `aria-selected`.

**Status precedence** (`WS-J:783-829`, comment: "pending interaction is primary and live activity outranks completion reminders"):

1. pending interaction — **amber warning dot**, one of `status.waitingApproval` 等待审批 / Waiting for approval, `status.planReview` 计划待审 / Plan awaiting review, `status.waitingAnswer` 等待回答 / Waiting for answer;
2. `status.running` 进行中 / Running;
3. `status.subagentsRunning.one|other` {n} 个子代理运行中 / {n} subagents running;
4. `status.completed` 已完成 / Completed;
5. `status.idle` 空闲 / Idle.

Only the **primary** dot is drawn; every status's label is rendered inside a `visuallyHidden` span (`clip:rect(0 0 0 0); width:1px; height:1px`), so a screen reader hears all of them.

**Truncation rule**: an open Workspace shows **5** non-blank sessions plus, until the first prompt lands, the current blank **new session** as one temporary extra row (`COLLAPSED_SESSION_LIMIT = 5`, `WS-J:1289`; "打开的 Workspace 默认显示五条非空白 Session" `WS-Z:28`). The overflow row is `会话展开其余 {n} 个会话` / `Show {n} more sessions` (`height:28px; padding:0 12px 0 28px; font-size:12px`), collapse is 收起 / Show less. Closing and reopening the Workspace restores that collapsed projection.

**Search** (`WS-Z:36`): a section-header button; when active the input expands and takes over the header (`.bhn1Oq_searchExpanded` → `height:30px; border:.5px solid var(--dsw-alias-border-l4); border-radius:10px; width:calc(100% + 4px); margin-inline:-2px`). A non-blank query replaces either browsing mode with one flat result list:
- case-insensitive title + workspace substring matches render **immediately**;
- content matches arrive from a Host request debounced by **250ms** (`SEARCH_DEBOUNCE_MS`, `WS-J:1285`), sorted, with a snippet;
- each new query aborts the previous request; on content-search failure metadata matches still show plus a warning (内容搜索暂不可用，仅显示名称匹配。/ Content search is temporarily unavailable. Showing name matches.);
- **maximum 20 results**, then 仅显示前 {n} 条结果，请缩小搜索范围。 / Showing the first {n} results. Narrow your search.;
- query max length **500** UTF-16 code units (`SEARCH_QUERY_MAX_CODE_UNITS`);
- selecting a result clears + collapses the search, opens the session, scrolls its row into view, and in grouped mode expands the owning workspace and the full session list.

**Reorder / drag**: both modes allow drag-reorder; real Workspaces in manual mode also write Host session bookkeeping, while `Ungrouped` and the flat list stay browser-local. Workspace order is always Host-persisted. Drop indicators are a hand-drawn 2px line with two 5×7 arrow caps in `--dsw-alias-state-business-primary`, 12px tall, at `top:-8px` / `bottom:-8px` (workspaces) or `-7px` (session rows), `right:4px`. Collapsed-group drag boundaries are computed on rendered rows and place the source row *before* the middle hidden rows, so a drag never hides its own source.

**All row gestures**: single click (open session / toggle workspace), hover (reveal actions, swap time↔actions, swap folder↔chevron), `…` menu (per-row actions), `+` (new session in workspace), drag (reorder), plus click on the overflow row (expand). **No** right-click/context menu, no double-click, no per-row keyboard navigation beyond native button activation.

**Session-row management semantics** (`WS-Z:40`):
- `Rename` opens a dialog prefilled with the row's display title; **confirming an unchanged title is allowed on purpose** — it is the gesture that pins the current auto-title against regeneration.
- `Archive` submits with **no confirmation dialog**; once the archive echo lands the row disappears from every grouped view.
- `Fork` forks at the source session's last **completed** turn and opens the child after incrementing the inherited persistent title.
- Workspace `Delete` opens a confirmation explaining the retention boundary: 将把“{name}”从工作区列表中移除。文件夹与会话记录会保留，其会话将显示在“未分组”下。 / This removes "{name}" from the workspace list. The folder and session logs will be kept. Its sessions will appear under Ungrouped.

**Search / view-options / conflict copy** (verbatim, `WS-J:2568-2698`) — the clone needs these exact strings:

| key | 中文 | English |
|---|---|---|
| `group.ungrouped` | 未分组 | Ungrouped |
| `section.workspaces` / `section.sessions` | 工作区 / 会话 | Workspaces / Sessions |
| `viewOptions.label` | 视图选项 | View options |
| `groupBy.label` / `groupBy.workspace` / `groupBy.flat` | 分组方式 / 按工作区 / 单列表 | Group by / WorkSpace / In one list |
| `orderBy.label` / `orderBy.manual` / `orderBy.updated` | 排序方式 / 手动排序 / 最近更新 | Order by / Manual / Last updated |
| `sessions.expand` / `sessions.collapse` | 展开其余 {n} 个会话 / 收起 | Show {n} more sessions / Show less |
| `empty.none` / `empty.noMatches` | 暂无会话 / 无匹配结果 | No sessions yet / No matches |
| `workspace.add` / `menu.addWorkspace` | 添加工作区 / 添加工作区… | Add workspace / Add workspace… |
| `search.sessions.aria` / `search.placeholder` / `search.clear` | 搜索会话 / 搜索会话… / 清除搜索 | Search sessions / Search sessions... / Clear search |
| `search.pending` / `search.unavailable` / `search.noMatches` / `search.hasMore` | 正在搜索会话历史… / 内容搜索暂不可用，仅显示名称匹配。 / 无匹配会话 / 仅显示前 {n} 条结果，请缩小搜索范围。 | Searching session history… / Content search is temporarily unavailable. Showing name matches. / No matching sessions / Showing the first {n} results. Narrow your search. |
| `rename` / `rename.workspace.title` / `rename.session.title` | 重命名 / 重命名工作区 / 重命名会话 | Rename / Rename workspace / Rename session |
| `field.workspaceName` / `field.sessionName` | 工作区名称 / 会话名称 | Workspace name / Session name |
| `delete.workspace` / `delete.desc` / `delete.pending` | 删除工作区 / （见上） / 正在删除工作区… | Delete workspace / (see above) / Deleting workspace… |
| `menu.fork` / `menu.archiveSession` | 分叉会话 / 归档会话 | Fork session / Archive session |
| `sessions.count.one|other` | {n} 个会话 | {n} session(s) |
| `actions.workspace.aria` / `actions.session.aria` / `actions.newSession.aria` | 工作区“{name}”的操作 / 会话“{name}”的操作 / 在“{name}”中新建会话 | Workspace actions for {name} / Session actions for {name} / New session in {name} |
| `schedule.active` | 有活动定时任务 | Has active scheduled task |
| `hover.created` / `hover.copied` | 创建于 {time} / 已复制 | Created {time} / Copied |
| `date.ymd` | {y}年{m}月{d}日 | {y}-{m}-{d} |
| `time.now/minutes/hours/days/months/years/ago` | 刚刚 / {n}分钟 / {n}小时 / {n}天 / {n}个月 / {n}年 / {t}前 | now / {n}min / {n}h / {n}d / {n}mo / {n}y / {t} ago |
| `conflict.named` | 已存在名为“{name}”的工作区。 | A workspace named "{name}" already exists. |
| `folderError.title` / `folderError.retry` | 无法打开文件夹 / 重新选择 | Couldn't open folder / Choose again |
| `picker.loading` | 正在加载工作区… | Loading workspaces… |

**Rename/delete dialogs** use `Modal` with `closeLabel`, title, footer = outline cancel + primary confirm; the input is `autoFocus`, selects on focus, `aria-label` = the field name, `height:44px; border-radius:22px; padding:7px 14px` (long-form dialog) or `border-radius:4px; padding:0 2px` (inline row rename). Errors render as `role="alert"` in `--dsw-alias-state-error-primary` at `12px/18px`. `deleteAction:not(:disabled)` is tinted with the same error color.

### 2.5 New Session resolution order

"New Session 优先使用显式选择的 Workspace，其次使用当前 Session 所属的 Workspace，再其次使用最近活跃的 Workspace；如果都不存在，则打开空白的 New Session 页面" (`SB-Z:12`; `WS-Z:12`). `ctx.uiWorkspace.openSession(id)` treats even a re-selection of the current session as one UI navigation; `openWorkspace(id, beforeOpen?)`/`forkSession(id)` open only if not superseded by a later navigation (`WS-Z:54`).

---

## 3. The right sidebar in detail

Owner: **`dsh-client-ui-sidebar-right`** (the docking *kit* — split tree, drag gestures, floats — is `dsh-client-ui-dockkit` and is deliberately host-agnostic: `SR-Z:34`).

### 3.1 What it shows

There is **no fixed content**. It is a per-session docking surface whose tab *types* come from other packages:

| Tab type | Package | kind | patterns | priority | Content |
|---|---|---|---|---|---|
| guide 开始 / Start | ui-sidebar-right itself | `guide` | none (page) | `builtin` | entry capsules for every registered guide entry |
| Files 文件 / Files | `dsh-client-ui-sidebar-files` | `files` | none (page) | `builtin` | lazy workspace file tree |
| Document preview | `dsh-client-ui-sidebar-documentpreview` | `text` | `dsh-resource://file/**` | `fallback` | code / markdown / image / PDF / HTML / plain text |

Guide entries: Files uses `guide.title` 工作区文件 / Workspace files, `guide.description` 浏览会话工作区的文件 / Browse files in this session's workspace, `order: 10`. Attribute `MAX_DESCRIBED_ENTRIES = 4`: when ≤4 entries are listed, an entry that registered a description shows it under the title; longer lists drop **all** descriptions. Entry capsule: `width:380px; max-width:100%; min-height:56px; border-radius:24px; border:.5px solid var(--dsw-alias-border-l4); padding:14px 20px; gap:14px`; icon `26×26`; title `15px`; description `13px` in `--dsw-alias-label-caption`. The hero compass is `--dsw-static-neutral-200` in light, `--dsw-static-neutral-700` in dark. The guide page itself has **no text**.

Tab resolution for resources follows editor-resolver convention: rank bands `extension` (highest, also the default when unnamed) > `builtin` > `fallback`, then longer matching glob, then registration order, with `canOpen` vetoing (`SR-Z:80`). Exactly one `builtin` and one `extension` registration per `kind`; a second registration of the same `id` **throws**; any other name collision on a kind **throws**.

### 3.2 How it opens and closes

- **Collapsed → expanded** is one gesture in both presentations: the panel stays mounted, translated off the frame's right edge; opening slides it in from that edge. "The panel stays mounted while collapsed, translated off the frame's right edge, so opening and closing are one gesture in both presentations" (`SR-J:634-640`).
- The **only way back in while collapsed** is one button in the conversation header, seat **`conversation.session.header.corner`** (`SR-J:3740-3744`): `ExpandButton` renders `null` while the panel is shown, otherwise a `28×28` button with `aria-label` = 打开右侧边栏 / Open right sidebar, `data-sidebar-right-expand`, glyph `IconPanelLeftOutline16` with `transform: scaleX(-1)` — "its glyph is the mirror of the left sidebar's collapse icon" (`SR-Z:53`). Because it lives in the conversation header, a collapsed sidebar costs the center **nothing** — no rail, no width — and the transcript's scrollbar stays at the column edge.
- Closing: the tab strip's close control, or programmatically `ctx.sidebarRight.close(tabId)`. Last-tab rule (`SR-Z:68`): the **guide tab as the sole docked tab cannot be closed** (no close affordance, no menu item, quiet chip style, programmatic close records nothing); closing any *other* sole tab collapses the whole column and records one history entry, leaving the layout empty until the next expand, which creates the then-current default page. Floating panels are exempt: they render regardless of column state and their tabs close normally.
- No session ⇒ no button and no panel: "**No surface without a session.** State is keyed by session id, so the hero screen shows nothing on the right" (`SR-R`) — and `rightbar` mounts `rightbar.session` **only while the Conversation is selected** (`L-R:46`). Switching to a global panel hides the right sidebar and releases the frame column width but does not delete the session's tab state.

### 3.3 Presentations and width behaviour

| Presentation | Track | Panel |
|---|---|---|
| `push` (default) | panel width: the conversation gives up space | inside the track; its left edge and the conversation's right edge move together on the frame's own curve |
| `fullscreen` | keeps the wide normal track; **below 768px auto-fullscreen takes no track** | covers the whole window |

- Reported through `ctx.layout.openRightbar(track, fullscreen)` / `closeRightbar()` (`SR-Z:46`).
- Opening the right sidebar **below 768px auto-fullscreens** (`SR-J`, `const autoFullscreen = viewportWidth < 768`); exiting fullscreen on a narrow screen collapses the right sidebar; widening never reopens it (`SR-Z:39`).
- On a wide screen, toggling fullscreen does **not** change the center width. Fullscreen keeps the reported track but `L-J:313` hides the outer resize handle.
- The width drag area is shown **only in normal expanded state**: `layoutInfo.rightbarShown && !layoutInfo.rightbarFullscreen && normal.rightbar > 0`.
- Panel edge geometry: `border-left:.5px solid var(--dsw-alias-border-l4)`; hidden state `transform:translate(100%)` plus `visibility:hidden` with a delayed `visibility` transition; open state `transform:none; visibility:visible`; `transition: transform var(--ds-transition-duration-slow) var(--ds-ease-in-out)`. Fullscreen: `z-index:40; border:none; position:fixed; inset:0`. `prefers-reduced-motion` removes both transitions.
- Split tree: at most **two** panes, equal by default, divider clamped to **20%–80%**; a split is refused when the width cannot hold two panes ("栏宽不足，拖宽侧边栏后再分栏" / Not enough width to split, widen the sidebar); at the two-pane cap the split control is hidden and restored when back to one pane.
- Keyboard/tab-strip order, left to right (`SR-Z:48`): tab chips (with close buttons where allowed) → the add control (drawn only when the pane holds no guide tab) → the pane's split control → the two panel controls (presentation switch + collapse) in the top-right pane. Truncation rule: "in a narrow pane only the chips yield; the controls after them never shrink or get clipped."

### 3.4 Dock chrome, guide identity and copy

- `ctx.sidebarRight` (navigation controller): `openResource(address, options?)`, `openTab(kind, options?)`, `close(tabId)`, `active()`, `isExpanded()`, `toggleExpanded()`, `focus(tabId)`, `split(paneId?)`, `float(tabId, rect?)`, `dock(paneId)`. Unregistered kinds, unclaimed `dsh-resource://` addresses and non-`dsh-resource://` addresses **throw** — "that is a wiring error, not a user error" (`SR-Z:87`). `_undo()`/`_redo()` are `@internal` and exist only for tests; **there are no product undo controls**.
- Extension seats: `sidebar.right.pane.tab` (keyed it by the type's `id`), `sidebar.right.pane.tab.title`, `sidebar.right.tab.guide` (chain — replaces the guide body, not the tab), `sidebar.right.tab.menu.item` (list — content-level tab menu items appended after the kit's own layout actions). "There are currently no seats for pane-level actions or for collapse-state controls."
- Panel has **no header row of its own**: "it takes the conversation area's background and body font size, not a floating surface of its own: it is a column of the page, not a card on top of it" (`SR-Z:55`).
- Copy namespace `sidebarRight` — the panel's own strings (`SR-J` locale tables, EN + ZH):

| key | 中文 | English |
|---|---|---|
| `chrome.expand` / `chrome.expandAria` | 打开侧边栏 / 打开右侧边栏 | Open sidebar / Open right sidebar |
| `chrome.collapse` / `chrome.collapseAria` | 收起侧边栏 / 收起右侧边栏 | Collapse sidebar / Collapse right sidebar |
| `chrome.toFullscreen` / `chrome.exitFullscreen` | 全屏 / 退出全屏 | Fullscreen / Exit fullscreen |
| `dock.emptyPane` | 空面板 | Empty pane |
| `dock.splitPane` / `dock.splitPaneDisabled` / `dock.splitPaneNarrow` | 分栏 / 已达两格上限 / 栏宽不足，拖宽侧边栏后再分栏 | Split / Two panes is the limit / Not enough width to split, widen the sidebar |
| `dock.closeTab` / `dock.addTab` / `dock.dockFloat` / `dock.closeFloat` | 关闭 / 新标签页 / 收回到侧边栏 / 关闭 | Close / New tab / Send back to the sidebar / Close |
| `dock.drop.center|left|right|top|bottom` | 移到这里 / 左分栏 / 右分栏 / 上分栏 / 下分栏 | Move here / Add left split / Add right split / Add top split / Add bottom split |
| `tab.guide.title` | 开始 | Start |
| `tab.unavailable` | 这类内容还没有可用的查看方式。 | Nothing here can view this kind of content yet. |

- Panel icon buttons: `28×28; border-radius:28px; padding:6px`, `svg{15×15}`; the collapse glyph is `scaleX(-1)`.

### 3.5 Files tab geometry (`dsh-client-ui-sidebar-files`)

Header `height:38px; padding:0 6px 0 16px; gap:4px; border-bottom:.5px solid var(--dsw-alias-border-l3)` showing the workspace root path (directory prefix tertiary, last segment primary; over-wide paths keep their end and fade their start via `mask-image:linear-gradient(90deg,#0000,#000 28px)`), plus one reload control (`28×28; border-radius:28px`, `svg{15×15}`). Root font size `var(--dsh-content-font-size-secondary,13px)`, `line-height:1.5`. Tree level indent `padding-left:18px`; row `padding:5px 10px; gap:6px; border-radius:10px`. Row = icon + ellipsized name only — **no size, no timestamp, no git marker, no badge, no chevron, no hover buttons**. Directories first, then natural case-insensitive name order (`Intl.Collator{numeric:true, sensitivity:"base"}`, so `file2` < `file10`); dotfiles shown like any entry. Empty state 空目录 / Empty directory; loading 正在读取… / Reading…; truncation note 条目太多，只显示了一部分。 / Too many entries, showing only some of them.; no-workspace 这个会话没有工作区目录。 / This session has no workspace directory.

### 3.6 Document preview tab geometry (`dsh-client-ui-sidebar-documentpreview`)

Fixed header, same 38px recipe as Files: host-absolute path (else requested path) + a viewer dropdown (`aria-label` 打开方式 / Open with, `max-width:160px`, `font-size:12px`) + a wrap toggle **only for renderers with `wrap === true`** + reload. Wrap starts **on** per tab. A change bar (文件已更新，当前显示为旧内容。 / The file has changed, showing the previous content.) or metadata-failure bar sits **above** the header, each with a 重新载入 / Reload button; the change is **never auto-applied**. Body reaches every pane edge and each renderer owns its inset — deliberately different from Files' 2px right scrollbar offset.

Renderers and their exact extension sets:

| Renderer | Extensions | loading | wrap |
|---|---|---|---|
| Code 代码 / Code | ts,tsx,mts,cts,js,jsx,mjs,cjs,sh,bash,zsh,json,jsonc,jsonl,ndjson,py,pyw,pyi,rb,rake,gemspec,go,rs,java,c,h,cc,cpp,cxx,hh,hpp,hxx,cs,kt,kts,swift,php,yaml,yml,toml,ini,md,markdown,mdx,html,htm,xhtml,css,scss,less,sql,xml,xsd,xsl,xslt,lua (56 suffixes / 27 grammars) | text-pages | yes |
| Markdown / Markdown | md, markdown | text-pages | no |
| Image 图片 / Image | png,jpg,jpeg,gif,webp,bmp,ico,svg | bytes-complete | no |
| PDF / PDF | pdf | bytes-complete | no |
| HTML / HTML | html, htm | bytes-complete | no |
| Plain text 纯文本 / Plain text (fallback) | `[]` → unknown | text-pages | yes |

Security-relevant facts a clone must not miss: SVG never enters the app DOM or an iframe (rendered as an `<img>` Blob URL so scripts cannot run); HTML is a Blob iframe with **exactly `sandbox="allow-scripts"`, no `allow-same-origin`**, packing only directly-referenced classic `.js` and `.css` with limits **4 MiB per asset / 32 MiB total / 64 distinct assets**, and a `<base href>` disables packing entirely; PDF is pdfjs-dist **6.3.289** in its own module Worker named `dsh-pdf` with all cMaps/fonts/wasm inlined and **no network fallback**, render scale **96/72**, canvas device-pixel-ratio capped by `sqrt(16777216/(w*h))`. Code previews show line numbers by default (excluded from copied text).

---

## 4. The visual design system

### 4.1 Token families (this is the part to copy first)

Three distinct families exist; **they are not interchangeable**:

1. **`--dsw-static-*`** — the raw palette: `--dsw-static-{amber,blue,deepseek,green,neutral,neutral-bluish,red}-<step>`. Declared **twice** with the *same values* on `body` and `body[data-ds-dark-theme]` (i.e. the raw ramp is theme-invariant), e.g. `--dsw-static-neutral-bluish-00:#fff`, `-50:#f9fafb`, `-60:#f5f6f7`, `-75:#f1f3f5`, `-100:#ebeef2`, `-150:#e9ecf2`, `-200:#e1e5ee`, `-300:#cfd3d6`, `-400:#adb2b8`, `-500:#979da6`, `-600:#81858c`, `-700:#61666b`, `-750:#43454a`, `-800:#353638`, `-850:#2c2c2e`, `-875:#232324`, `-900:#1b1b1c`, `-950:#151517`, `-1000:#0f1115`; brand ramp `--dsw-static-deepseek-50:#edf3fe … -500:#4176e6 … -900:#283142`. (One value *does* differ between the two blocks: `--dsw-static-neutral-bluish-60` is `#f5f6f7` in light and `#f9fafb` in dark — a live inconsistency inside the shipped sheet.)
2. **`--dsw-alias-*`** — semantic roles, remapped per theme. This is what components should consume.
3. **`--dsw-specific-*`** — surface-specific roles (bubbles, sidebar, menu, tip, toolbars). Also remapped per theme.
4. **`--dsh-*`** — DSH's own runtime variables, computed by the theme sheet or written by the presenter: `--dsh-content-font-size` (user setting, 12–17px, default 14), `--dsh-content-font-delta`, `--dsh-content-font-size-secondary`, `--dsh-content-font-delta-secondary`, `--dsh-scrollbar-thumb`, `--dsh-scrollbar-thumb-hover`, `--dsh-scrollbar-width`.
5. **`--ds-*` and `--dsl-*`** — a small platform set: `--ds-font-family-code`, `--ds-ease-in-out`, `--ds-transition-duration` (.2s) / `-fast` (.1s) / `-slow` (.3s); code-preview knobs `--dsl-code-block-*`.
6. **`--shiki-token-*`** — syntax colors (see 4.5).

Total: **357** distinct `--dsw-*` names and **7** `--dsh-*` names in the theme sheet (`TH-J`).

### 4.2 Semantic alias roles — light vs dark (exact pairs from `TH-J`)

| Role token | light | dark |
|---|---|---|
| `--dsw-alias-bg-base` | `neutral-bluish-00` (#fff) | `neutral-bluish-950` (#151517) |
| `--dsw-alias-bg-layer-1` | `neutral-bluish-00` | `neutral-bluish-875` (#232324) |
| `--dsw-alias-bg-layer-2` | `neutral-bluish-00` | `neutral-bluish-850` (#2c2c2e) |
| `--dsw-alias-bg-layer-3` | `neutral-bluish-00` | `neutral-bluish-800` (#353638) |
| `--dsw-alias-bg-module-platform` | `neutral-bluish-60` | `neutral-bluish-800` |
| `--dsw-alias-bg-overlay` | `neutral-bluish-150` | `neutral-bluish-700` |
| `--dsw-alias-bg-mask-1/-2/-3` | `#0000003d / #0000001f / #0000007a` | `#00000080 / #0003 / #0000007a` |
| `--dsw-alias-bg-skeleton` | `#0000000a` | `#ffffff14` |
| `--dsw-alias-border-l1` | `#0000000a` | `#ffffff0f` |
| `--dsw-alias-border-l2` | `#0000001a` | `#ffffff1f` |
| `--dsw-alias-border-l3` | `#0000001f` | `#ffffff29` |
| `--dsw-alias-border-l4` | `#00000029` | `#fff3` |
| `--dsw-alias-label-primary` | `neutral-bluish-1000` (#0f1115) | `neutral-bluish-50` (#f9fafb) |
| `--dsw-alias-label-secondary` | `neutral-bluish-700` | `neutral-bluish-300` |
| `--dsw-alias-label-tertiary` | `neutral-bluish-600` | `neutral-bluish-400` |
| `--dsw-alias-label-caption` | `neutral-bluish-400` | `neutral-bluish-600` |
| `--dsw-alias-label-dimmed` | `neutral-bluish-200` | `neutral-bluish-750` |
| `--dsw-alias-brand-primary` | `neutral-bluish-1000` (near-black!) | `neutral-bluish-50` (near-white) |
| `--dsw-alias-brand-primary-new-colorprimary-new-color` | `#4176e6` | `deepseek-450` (#5686fe) |
| `--dsw-alias-link` | `deepseek-500` (#4176e6) | `deepseek-400` (#679efe) |
| `--dsw-alias-interactive-bg-hover` | `#2631480f` | `#ffffff14` |
| `--dsw-alias-interactive-bg-active` | `#2631481a` | `#ffffff24` |
| `--dsw-alias-interactive-bg-hover-solid` | `neutral-bluish-75` | `neutral-bluish-800` |
| `--dsw-alias-interactive-bg-hover-danger` | `#ec13130d` | `#f25a5a26` |
| `--dsw-alias-button-primary-fill` | `= brand-primary` | `= brand-primary` |
| `--dsw-alias-button-primary-hover` | `neutral-bluish-750` | `neutral-bluish-100` |
| `--dsw-alias-button-elevated-fill` | `neutral-bluish-00` | `neutral-bluish-750` |
| `--dsw-alias-button-floating-fill` | `neutral-bluish-00` | `neutral-bluish-850` |
| `--dsw-alias-button-floating-hover` | `neutral-bluish-75` | `neutral-bluish-800` |
| `--dsw-alias-button-tool-bar-fill` | `#54555780` | `#54555780` (same) |
| `--dsw-alias-state-success-primary/-secondary/-tertiary` | green-500 / green-400 / green-100 | green-500 / green-400 / green-900 |
| `--dsw-alias-state-warn-primary/-secondary/-tertiary/-label` | amber-500 / amber-400 / amber-100 / amber-600 | same / same / amber-900 / amber-600 |
| `--dsw-alias-state-error-primary/-secondary` | red-600 / red-400 | red-400 / red-400 |
| `--dsw-alias-state-business-primary/-tertiary` | deepseek-500 / deepseek-100 | deepseek-400 / deepseek-800 |
| `--dsw-alias-toast-bg` / `--dsw-alias-tooltip-bg` | `neutral-bluish-800` / `neutral-bluish-850` | `neutral-bluish-750` / `neutral-bluish-750` |
| `--dsw-alias-scrollbar-bg-l1/-l2`, `-hover-l1/-l2` | `neutral-200`/`neutral-200`, `neutral-300`/`neutral-300` | `neutral-700`/`neutral-600`, `neutral-600`/`neutral-550` |
| `--dsw-alias-markdown-code-block`, `-banner` | `neutral-bluish-50` | `neutral-bluish-900` / `neutral-bluish-850` |
| `--dsw-alias-markdown-inline-code` | `neutral-50` | `neutral-800` |
| `--dsw-alias-markdown-citation`, `-tag`, `-placeholder` | bluish-100 / bluish-75 / bluish-60 | bluish-800 / bluish-850 / bluish-850 |

The `--dsw-specific-*` set (both themes, `TH-J`): `sidebar-fill` (bluish-50 / bluish-900), `sidebar-nav-item-hover` (bluish-75 / bluish-850), `sidebar-nav-item-active` (bluish-100 / bluish-750), `sidebar-nav-item-active-accent` (deepseek-100 / bluish-800), `bubble` (deepseek-50 / bluish-850), `bubble-highlight` (deepseek-200 / bluish-750), `input-major` (bluish-00 / bluish-850), `login-input` (bluish-50 / bluish-900), `menu` (= `bg-layer-3`), `selector` (bluish-60 / bluish-800), `tip` (bluish-60 / bluish-800).

**Note the load-bearing convention**: surfaces step *up* in the dark theme (`base 950 → l1 875 → l2 850 → l3 800`) and are all **pure white in the light theme** (`bg-base = bg-layer-1 = bg-layer-2 = bg-layer-3 = #fff`). Depth in light mode comes only from borders/elevation, not fills.

### 4.3 Typography

Family & motion, from the `:root` sheet (`TH-J`):

```css
:root{
 --dsw-font-family:-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
   "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial, sans-serif;
 --ds-font-family-code:"SF Mono","JetBrains Mono","Fira Code",Consolas,
   "Liberation Mono",Menlo,Courier,"PingFang SC","Microsoft YaHei";
 --ds-ease-in-out:cubic-bezier(.4, 0, .2, 1);
 --ds-transition-duration:.2s; --ds-transition-duration-fast:.1s; --ds-transition-duration-slow:.3s}
```

Page rule (`WF` `index-DPX2bQLO.css`): `body{font-family:var(--dsw-font-family,…); -webkit-font-smoothing:antialiased; -moz-osx-font-smoothing:grayscale; color:var(--dsw-alias-label-primary,#0f1115); background:var(--dsw-alias-bg-base,#fff); text-autospace:normal}`.

UI type scale (each token has `-font-family`, `-font-size`, `-font-weight`, `-line-height`, `-font-style` siblings):

| Token | Computed value |
|---|---|
| `--dsw-font-xl-24` | 600 24px/32px |
| `--dsw-font-l-20` | 500 20px/28px |
| `--dsw-font-m-18` | 500 **16px**/28px (the name says 18, the value is 16) |
| `--dsw-font-base-16` / `-strong-16` | 400 (500 strong) 16px/24px |
| `--dsw-font-s-14` / `-strong-14` | 400 (500) 14px/22px |
| `--dsw-font-xs-13` / `-strong-13` | 400 (500) 13px/20px |
| `--dsw-font-xxs-12` / `-strong-12` | 400 (500) 12px/18px |
| `--dsw-font-xxxs-11` / `-strong-11` | 400 (500) 11px/14px |

**Content font-size axis** (`TH-J`, body sheet — the mechanism that makes the user's 12–17px setting work):

```css
--dsh-content-font-delta: calc(var(--dsh-content-font-size,14px) - 14px);
--dsh-content-font-size-secondary: min(calc(var(--dsh-content-font-size,14px) - 1px),
                                       max(13px, calc(var(--dsh-content-font-size,14px) - 2px)));
--dsh-content-font-delta-secondary: calc(var(--dsh-content-font-size-secondary) - 13px);
```

i.e. the secondary step is "setting − 1px, floored at max(13px, setting − 2px)" → 13px at the default. Markdown ladder: `h1` 700 calc(21px+delta)/calc(30px+delta), `h2` 700 calc(19px+Δ)/calc(28px+Δ), `h3` 700 calc(18px+Δ)/calc(26px+Δ), `h4` 600 14px/calc(24px+Δ), base 400 14px/calc(24px+Δ), table/table-head use the **secondary** 13px step with 500 for the head, `markdown-small` is a fixed 12px/20px, `markdown-code` fixed 12px/19px, `markdown-code-block` fixed 11px/19px, `markdown-code-block-small` fixed 11px/16px. "Compact small text and the code variants keep fixed sizes" (`TH-Z:58`). The user's size step is applied to session titles and base text including user bubbles and the composer draft (`TH-Z:32`).

### 4.4 Space, radius, elevation, scrollbars

- **Corner shape**: `@supports (corner-shape: superellipse(1.5)) { :root{--dsw-corner-shape:superellipse(1.5)} }` applied via a wildcard selector to every element and its `::before`/`::after`; engines without `corner-shape` keep plain arcs. Perfect circles/pills (`border-radius:50%`) must pair the radius with `corner-shape: round` or the superellipse deforms them — the sidebar's round icon buttons do exactly that.
- **Elevation** (`TH-J`): `--dsw-elevation-stroke:0 0 0 .5px var(--dsw-elevation-stroke-color)` (the "hairline" is a 0.5px stroke, not a border), with `--dsw-elevation-stroke-color: var(--dsw-alias-border-l4)`; `--dsw-elevation-panel: stroke, 0 3px 8px 0 #00000008, 0 0 16px 0 #00000005`; `--dsw-elevation-prominent: stroke, 0 3px 8px 0 #0000000a, 0 0 20px 0 #0000000d`; `--dsw-elevation-soft: stroke, 0 4px 16px 0 #00000008, 0 0 24px 0 #00000008` (soft = input-box variant: bigger blur, lower opacity). Higher surfaces therefore set `border:0`. Shadows: `--dsw-shadow-lv1:0 2px 4px 0 #0000000d`, `--dsw-shadow-lv1-blur:0 4px 12px 0 #00000005`, `--dsw-shadow-lv2:0 4px 12px 0 #00000005, 0 2px 8px 0 #0000000a`, `--dsw-shadow-lv3:0 0 1px 0 #0003, 0 0 4px 0 #00000005, 0 12px 32px 0 #00000014`. Mask blur `--dsw-mask-blur: blur(2px)`.
- **Think gradient**: `--dsw-linear-gradient-think: linear-gradient(180deg,#fff 20.19%,#fff0 100%)` light / `linear-gradient(180deg,#151517 20.19%,#15151700 100%)` dark; `--dsw-linear-think-select` `#f5f6f7` light / `#232325` dark.
- **Scrollbars**: `--dsh-scrollbar-width: 8px`; WebKit path `::-webkit-scrollbar{width:8px;height:8px}`, `-track{background:0 0}`, `-thumb{background:var(--dsh-scrollbar-thumb); border-radius:4px}`, `:hover{--dsh-scrollbar-thumb-hover}`, `-corner{background:0 0}`. Firefox path is `@supports not selector(::-webkit-scrollbar){ body,body *{scrollbar-width:thin; scrollbar-color:var(--dsh-scrollbar-thumb) transparent} }`. The two paths are mutually exclusive by construction, so the hover token renders **only** through the pseudo-element path. `scrollbar.css` is the sole consumer of `--dsw-alias-scrollbar-*` and must be loaded after `design-platform.css`.
- **Sidebar-specific rebinding**: `ui-sidebar` rebinds `--dsh-scrollbar-thumb` to the **l2** tokens, and to `transparent` while the pointer is outside the column; the other legal target for those variables is literally `transparent`.

### 4.5 Syntax highlighting

`--shiki-foreground:var(--dsw-alias-label-primary)`, `--shiki-background:var(--dsw-alias-markdown-code-block)`, then light `--shiki-token-constant:#1c7ed6, -string:#2f9e44, -comment:#868e96, -keyword:#d6336c, -parameter:#e8590c, -function:#6741d9, -string-expression:#2b8a3e, -punctuation:#495057, -link:#1971c2`; dark `-constant:#4dabf7, -string:#69db7c, -comment:#adb5bd, -keyword:#faa2c1, -parameter:#ffa94d, -function:#b197fc, -string-expression:#8ce99a, -punctuation:#ced4da, -link:#74c0fc`.

### 4.6 Theme plumbing, persistence and registration

- Themes resolve to `light | dark | system`; `system` is resolved **upstream** by the theme service against `prefers-color-scheme`, so the presenter only ever sees a concrete `colorScheme` (`L-J:466-471`, `TH-Z:12`). Two settings only: color scheme + content font size (**integer 12–17px, default 14px**, stepper) (`TH-Z:32`).
- Persistence: on loopback the two values are written through the Host settings API into the `ui-theme` namespace, defaulting to `$DSH_HOME/settings.yaml`; rapid consecutive changes serialize by namespace revision, and a rejected write re-reads the persisted value. **Non-loopback pages keep both choices in-process only.** "Non-loopback pages do not create a Host-backed scope" (`TH-Z:66`).
- Third-party themes register alias-token overrides through `ctx.theme`; overrides fold into the active snapshot in registration order. "Registering one means overriding same-named alias variables; no validation exists that an override set is complete" (`TH-R`).
- Pre-plugin boot: when the host composes an HTTP server it inlines the persisted `ui-theme` settings (or schema defaults) into every index response, and the browser sets `color-scheme`, `body[data-ds-dark-theme]` and `--dsh-content-font-size` **before the app renders**, so the first frame already uses the chosen palette (`TH-Z:40`). The boot card carries its own hard-coded fallback palette (`--dsh-boot-bg:#fff` light / `#151517` dark, `--dsh-boot-label-primary:#0f1115`/`#f9fafb`, spinner 20×20, 2px border, `0.8s linear infinite`).

### 4.7 Focus, motion and accessibility rules (the explicit ones)

- Focus ring in the sidebar: `outline:2px solid var(--dsw-alias-label-primary); outline-offset:-2px` on `.panelRow:focus-visible` — a deliberate, unstyled-by-token inset ring. No other package in scope defines a custom `:focus-visible` ring.
- Every interactive glyph in the sidebar/dock is a real `<button>` with an `aria-label` (`aria-current` for the active nav cell, `aria-expanded` for tree/disclosure rows, `aria-selected` + `role="treeitem"` for rows, `aria-pressed` for the wrap toggle, `aria-modal`/`aria-labelledby` for the settings dialog, `aria-haspopup="dialog"` on the Settings trigger, `role="img"` + `aria-label` + `title` on the schedule marker, `role="alert"` on inline errors, `role="status" aria-live="polite"` on the models saved-notice, `role="tablist"/"tab"/"tabpanel"` with roving `tabIndex` on plugin tabs).
- Screen-reader-only text uses a `visuallyHidden` class (`clip:rect(0 0 0 0); width:1px; height:1px; position:absolute; white-space:nowrap; overflow:hidden`).
- `@media (prefers-reduced-motion: reduce)` appears in **every** animated module in scope: frame grid transition, drag handles, sidebar expand/collapse animations, workspace row-in/arrow transitions, right-panel slide, preview spinner, inventory chevron.
- Transitions are short and read from the shared tokens: `.1s` fast, `.15s` (rows/rail-in/arrow), `.18s` (search expand), `.2s` (default; expand fade), `.3s` (frame track / right panel slide).
- Onboarding modal **makes the app inert**: it sets `document.getElementById("root").inert = true` while mounted, and its `onClose` is a no-op, so an implicit dismiss cannot skip it (`SM-J`).
- Settings modal: focus goes to the header close button on mount and **returns to the trigger button** on close; `Escape` is bound on `document` only while open (`SG-J:103-110`).

---

## 5. The composer (NOT in this scope — named for the other engineer)

The composer is **not** owned by any of the 15 packages above. Ownership:

- **`@deepseek-ai/dsh-client-ui-conversation`** — `Conversation 组装`: occupies the reserved `main` key `conversation` and "registers the strict Session header/body, View list, **composer chain and bar**, input area, Hero area, queue dock, draft persistence and phase computation" (`dsh-client-ui-conversation/README.zh.md:41`). The persistent composer stays mounted across no-Session/has-Session; the editing surface is a **shell-owned Lexical editor**; attachments/images/files, optimistic submit, queue/steer, busy-Enter behavior (persisted in the `ui-conversation` settings namespace), Cmd/Ctrl+Enter as the alternate delivery mode, `QueueDock` rows with Edit/Remove/Steer, and the Send/Stop button swap all live there (`…README.zh.md:47-53`). The temporary-takeover chain seat is `conversation.composer` (`…:56-101`).
- **`@deepseek-ai/dsh-client-ui-chat`** — transcript/round rendering, scroll ownership, feedback (`dsh-client-ui-chat/README.zh.md` headings: 系统提示词行, 轮次 token 用量, 已完成轮次的页脚, 轮次过程折叠, 滚动归属). It is the only other package in the tree with documented shortcuts besides the 7 found below.
- The conversation header corner seat that carries the **right-sidebar expand button** is `conversation.session.header.corner` (`SR-J:3740`), with siblings `conversation.session.header`, `.actions`, `.lineage`, `.utilities`.
- Adjacent composer-affiliated packages (each its own plugin): `dsh-client-ui-commands` (`/` slash-command source; popup select for `/model`, `/permission`; action for `/feedback`; renders into `shell.overlay`), `dsh-client-ui-input-trigger`, `dsh-client-ui-attachment`, `dsh-client-file-upload`, `dsh-client-ui-model-selection`, `dsh-client-ui-permission-presets`, `dsh-client-ui-approval`, `dsh-client-ui-user-questions`, `dsh-client-ui-plan`, `dsh-client-ui-goal`, `dsh-client-ui-jobs`, `dsh-client-ui-skill`, `dsh-client-ui-deliverables`, `dsh-client-ui-agent-preset`, `dsh-client-ui-message-feedback`, `dsh-client-ui-reference`, `dsh-client-ui-trajectory`, `dsh-client-ui-subagent`, `dsh-client-ui-workflow-run`, `dsh-client-ui-schedule`.

**If the other product must clone the composer, ask for a Report B on `dsh-client-ui-conversation` + `dsh-client-ui-chat` + `dsh-client-ui-commands` + `dsh-client-ui-input-trigger` + `dsh-client-ui-attachment` + `dsh-client-ui-model-selection` + `dsh-client-ui-permission-presets`.** Do not infer it from this report.

---

## 6. Keyboard map (complete for the packages in scope)

There is **no global shortcut registry and no keybinding layer** anywhere in the shell packages. Here is every key handler that exists, by owner:

| Owner | Keys | Effect |
|---|---|---|
| `dsh-client-ui-workspace` | **Escape** in the search input | clears the query **and** collapses the search (`WS-J:2270-2274`) |
| `dsh-client-ui-workspace` | **Enter** in either rename dialog's input | commits the rename; guarded by an IME-composition flag so it does not fire mid-composition (`WS-J:2463-2467`, `WS-J:2517-2521`) |
| `dsh-client-ui-workspace` | menus/dialogs | whatever the shared `Menu` / `Modal` primitives implement (Escape/arrow navigation) — not declared in this package |
| `dsh-client-ui-settings-general` | **Escape** (document-level, bound only while the panel is open) | closes the Settings panel (`SG-J:103-110`) |
| `dsh-client-ui-settings-plugins` | **ArrowRight / ArrowLeft** (wrap around), **Home**, **End** on the tablist | moves focus to the next/previous/first/last tab, each `preventDefault()` (`SP-J:476-497`) |
| `dsh-client-ui-layout`, `-sidebar`, `-sidebar-right`, `-theme`, `-session`, `-sidebar-files`, `-sidebar-documentpreview`, `-settings`, `-settings-models`, `-settings-plugin-inventory`, `-brand-official` | **none** | no `onKeyDown`, no `aria-keyshortcuts`, no `event.key` handling at all. Only native `<button>`/`<input>` activation (Enter/Space/Tab). |

Documented shortcuts that exist elsewhere (so this report is not mistaken for the whole product): the READMEs mentioning 快捷键/keyboard are `dsh-client-ui-chat`, `dsh-client-ui-attachment`, `dsh-client-ui-input-trigger`, `dsh-client-ui-deliverables`, `dsh-client-ui-subagent`, `dsh-client-ui-schedule`, plus `dsh-client-ui-settings-general`. **Only `settings-general` is in scope.** In particular `Cmd/Ctrl+Enter`, `Enter`, and the Queue/Steer delivery choice are **composer** shortcuts owned by `dsh-client-ui-conversation`.

Practical consequence for the clone: the shell itself needs **zero** window-level keybindings to look identical. The visible key-driven affordances are all inside the composer, which is out of scope.

---

## 7. What the UI explicitly refuses to do / known limitations (verbatim)

Collected from every in-scope README's "已知限制与延期工作 / Known Limitations and Deferred Work" section. **Every one of the 15 packages has such a section; none is missing.** Do not promise the other product anything on this list.

### `dsh-client-ui-layout`
> - **Panel geometry is transient** — reload restores the sidebar default and the right panel hidden; each dragged width is one frame-wide preference, not a per-Session fact.
> - **Extremely narrow windows** — after the right panel closes, the center may still fall below 400px; the left 56px rail remains.
> - **Track and panel travel on one shared curve** — the frame's track transition and the occupant's slide read the same duration and easing variables; an occupant that used its own would detach the panel's edge from the conversation's while squeezing.
> - **No scroll anchoring during squeeze reflow** — layout changes may move the reader's viewport.

### `dsh-client-ui-sidebar`
> - **Session state-dot rendering is owned by ui-workspace** — no done/error notification sources are available to this shell.
> - **Workspace browser behavior is composition-owned** — grouping, ordering, search, and row state belong to ui-workspace, not this shell.
> - **"New task completed" unread marking is local viewing state** — completion-time > last-seen never reaches the host.

### `dsh-client-ui-sidebar-right`
> - **Memory-only.** Nothing is persisted; a reload starts every session collapsed.
> - **No surface without a session.** State is keyed by session id, so the hero screen shows nothing on the right.
> - **Hard-coded stacking.** The panel and the float host use fixed z-index values because the client has no z-index token layer yet.
> - **Undo is not exposed.** The recorded sequence is stepped only through the `@internal` service methods; product controls are deliberately absent.
> - **Titles are fixed at open time.** A type's `title(address)` is captured into the record; a live title comes only from the optional title seat.
> - **No content navigation stack.** Stepping back replays layout operations; an editor-style back/forward over visited content is not built.

### `dsh-client-ui-sidebar-files`
> - **Listing only.** No search, artifact filter, drag-and-drop, rename, context menu, current-file highlight, or filesystem watching; a level changes only through reload.
> - **One root.** The tree is rooted at the session's working directory; there is no way to browse above it, and the Host refuses paths outside the workspace root anyway.

### `dsh-client-ui-sidebar-documentpreview`
> - **Preview, not editing.** The viewers provide no file editing or shared search interface; a directory address fails with `not-regular-file`. Unknown extensions use the plain-text reader and remain subject to its UTF-8/NUL checks.
> - **Sequential text and bounded complete files.** Deep source lines require the preceding pages; PDF, HTML, and images require a complete result within the Host's `maxFileBytes` cap.
> - **Byte-view scroll state is not restored.** PDF, HTML, and images can return to the top when their renderer remounts or reloads; image horizontal position is never restored, and HTML iframe scrolling belongs to its opaque browsing context.
> - **Finite local HTML dependencies.** Only direct classic `.js` and stylesheet `.css` references are packed. Browser-resolved resources retain browser origin and network restrictions; no runtime file-read bridge is exposed to the iframe.
> - **Package-local wrap glyphs.** `IconWrapFill16` and `IconNowrapFill16` live in `src/client/icons.tsx` until the shared icon set carries them.
> - **Scroll writes are unthrottled.** Every scroll event records its offset in the store; the line blocks are memoized so the resulting re-render hands React the same elements back.

Non-goals stated elsewhere in that package: **no zoom and no drag-to-pan** for images; password-protected PDFs unsupported and **no main-thread parsing fallback**; Host `maxFileBytes` **rejects** oversized files rather than truncating.

### `dsh-client-ui-workspace`
> - **No fuzzy content search or event deep links** — the content backend uses literal token/phrase matching, and selecting a result opens the Session rather than the matching event.
> - **No Session deletion or unarchive control** — sessions can be archived, but archived sessions have no viewing or unarchive surface, and Workspace registration deletion does not delete Sessions.
> - **Pending user interaction is not aggregated into collapsed groups** — a waiting row inside a collapsed group lights no group-header indicator and becomes visible only after that group is expanded.
> - **Native folder selection depends on the local Host carrier** — under the `-native` composition, in-process or remote browser deployments cannot open a local operating-system dialog; remote-capable picking is the `-browse` composition's in-app flow.

Extra from the body of the same README: "**添加工作区…** only renders while the current surface's slot is occupied; an empty slot means the composition has no directory-picking capability" (`WS-Z:66`) — i.e. with no directory picker composed, **adding a workspace is unavailable**.

### `dsh-client-ui-session`
> - **Pending interactions are process-local projections** — the owning Remote waterfall must replay an outstanding request after a browser reconnect.

### `dsh-client-ui-theme`
> - **Third-party themes are an extension point, not a product** — registering one means overriding same-named alias variables; no validation exists that an override set is complete.
> - **The token sheets are the sole color authority** — values absent from the design system are deliberately not appended; the nearest semantic token wins, and design-owner-approved additions enter as a static step plus a semantic alias in the same change.

### `dsh-client-ui-settings`
> - **Non-loopback pages get no durable settings** — this Client keeps Host persistence disabled there, so a scope starts `unavailable` and never crosses the wire; every row it backs is inert even though Connection authentication covers the API.

### `dsh-client-ui-settings-general`
> - **The General section has no built-in rows** — each row appears only when its owning feature plugin is mounted; the shell cannot fill the section alone.

### `dsh-client-ui-settings-models` (5 items)
> - **Only the API key and curated fold fields are editable on the card** — … Retry policy, timeouts, DeepSeek model descriptions, and other advanced fields remain in `settings.yaml`; existing model fields the editor does not show are preserved.
> - **Credential cleanup is intentionally narrow** — deleting a row removes the configured, writable credential only when its reference is the exact `<ROUTE>_API_KEY` target this page derives. Custom references, environment credentials, and unidentifiable targets are retained …
> - **Only pi-ai routes can be hand-declared** — the custom-provider card writes into `llm-pi-ai` … A `llm-deepseek` route is a composition fact, not something this page can create.
> - **Interrogation covers OpenAI-compatible and Anthropic Messages endpoints** — … every other protocol reports that it cannot be asked and its models are entered by hand.
> - **Undeclared live routes render nowhere** — a route registered without a configurable-provider declaration has no settings address; it stays visible in pickers but not on this page's rows.

### `dsh-client-ui-settings-plugins` (4 items)
> - **Only host-plane plugins appear** — a plugin an agent preset mounts carries its configuration inline in that preset's `agent.cordis.yml` and cannot register a settings namespace at all …
> - **A card still needs a browser bundle** — the browser half must be a `dsh.client` package built in the client module system's lazy-CJS factory format, and the `clientBundle` preset that emits it lives in `packages/client/tsdown.client.ts` rather than a published package …
> - **The served namespaces re-read on two signals only** — the wire announces settings-document commits and connection resets, not registrations …
> - **The shell card follows the composed executor** — the POSIX and PowerShell executor families share the `bash` namespace because a host composes exactly one of them, so the served schema differs by platform (PowerShell adds `pwshPath`) …

### `dsh-client-ui-settings-plugin-inventory` (2 items)
> - **One snapshot per Settings mount or retry** — the tab does not subscribe to Loader changes or automatically refetch after reconnect …
> - **Read-only in both planes** — the tab shows global and preset enablement but mutates neither; enable/disable controls that write a custom preset's own composition file are deliberate follow-up work.

### `dsh-client-ui-brand-official` (2 items)
> - **One occupant set** — alternative presentation belongs in another Cordis package occupying the same slots.
> - **The browser title is independent** — `DSH_CLIENT_TITLE` selects title text at build time rather than through a UI slot.

### `dsh-web-frontend`
No README exists in the published package (`package.json` only; description = "Web application entry: vite build over the @deepseek-ai/dsh-client-web shell library; dist/ served by apps/cli's `dsh web`"). No limitation section, hence nothing to capture.

---

## 8. Conflicts, disagreements and doc-vs-code divergences found

These matter because a clone based on the READMEs alone will be wrong in these spots.

1. **Session row height.** `WS-J:920` documents the session row as "**One top-level 34px session row**", but the CSS sets `.YDXeBa_sessionRow{height:32px}` and `.YDXeBa_projectRow{height:34px}` (`WS-J` block 1). The 34px belongs to the **workspace** row. Treat 32px as the session row height.
2. **`--dsw-static-neutral-bluish-60` differs between the light and dark static blocks** (`#f5f6f7` vs `#f9fafb`) even though the other 70+ static values are identical in both blocks. Everything that uses `neutral-bluish-60` (e.g. `bg-module-platform`, `markdown-placeholder`, `specific-selector`) therefore shifts subtly with the theme via the raw ramp, not only via the alias mapping.
3. **`--dsw-font-m-18` is named 18 but computes 16px/28px** (`TH-J`). Do not trust the token's numeric suffix; `--dsw-font-m-18-font-size:16px`.
4. **`dsh-client-ui-settings-plugins`: README says the shell card's namespace is `bash`; the compiled JS uses `shell`.** `SP-J:1058` is `const SHELL_NS = "shell";` and the card is registered under that key, while the file's own JSDoc (L1052) and both READMEs say `bash`. The *executor* family is `bash`, the *settings namespace* is `shell`.
5. **`dsh-client-ui-brand-official` says "two" and "three" occupants in the same README** ("The two occupants install as one declaration-aware registration set" vs the runtime invariant "its three slot occupants install and leave through one transactional effect"). The JS registers **two**; the third referenced slot `conversation.hero.brand.mark` is deliberately **not** registered and stays on the fallback. The JS JSDoc also calls the mark the "official **whale** mark" while the README calls the non-official fallback the "**fish** mark".
6. **`dsh-client-ui-settings` (base) declares slot *types* but renders nothing at runtime.** The slot names exist only in `lib/types/client/contract/slots.d.ts`; the runtime declarations live in `dsh-client-ui-settings-general` (children of `sidebar.settings`) and `dsh-client-ui-settings-plugins` (`settings.plugins.tab`). Its README says it "provides the standard extension points … while rendering no interface itself".
7. **The settings connection indicator's 500 ms / one-to-three-dot animation is documented in `dsh-client-ui-settings-general/README.md` but implemented in `@deepseek-ai/dsh-client-ui-primitives`** (`ConnectionIndicator`); the only timer in the settings-general JS is `RECOVERY_CONFIRMATION_MS = 2e3`.
8. **`dsh-client-ui-settings-plugin-inventory`'s preset switcher** is described as "the same selector-pill-plus-menu control the General settings rows use", but `ui-settings-general`'s JS only supplies the empty `settings.general.item` slot — the pill/menu control itself is not in any of the packages in scope (it is a `ui-primitives` component).
9. **The right panel's `openRightbar` first-open width is computed two ways.** `L-J:382` does `rightbar ??= Math.max(300, Math.round(viewport * .45))` while the render path (`L-J:236`) uses `layoutInfo.rightbar ?? viewport * .45` **unrounded**. Same intent, two expressions; a clone should round on write and clamp through `computeColumns`.
10. **Sidebar "unread" marking has no data source.** The sidebar README's limitation says the shell has no done/error notification data, and that "New task completed" unread marking is local viewing state that never reaches the host — yet `dsh-client-ui-workspace` does render `status.completed` / 已完成 dots and a `completed` flag on rows. Read them as **per-row live status**, not as an unread badge system.
11. **Section/nav ordering is fixed in code but stated in no README:** settings nav `general 0 → models 10 → plugins 15`; onboarding steps `welcome-notice −100 → deepseek-official 0`; plugins tabs `configurable 0 → inventory all 10`; Files guide entry `order: 10`.

---

## 9. Concrete clone checklist (numbers to hit)

**Shell**
- Grid: `grid-template-columns: <sidebar>px minmax(0,1fr) <rightbar>px`, `grid-template-rows:100%`, `height:100%`, `overflow:hidden`, background `--dsw-alias-bg-base`.
- Sidebar track: `56px` collapsed (rail) or `clamp(264,420)`px, default `280px`.
- Right track: `0`, or `clamp(300, viewport*0.70)`px; first open `round(viewport*0.45)`, floored at 300.
- Center reservation: `400px`.
- Auto-collapse breakpoint: `1024px`. Auto-fullscreen breakpoint for the right panel: `768px`.
- Drag handle: `8px` wide, `margin-left:-4px`, `z-index:11`, `col-resize`, pointer capture + rAF.
- Column transition: `grid-template-columns .3s cubic-bezier(.4,0,.2,1)`; suppressed while dragging and under `prefers-reduced-motion`.
- Overlay layer: `position:absolute; inset:0; z-index:20; pointer-events:none`, children `pointer-events:auto`.
- Left column border: `border-right:.5px solid var(--dsw-alias-border-l3)`, background `--dsw-specific-sidebar-fill`.
- Right panel border: `border-left:.5px solid var(--dsw-alias-border-l4)`, background `--dsw-alias-bg-base`, `transform:translate(100%)` ↔ `none` on a `.3s` transform.

**Sidebar**
- Root padding `6px 12px` (rail `18px 10px 6px`), `font-size:14px`.
- Brand row `60px` (rail `36px`), brand name `18px/600/24px` + `letter-spacing:.04em`.
- New Session `38px` tall, `border-radius:12px`, `.5px` border l3, gap 6px, label max-width 200px (rail 36×36 ghost).
- Panel row `min-height:36px`, `radius 8px`, `padding 7px 8px`, `gap 8px`; rail 36×36.
- Settings trigger `42px` tall, `radius 12px`, `padding 0 10px 0 8px`; rail 36×36 circle.
- Scroll area `scrollbar-gutter:stable`, `padding-bottom:16px`, `padding-right: calc(12px − 8px − 2px)`.
- Collapse animation `translate(49px)` at `.15s`; expand fade `.2s`; scrollbar thumb linger `2s`.

**Workspace tree**
- Workspace row **34px**; session row **32px**; search result row `min-height:48px`; section header `36px`; overflow button `28px`.
- Collapsed limit **5** ordinary sessions + the temporary blank new-session row.
- Search debounce **250ms**, max query **500** code units, max results **20**.
- Status precedence: pending-interaction (amber) > running > subagents > completed > idle; one dot + hidden labels.
- Row gap `2px` between siblings, `4px` between groups; drop indicator 12px tall, 2px line + 5×7 arrow caps in `--dsw-alias-state-business-primary`.

**Design system**
- Fonts: system UI stack + `--ds-font-family-code`; base UI sizes 11/12/13/14/16/20/24.
- Two-step content scale: primary = user setting (12–17, default 14), secondary = `min(size−1, max(13, size−2))`.
- Elevation via `.5px` stroke + two very light blur layers; `border:0` on high surfaces.
- Radii seen in the shell: 2/4/6/8/10/12/14/16/18/22/24/28/32/50%.
- Corner shape `superellipse(1.5)` under `@supports`, with `corner-shape:round` paired on every true circle/pill.
- Text colors: primary / secondary / tertiary / caption / dimmed; borders l1–l4; interactive hover/active; state success/warn/error/business; `--dsw-alias-brand-primary` is **near-black in light and near-white in dark** — the actual accent blue is `--dsw-alias-link` / `--dsw-alias-button-info-fill` / the oddly-named `--dsw-alias-brand-primary-new-colorprimary-new-color`.
- Light theme layers are **all white**; depth comes from borders + elevation only. Dark theme layers step 950 → 875 → 850 → 800.
