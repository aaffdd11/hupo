# DSH browser UI — visual design system (source of truth for a re-implementation)

> **Scope**: the visual system of the DeepSeek Harness (DSH) **browser** UI — tokens, typography, layout metrics,
> primitives, motion. Everything below is quoted verbatim from shipped CSS; no value is approximate.
> **Read-only extraction**: nothing outside `/tmp/dsh-ui/` was modified.

---

## 0. Method, corpus, and where each fact comes from

### 0.1 Corpus (4 artefacts)

| # | Artefact | Path | What it is |
|---|---|---|---|
| **A** | Theme stylesheets | `…/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js` (+ `lib/index.js`) | 6 embedded stylesheets: `base.css`, `design-platform.css`, `gradient-shadow-text.css`, `scrollbar.css`, `shiki.css`, `corner-shape.css`. Holds **every** `--dsw-static-*` / `--dsw-alias-*` definition. |
| **B** | Component CSS, revision 1 | `…/node_modules/@deepseek-ai/dsh-client-*/lib/client.js` (37 packages) | **102** `\0dsh-css:` CSS-module regions. Class names look like `Sixlwa_bubble` (hash first). This is where **chat / transcript / tool / sidebar / composer** live. |
| **C** | Component CSS, revision 2 (**prebuilt web app**) | `…/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/index-DPX2bQLO.css` (identical byte-for-byte to the live `/tmp/dshweb/index.css`, 51 949 B; 462 rules; **28** CSS modules) | Class names look like `._bubble_1nw3t_1` (name first). This build carries the **`ui-primitives` bundle** (Button, Menu, Dialog, Toast, Tooltip, Switch, Input, Tag, Pill, StatusDot, FileIcon, copy-card), **markdown** (`kcgor`), the **code block** (`rsn9u`), the **tool cards** (`1gdtu` terminal, `onbk6` read, `1h7p4` search, `12o37` diff, `19q7d` web, `4qrvp` JSON tree), **dockkit** (`17p4l`), and the boot/onboarding screens. |
| **D** | Fonts / KaTeX | `/tmp/dshweb/vendor.css` (29 288 B) | 20 `@font-face` (KaTeX_*), 231 KaTeX layout rules, one `body{counter-reset:katexEqnNo mmlEqnNo}`. **No design tokens.** |

**B and C are both live simultaneously** — the page loads `./assets/index-DPX2bQLO.css` as a `<link>` and each plugin
injects its `\0dsh-css:` region as a `<style data-plugin-css=…>` at runtime. Their class names are **disjoint**
(`Sixlwa_bubble` vs `_bubble_1nw3t_1`), so they never fight. Rule of thumb:

* **Primitives, markdown body, code block, tool cards, dockkit, boot/onboarding → corpus C.**
* **Chat transcript, composer, sidebar, trajectory, conversation skeleton → corpus B.**

`ui-primitives` is **not** an installed package in this tree — it is vendored into the dist bundle and its module
ids only appear as `inject` entries in `live-shell.html` (`"inject":[…,"@deepseek-ai/dsh-client-ui-primitives"]`).

### 0.2 Reproduction scratch (all under `/tmp/dsh-ui/`)

```
/tmp/dsh-ui/scratch-E/theme-blocks.txt            all 7 theme string literals, unescaped
/tmp/dsh-ui/scratch-E/design_platform_css_default.css   the big 15 621 B palette+alias map
/tmp/dsh-ui/scratch-E/gradient_shadow_text_css_default.css the 11 569 B type/elevation map
/tmp/dsh-ui/scratch-E/alias-resolved.txt          all 90 alias tokens, ref + resolved hex, light & dark
/tmp/dsh-ui/scratch-E/modules/*.css               the 102 `\0dsh-css:` modules
/tmp/dsh-ui/scratch-E/pretty-modules/*.css        same, pretty-printed (selector per block)
/tmp/dsh-ui/scratch-E/pretty/indexcss__<hash>.css the 28 dist modules, pretty-printed
/tmp/dsh-ui/scratch-E/pretty/indexcss__GLOBALS.css the 10 un-hashed global rules
```

---

## 1. The token system

### 1.1 Three layers (the naming contract)

```
--dsw-static-<family>-<step>     raw palette. Never used directly by components.
        │                        Defined for BOTH themes (identical values except ONE, see §1.4).
        ▼
--dsw-alias-<role>               semantic role. The ONLY layer components should consume.
--dsw-specific-<component>       component-scoped alias (bubble, sidebar-fill, menu, input-major, tip, selector, login-input)
        │
        ▼
--dsh-*    "harness" component/tunable layer  (--dsh-chat-content-width, --dsh-content-font-size, --dsh-sidebar-inline-padding, --dsh-scrollbar-*)
--dsl-*    "design-system local" per-card syntax layer (code block, terminal, read, search, diff, web)
--ds-*     global motion/typography constants (--ds-ease-in-out, --ds-transition-duration, --ds-font-family-code)
--shiki-*  syntax-highlight token colours
--turn-*, --trajectory-*  runtime-measured geometry, written inline by JS
```

Naming prefixes are load-bearing: `dsw` = design-system web, `dsh` = DSH product, `dsl` = design-system local
(per-card override point), `ds` = global constant.

### 1.2 Which selector each theme block is bound to, and how light is applied

All six theme stylesheets are injected with the prefix `\0dsh-inline-css:`; the two large ones are
`design-platform` (15 621 B, 4 rules) and `gradient-shadow-text` (11 569 B, 4 rules).

| Stylesheet | Selectors present (in order) | Notes |
|---|---|---|
| `base.css` | `:root{}` | font families + 3 motion constants. **1 rule.** |
| `design-platform.css` | `body{}` → `body[data-ds-dark-theme]{}` → `body{}` → `body[data-ds-dark-theme]{}` | rules 0/1 = **static palette** (73 props each), rules 2/3 = **alias layer** (90 props each). |
| `gradient-shadow-text.css` | `body{}` → `body,body *{}` → `body[data-ds-dark-theme]{}` → `body{}` | rules 0/1 = gradients + elevation (8 / 4 props), rule 2 = dark think-gradients only (2 props), rule 3 = **the whole `--dsw-font-*` scale + `--dsh-content-font-*`** (183 props). |
| `scrollbar.css` | `body{}`, `@supports not selector(::-webkit-scrollbar){body,body *{}}`, `::-webkit-scrollbar{…}` etc. | |
| `shiki.css` | `:root{}` + `body[data-ds-dark-theme]{}` | |
| `corner-shape.css` | `@supports (corner-shape:superellipse(1.5)){:root{}…}` | |

**Dark** = a boolean attribute on `<body>`:

```css
body[data-ds-dark-theme] { … }
```

**Light** = *the absence of that attribute*. There is no `body[data-ds-light-theme]` and no
`@media (prefers-color-scheme)` stylesheet — the bare `body{}` block **is** the light theme.

**Default is `system`, resolved in JS** (`dsh-client-ui-theme/lib/index.js`, `bootThemeScript`, inlined into
`<body>` right before the module script; verified present in the live `shell.html`):

```js
const preference = "system"                                   // DEFAULT_PREFERENCE
const systemDark = preference === 'system' && matchMedia('(prefers-color-scheme: dark)').matches
const dark = preference === 'dark' || systemDark
document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
document.body.toggleAttribute('data-ds-dark-theme', dark)
document.body.style.setProperty('--dsh-content-font-size', "14px")
```

* Preferences: `THEME_PREFERENCES = ["light","dark","system"]`; `DEFAULT_PREFERENCE = "system"`.
* Font size: `FONT_SIZE_MIN = 12`, `FONT_SIZE_MAX = 17`, `DEFAULT_FONT_SIZE = 14`, `step(1)`.
  Written as `--dsh-content-font-size` **on `<body>`** — the *only* user-tunable visual dimension.
* `ThemeRuntime` also holds a `matchMedia("(prefers-color-scheme: dark)")` listener and re-publishes while the
  preference is `system`.
* Third-party themes register alias-layer overrides; `overrideTokens` stacks partial layers **without touching the
  registry**.

### 1.3 Global resets/typography that every page inherits (corpus C, `indexcss__GLOBALS.css`)

```css
html,body,#root { height:100%; margin:0 }
body {
  font-family: var( --dsw-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
               "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial, sans-serif );
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  color: var(--dsw-alias-label-primary, #0f1115);
  background: var(--dsw-alias-bg-base, #fff);
  text-autospace: normal;
}
code,pre,[data-diff],[data-read],[data-search],[data-terminal] { text-autospace: no-autospace }
button,input,select,textarea { font-family: inherit }
```

### 1.4 Static palette (layer 1) — `body{}` / `body[data-ds-dark-theme]{}`

73 tokens. **Light and dark static blocks are byte-identical except one token**:

| token | light | dark |
|---|---|---|
| `--dsw-static-neutral-bluish-60` | `#f5f6f7` | `#f9fafb` |

(the other 72 are the same in both blocks — that is the point: the palette is theme-neutral; only the *alias* layer
switches.)

| family | steps → value |
|---|---|
| `amber` | 100 `#fef5e7` · 400 `#f7ad31` · 500 `#f59e0b` · 600 `#dd8629` · 900 `#27241f` |
| `blue` | 50 `#eff6ff` · 50p `#eaf3ff` · 75 `#e5f0ff` · 100 `#dbeafe` · 300 `#93c5fd` · 400 `#60a5fa` · 450 `#4d93f8` · 500 `#3b82f6` · 600 `#2563eb` · 800 `#1e40af` · 900 `#0e3074` · 950 `#172554` |
| `deepseek` | 50 `#edf3fe` · 100 `#e4edfd` · 200 `#d3e2ff` · 300 `#b7c8fe` · 400 `#679efe` · 450 `#5686fe` · 500 `#4176e6` · 600 `#4868b2` · 700-delete `#2f4c8f` · 800 `#34415b` · 900 `#283142` |
| `green` | 100 `#e6faed` · 400 `#4ed17e` · 500 `#22c55e` · 900 `#233c2c` |
| `neutral` | 00 `#fff` · 50 `#fafafa` · 100 `#f5f5f5` · 150 `#ededed` · 200 `#e5e5e5` · 250 `#dcdcdc` · 300 `#d4d4d4` · 400 `#a2a4a6` · 500 `#7f8287` · 550 `#65676b` · 600 `#545557` · 700 `#3c3c3d` · 800 `#292929` · 850 `#212123` · 900 `#0f0f0f` · 1000 `#000` |
| `neutral-bluish` | 00 `#fff` · 50 `#f9fafb` · 60 `#f5f6f7`(L)/`#f9fafb`(D) · 75 `#f1f3f5` · 100 `#ebeef2` · 150 `#e9ecf2` · 200 `#e1e5ee` · 300 `#cfd3d6` · 400 `#adb2b8` · 500 `#979da6` · 600 `#81858c` · 700 `#61666b` · 750 `#43454a` · 800 `#353638` · 850 `#2c2c2e` · 875 `#232324` · 900 `#1b1b1c` · 950 `#151517` · 1000 `#0f1115` |
| `red` | 50 `#fef2f2` · 100 `#fee2e2` · 400 `#f25a5a` · 500 `#ef4444` · 600 `#ec1313` · 900 `#570c0c` |

### 1.5 Semantic alias layer (layer 2) — the chat-window table

All **90** `--dsw-alias-*` + `--dsw-specific-*` tokens. 13 are identical in both themes; **77 change**.
`L` = `body{}`, `D` = `body[data-ds-dark-theme]{}`. Hex values are the fully-resolved chain
(`alias → static`), computed from the shipped map.

#### Backgrounds / surfaces

| token | LIGHT ref → hex | DARK ref → hex |
|---|---|---|
| `--dsw-alias-bg-base` | `var(--dsw-static-neutral-bluish-00)` → `#fff` | `var(--dsw-static-neutral-bluish-950)` → `#151517` |
| `--dsw-alias-bg-layer-1` | `bluish-00` → `#fff` | `bluish-875` → `#232324` |
| `--dsw-alias-bg-layer-2` | `bluish-00` → `#fff` | `bluish-850` → `#2c2c2e` |
| `--dsw-alias-bg-layer-3` | `bluish-00` → `#fff` | `bluish-800` → `#353638` |
| `--dsw-alias-bg-module-platform` | `bluish-60` → `#f5f6f7` | `bluish-800` → `#353638` |
| `--dsw-alias-bg-multi-select` | `bluish-60` → `#f5f6f7` | `--dsw-static-neutral-850` → `#212123` |
| `--dsw-alias-bg-overlay` | `bluish-150` → `#e9ecf2` | `bluish-700` → `#61666b` |
| `--dsw-alias-bg-skeleton` | `#0000000a` | `#ffffff14` |
| `--dsw-specific-bubble` (user message bubble) | `deepseek-50` → `#edf3fe` | `bluish-850` → `#2c2c2e` |
| `--dsw-specific-bubble-highlight` | `deepseek-200` → `#d3e2ff` | `bluish-750` → `#43454a` |
| `--dsw-specific-input-major` (composer fill) | `bluish-00` → `#fff` | `bluish-850` → `#2c2c2e` |
| `--dsw-specific-login-input` | `bluish-50` → `#f9fafb` | `bluish-900` → `#1b1b1c` |
| `--dsw-specific-menu` | `var(--dsw-alias-bg-layer-3)` → `#fff` | same ref → `#353638` |
| `--dsw-specific-selector` | `bluish-60` → `#f5f6f7` | `bluish-800` → `#353638` |
| `--dsw-specific-sidebar-fill` | `bluish-50` → `#f9fafb` | `bluish-900` → `#1b1b1c` |
| `--dsw-specific-sidebar-nav-item-active` | `bluish-100` → `#ebeef2` | `bluish-750` → `#43454a` |
| `--dsw-specific-sidebar-nav-item-active-accent` | `deepseek-100` → `#e4edfd` | `bluish-800` → `#353638` |
| `--dsw-specific-sidebar-nav-item-hover` | `bluish-75` → `#f1f3f5` | `bluish-850` → `#2c2c2e` |
| `--dsw-specific-tip` | `bluish-60` → `#f5f6f7` | `bluish-800` → `#353638` |
| `--dsw-alias-button-elevated-fill` | `bluish-00` → `#fff` | `bluish-750` → `#43454a` |
| `--dsw-alias-button-floating-fill` | `bluish-00` → `#fff` | `bluish-850` → `#2c2c2e` |
| `--dsw-alias-button-floating-hover` | `bluish-75` → `#f1f3f5` | `bluish-800` → `#353638` |
| `--dsw-alias-button-contrast-fill` | `bluish-700` → `#61666b` | `bluish-50` → `#f9fafb` |
| `--dsw-alias-button-primary-dimmed` | `bluish-100` → `#ebeef2` | `bluish-750` → `#43454a` |
| `--dsw-alias-button-ghost-active-fill` | `bluish-100` → `#ebeef2` | `bluish-750` → `#43454a` |
| `--dsw-alias-button-ghost-active-hover` | `bluish-150` → `#e9ecf2` | `bluish-700` → `#61666b` |
| `--dsw-alias-toast-bg` | `bluish-800` → `#353638` | `bluish-750` → `#43454a` |

#### Borders

| token | LIGHT | DARK |
|---|---|---|
| `--dsw-alias-border-l1` | `#0000000a` | `#ffffff0f` |
| `--dsw-alias-border-l2` | `#0000001a` | `#ffffff1f` |
| `--dsw-alias-border-l2-darkmode-thin` | `#0000001a` | `#ffffff0f` |
| `--dsw-alias-border-l3` | `#0000001f` | `#ffffff29` |
| `--dsw-alias-border-l4` | `#00000029` | `#fff3` |
| `--dsw-alias-border-inverted` | `#0000` | `#ffffff0f` |
| `--dsw-alias-border-inverted2` | `#0000` | `#ffffff14` |
| `--dsw-alias-button-ghost-active-border` | `bluish-500` → `#979da6` | `bluish-600` → `#81858c` |

#### Labels (text ramp)

| token | LIGHT | DARK |
|---|---|---|
| `--dsw-alias-label-primary` | `bluish-1000` → `#0f1115` | `bluish-50` → `#f9fafb` |
| `--dsw-alias-label-primary-dimmed` | `bluish-950` → `#151517` | `bluish-100` → `#ebeef2` |
| `--dsw-alias-label-primary-bluish` | `--dsw-static-blue-900` → `#0e3074` | `bluish-50` → `#f9fafb` |
| `--dsw-alias-label-primary-foreground` | `bluish-00` → `#fff` | `bluish-1000` → `#0f1115` |
| `--dsw-alias-label-primary-inverted` | `bluish-00` → `#fff` | `bluish-800` → `#353638` |
| `--dsw-alias-label-secondary` | `bluish-700` → `#61666b` | `bluish-300` → `#cfd3d6` |
| `--dsw-alias-label-tertiary` | `bluish-600` → `#81858c` | `bluish-400` → `#adb2b8` |
| `--dsw-alias-label-caption` | `bluish-400` → `#adb2b8` | `bluish-600` → `#81858c` |
| `--dsw-alias-label-dimmed` | `bluish-200` → `#e1e5ee` | `bluish-750` → `#43454a` |

#### Brand / links / interactive

| token | LIGHT | DARK |
|---|---|---|
| `--dsw-alias-brand-primary` | `bluish-1000` → `#0f1115` (**near-black, not blue**) | `bluish-50` → `#f9fafb` |
| `--dsw-alias-brand-primary-invert` | `bluish-1000` → `#0f1115` | `bluish-50` → `#f9fafb` |
| `--dsw-alias-brand-primary-new-colorprimary-new-color` | `#4176e6` (literal) | `--dsw-static-deepseek-450` → `#5686fe` (⚠ the token **name** is mangled in the shipped file — a merge artefact; reproduce spelling only if you need byte-compatibility) |
| `--dsw-alias-brand-text` | `bluish-1000` → `#0f1115` | `bluish-50` → `#f9fafb` |
| `--dsw-alias-link` | `deepseek-500` → `#4176e6` | `deepseek-400` → `#679efe` |
| `--dsw-alias-interactive-bg-hover` | `#2631480f` | `#ffffff14` |
| `--dsw-alias-interactive-bg-active` | `#2631481a` | `#ffffff24` |
| `--dsw-alias-interactive-bg-hover-accent` | `#26314824` | `#ffffff3d` |
| `--dsw-alias-interactive-bg-hover-danger` | `#ec13130d` | `#f25a5a26` |
| `--dsw-alias-interactive-bg-hover-solid` | `bluish-75` → `#f1f3f5` | `bluish-800` → `#353638` |
| `--dsw-alias-button-primary-fill` | `var(--dsw-alias-brand-primary)` → `#0f1115` | same ref → `#f9fafb` |
| `--dsw-alias-button-primary-hover` | `bluish-750` → `#43454a` | `bluish-100` → `#ebeef2` |
| `--dsw-alias-button-info-fill` | `deepseek-500` → `#4176e6` | `deepseek-400` → `#679efe` |
| `--dsw-alias-button-info-hover` | `deepseek-400` → `#679efe` | `deepseek-500` → `#4176e6` |
| `--dsw-alias-button-tool-bar-fill` | `#54555780` | `#54555780` (**identical**) |
| `--dsw-alias-button-tool-bar-fill-invisible` | `#1f1f1f5c` | `#1f1f1f5c` (**identical**) |
| `--dsw-alias-button-tool-bar-hover` | `#54555799` | `#54555799` (**identical**) |

#### State

| token | LIGHT | DARK |
|---|---|---|
| `--dsw-alias-state-success-primary` | `green-500` → `#22c55e` | `#22c55e` (**identical**) |
| `--dsw-alias-state-success-secondary` | `green-400` → `#4ed17e` | `#4ed17e` (**identical**) |
| `--dsw-alias-state-success-tertiary` | `green-100` → `#e6faed` | `green-900` → `#233c2c` |
| `--dsw-alias-state-warn-primary` | `amber-500` → `#f59e0b` | `#f59e0b` (**identical**) |
| `--dsw-alias-state-warn-secondary` | `amber-400` → `#f7ad31` | `#f7ad31` (**identical**) |
| `--dsw-alias-state-warn-label` | `amber-600` → `#dd8629` | `#dd8629` (**identical**) |
| `--dsw-alias-state-warn-tertiary` | `amber-100` → `#fef5e7` | `amber-900` → `#27241f` |
| `--dsw-alias-state-error-primary` | `red-600` → `#ec1313` | `red-400` → `#f25a5a` |
| `--dsw-alias-state-error-secondary` | `red-400` → `#f25a5a` | `#f25a5a` (**identical**) |
| `--dsw-alias-state-business-primary` | `deepseek-500` → `#4176e6` | `deepseek-400` → `#679efe` |
| `--dsw-alias-state-business-tertiary` | `deepseek-100` → `#e4edfd` | `deepseek-800` → `#34415b` |

> `business` (blue `#4176e6`) is DSH's *accent/caret/active-tab* colour — not `brand-primary`, which is the
> near-black/white contrast colour used for the primary button.

#### Markdown

| token | LIGHT | DARK |
|---|---|---|
| `--dsw-alias-markdown-code-block` | `bluish-50` → `#f9fafb` | `bluish-900` → `#1b1b1c` |
| `--dsw-alias-markdown-code-block-banner` | `bluish-50` → `#f9fafb` | `bluish-850` → `#2c2c2e` |
| `--dsw-alias-markdown-inline-code` | `--dsw-static-neutral-50` → `#fafafa` | `--dsw-static-neutral-800` → `#292929` |
| `--dsw-alias-markdown-tag` | `bluish-75` → `#f1f3f5` | `bluish-850` → `#2c2c2e` |
| `--dsw-alias-markdown-citation` | `bluish-100` → `#ebeef2` | `bluish-800` → `#353638` |
| `--dsw-alias-markdown-placeholder` | `bluish-60` → `#f5f6f7` | `bluish-850` → `#2c2c2e` |
| `--dsw-alias-markdown-code-segment-selected` | `bluish-00` → `#fff` | `bluish-800` → `#353638` |
| `--dsw-alias-markdown-code-segment-unselected` | `bluish-75` → `#f1f3f5` | `bluish-900` → `#1b1b1c` |

#### Tooltip / overlay masks

| token | LIGHT | DARK |
|---|---|---|
| `--dsw-alias-tooltip-bg` | `bluish-850` → `#2c2c2e` | `bluish-750` → `#43454a` |
| `--dsw-alias-bg-mask-1` (dialog scrim) | `#0000003d` | `#00000080` |
| `--dsw-alias-bg-mask-2` | `#0000001f` | `#0003` |
| `--dsw-alias-bg-mask-3` | `#0000007a` | `#0000007a` (**identical**) |
| `--dsw-alias-bg-mask-drop` | `#ffffffb3` | `#272730b3` |
| `--dsw-alias-bg-mask-photo` | `#000000e0` | `#000000e0` (**identical**) |

#### Scrollbar

| token | LIGHT | DARK |
|---|---|---|
| `--dsw-alias-scrollbar-bg-l1` | `--dsw-static-neutral-200` → `#e5e5e5` | `--dsw-static-neutral-700` → `#3c3c3d` |
| `--dsw-alias-scrollbar-bg-l2` | `#e5e5e5` | `--dsw-static-neutral-600` → `#545557` |
| `--dsw-alias-scrollbar-hover-l1` | `--dsw-static-neutral-300` → `#d4d4d4` | `#545557` |
| `--dsw-alias-scrollbar-hover-l2` | `#d4d4d4` | `--dsw-static-neutral-550` → `#65676b` |

#### Tokens that exist in only ONE of the two theme blocks

There are **none** — every one of the 90 alias tokens is declared in **both** `body{}` and
`body[data-ds-dark-theme]{}`. The asymmetry is in the *values*, not the key set:

* **13 identical** declared values in both blocks: `bg-mask-3`, `bg-mask-photo`,
  `button-primary-fill`, `button-tool-bar-fill`, `button-tool-bar-fill-invisible`, `button-tool-bar-hover`,
  `state-success-primary`, `state-success-secondary`, `state-warn-label`, `state-warn-primary`,
  `state-warn-secondary`, `state-error-secondary`, and `specific-menu` — the last two of these are identical
  only as *references* (`--dsw-alias-brand-primary`, `--dsw-alias-bg-layer-3`) and still **resolve to
  different colours** in dark mode.
* **77 differ.**

The only *token-key* asymmetries in the whole system are in **shiki** (§1.7) and in
`--dsw-linear-gradient-think` / `--dsw-linear-think-select`, which exist in both `body{}` and
`body[data-ds-dark-theme]{}` but whose **dark block is a separate 2-prop rule** so only the dark values override.

### 1.6 Elevation, shadows, gradients (layer-2b, `gradient-shadow-text.css`)

```css
body {                                     /* light */
  --dsw-linear-gradient-think:      linear-gradient(180deg, #fff 20.19%, #fff0 100%);
  --dsw-linear-think-select:        linear-gradient(180deg, #f5f6f7 20.19%, #f5f6f700 100%);
  --dsw-shadow-lv1:                 0 2px 4px 0 #0000000d;
  --dsw-shadow-lv1-blur:            0 4px 12px 0 #00000005;
  --dsw-shadow-lv2:                 0 4px 12px 0 #00000005, 0 2px 8px 0 #0000000a;
  --dsw-shadow-lv3:                 0 0 1px 0 #0003, 0 0 4px 0 #00000005, 0 12px 32px 0 #00000014;
  --dsw-elevation-stroke-color:     var(--dsw-alias-border-l4);
  --dsw-mask-blur:                  blur(2px);
}
body, body * {                             /* composed elevations — dark uses the SAME values */
  --dsw-elevation-stroke:    0 0 0 .5px var(--dsw-elevation-stroke-color);
  --dsw-elevation-panel:     var(--dsw-elevation-stroke), 0 3px 8px 0 #00000008, 0 0 16px 0 #00000005;
  --dsw-elevation-prominent: var(--dsw-elevation-stroke), 0 3px 8px 0 #0000000a, 0 0 20px 0 #0000000d;
  --dsw-elevation-soft:      var(--dsw-elevation-stroke), 0 4px 16px 0 #00000008, 0 0 24px 0 #00000008;
}
body[data-ds-dark-theme] {                 /* dark */
  --dsw-linear-gradient-think: linear-gradient(180deg, #151517 20.19%, #15151700 100%);
  --dsw-linear-think-select:   linear-gradient(180deg, #232325 20.19%, #23232500 100%);
}
```

Only the two think-gradients are themed; **the shadows and the three composed elevations are theme-independent.**
Components retune `--dsw-elevation-stroke-color` locally:

| where | value |
|---|---|
| `._list_1nxmc_8,._submenu_1nxmc_9` (menu) | `--dsw-elevation-stroke-color: var(--dsw-alias-border-l1)` |
| `.EvIC1a_toBottom` (scroll-to-bottom) | `--dsw-elevation-stroke-color: var(--dsw-alias-border-l3)` |
| `.uV2eYG_card` (composer) | `--dsw-elevation-stroke-color: var(--dsw-alias-border-l2)` |
| `.uV2eYG_cardWorkspaceTrigger` | `--dsw-elevation-stroke-color: transparent` |
| `._3e4SsG_menu` (composer trigger menu) | `--dsw-elevation-stroke-color: var(--dsw-alias-border-l1)` |

Usage census (13× `--dsw-elevation-prominent`, 6× `--dsw-elevation-panel`, 3× `--dsw-shadow-lv3`, …).

### 1.7 Syntax tokens (`--shiki-*`, `shiki.css`)

`:root{}` (light) / `body[data-ds-dark-theme]{}` (dark). **This is the only block with a light-only key set** —
the dark block re-declares only the 9 *token* colours; `--shiki-foreground` / `--shiki-background` are
`:root`-scoped and point at alias tokens, so they follow the theme automatically.

| token | LIGHT | DARK |
|---|---|---|
| `--shiki-foreground` | `var(--dsw-alias-label-primary)` (both themes) | ″ |
| `--shiki-background` | `var(--dsw-alias-markdown-code-block)` (both themes) | ″ |
| `--shiki-token-constant` | `#1c7ed6` | `#4dabf7` |
| `--shiki-token-string` | `#2f9e44` | `#69db7c` |
| `--shiki-token-comment` | `#868e96` | `#adb5bd` |
| `--shiki-token-keyword` | `#d6336c` | `#faa2c1` |
| `--shiki-token-parameter` | `#e8590c` | `#ffa94d` |
| `--shiki-token-function` | `#6741d9` | `#b197fc` |
| `--shiki-token-string-expression` | `#2b8a3e` | `#8ce99a` |
| `--shiki-token-punctuation` | `#495057` | `#ced4da` |
| `--shiki-token-link` | `#1971c2` | `#74c0fc` |

### 1.8 Component-level / "local" tokens

#### `--dsl-*` (per-card syntax surface) — **the values live in the dist build** (corpus C)

These are the tokens the task calls "syntax tokens". In corpus C they are *defined with real values*; in the
runtime plugin build (corpus B, `dsh-client-ui-tool`, `dsh-client-ui-sidebar-documentpreview`) only 7 of them are
set (to unstyled/neutral values) because the surrounding card supplies the skin.

| token | corpus C definition | corpus B definition (tool plugin) |
|---|---|---|
| `--dsl-code-block-background` | `var(--dsw-alias-markdown-code-block)` | `transparent` |
| `--dsl-code-block-border-radius` | `12px` | `0px` |
| `--dsl-code-block-banner-background-color` | `var(--dsw-alias-markdown-code-block-banner)` | — |
| `--dsl-code-block-banner-font` | `11px/18px var(--dsw-font-family)` | — |
| `--dsl-code-block-content-font` | `var(--dsw-font-markdown-code-block)` | `var(--dsw-font-markdown-code-block-small)` |
| `--dsl-code-block-line-white-space` | `pre` | `pre-wrap` (used as `var(…, pre-wrap)`) |
| `--dsl-code-block-line-number-width` | set inline by JS: `` `${Math.max(2,String(n).length)}ch` `` | — |
| `--dsl-terminal-radius` | `12px` | — |
| `--dsl-terminal-line-height` | `22px` | `18px` |
| `--dsl-terminal-font` | `var(--dsw-font-markdown-code-block)` | `var(--dsw-font-markdown-code-block-small)` |
| `--dsl-terminal-gutter` | `30px` | — |
| `--dsl-terminal-output-max-height` | (unset → `none` fallback) | `224px` |
| `--dsl-read-radius` | `12px` | — |
| `--dsl-read-line-height` | `22px` | — |
| `--dsl-read-gutter` | `48px` | — |
| `--dsl-search-radius` | `12px` | — |
| `--dsl-search-line-height` | `22px` | — |
| `--dsl-diff-radius` | `12px` | — |
| `--dsl-diff-line-height` | `22px` | — |
| `--dsl-web-radius` | `12px` | — |

#### `--dsh-*` (product layer) — definitions and consumers

| token | defined where | value |
|---|---|---|
| `--dsh-scrollbar-thumb` | `scrollbar.css` `body{}` | `var(--dsw-alias-scrollbar-bg-l1)` |
| `--dsh-scrollbar-thumb-hover` | `scrollbar.css` `body{}` | `var(--dsw-alias-scrollbar-hover-l1)` |
| `--dsh-scrollbar-width` | `scrollbar.css` `body{}` | `8px` |
| `--dsh-content-font-size` | inline on `<body>`, from durable setting | `12px`…`17px`, default `14px` |
| `--dsh-content-font-delta` | `gradient-shadow-text.css` `body{}` | `calc(var(--dsh-content-font-size,14px) - 14px)` |
| `--dsh-content-font-size-secondary` | ″ | `min(calc(var(--dsh-content-font-size,14px) - 1px), max(13px, calc(var(--dsh-content-font-size,14px) - 2px)))` |
| `--dsh-content-font-delta-secondary` | ″ | `calc(var(--dsh-content-font-size-secondary) - 13px)` |
| `--dsh-chat-content-width` | `.wSkVaW_root` | `var(--dsh-chat-user-width, clamp(680px, calc(var(--dsh-conversation-column-width,0px) * .64), 920px))` |
| `--dsh-chat-user-width` | inline by JS from `localStorage["dsh.conversation.contentWidth"]`; removed when unset | dragged px |
| `--dsh-conversation-column-width` | inline by JS `root.style.setProperty(…, root.offsetWidth+'px')` | measured |
| `--dsh-composer-card-max-width` | `.wSkVaW_root` | `calc(var(--dsh-chat-content-width) + 32px)` |
| `--dsh-composer-side-clearance` | `.wSkVaW_root` | `16px` |
| `--dsh-composer-dock-inset` | `.wSkVaW_root` | `8px` |
| `--dsh-composer-stack-gap` | `.wSkVaW_composerStack` | `6px` |
| `--dsh-composer-text-max-height` | `.wSkVaW_composerSeat` | `336px` |
| `--dsh-composer-height` | inline by JS `ResizeObserver` on the composer seat | measured; **fallback `152px`** |
| `--dsh-conversation-viewport-height` | inline by JS | measured; fallback `100dvh` |
| `--dsh-sidebar-inline-padding` | `.hHd-Xa_root` | `12px` |
| `--dsh-chat-flow-gap` | `.EvIC1a_column` children rule | `16px`; `[data-turn-process-answer]` → `8px` |
| `--dsh-table-spare` / `--dsh-table-lead` | `.hWmORq_body .md-table-wide` | see §2.3 |
| `--dsh-composer-hint` | inline JS (content of `::after` on last `<p>`) | hint text |
| `--dsh-toast-hold` | none (fallback only) | `var(--dsh-toast-hold, 3s)` |
| `--dsh-file-type-default-color` / `--dsh-file-type-icon-color` | `._icon_1wejo_1` / per-type rules | see §4 |
| `--dsh-state-ongoing` | `._dot_1tljr_3,._matrix_1tljr_4` | `var(--dsw-static-deepseek-450)` |
| `--dsh-boot-arc`, `--dsh-font-mono`, `--dsh-font`, `--dsh-file-type-violet` | **undefined/partial** | see §1.9 |

#### `--ds-*` global constants (`base.css` `:root{}`)

```css
--dsw-font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB",
                   "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial, sans-serif;
--ds-font-family-code: "SF Mono", "JetBrains Mono", "Fira Code", Consolas, "Liberation Mono", Menlo, Courier,
                       "PingFang SC", "Microsoft YaHei";
--ds-ease-in-out: cubic-bezier(.4, 0, .2, 1);
--ds-transition-duration: .2s;
--ds-transition-duration-fast: .1s;
--ds-transition-duration-slow: .3s;
```

#### `corner-shape.css` — the squircle signature

```css
@supports (corner-shape:superellipse(1.5)) {
  :root{ --dsw-corner-shape: superellipse(1.5) }
  *, :before, :after { corner-shape: var(--dsw-corner-shape) }
}
```

Every rounded rect in DSH is a **superellipse(1.5) squircle** on browsers that support `corner-shape`.
49 component rules additionally pin `corner-shape: round` (circles, pills, switches) — those must stay perfectly
round even under the global superellipse.

#### Scrollbar

```css
body { --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l1);
       --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l1);
       --dsh-scrollbar-width: 8px }
@supports not selector(::-webkit-scrollbar) { body, body * { scrollbar-width:thin;
                                                             scrollbar-color:var(--dsh-scrollbar-thumb) transparent } }
::-webkit-scrollbar            { width:8px; height:8px }
::-webkit-scrollbar-track      { background:0 0 }
::-webkit-scrollbar-thumb      { background:var(--dsh-scrollbar-thumb); border-radius:4px }
::-webkit-scrollbar-thumb:hover{ background:var(--dsh-scrollbar-thumb-hover) }
::-webkit-scrollbar-corner     { background:0 0 }
```

Recoloured locally (L2 = darker/higher-contrast tier) in: `.hHd-Xa_root` (sidebar),
`.wSkVaW_scrollBody`-family, `._list_1nxmc_8`, `._3e4SsG_menu`, `.uV2eYG_card`, `.*_header_1gdtu_32`,
`.*_output_1gdtu_156`, `.*_ioSection_*`. Sidebars also have a "quiet bars" state:
`.hHd-Xa_quietBars { --dsh-scrollbar-thumb: transparent; --dsh-scrollbar-thumb-hover: transparent }`.

### 1.9 Referenced-but-never-defined tokens (defects to NOT reproduce)

29 identifiers are consumed with `var()` but defined nowhere in the shipped CSS or JS:

`--dsw-alias-bg-layer-4`, `--dsw-alias-fill-l2`, `--dsw-alias-fill-tertiary`, `--dsw-alias-fill-tsp-secondary`,
`--dsw-alias-label-error` (3×), `--dsw-alias-label-quaternary`, `--dsw-alias-separator-primary`,
`--dsw-font`, `--dsw-font-mono` (3×), `--dsw-font-sm-13`, `--dsh-font-mono`, `--dsh-boot-arc`,
`--dsh-file-type-icon-color`, `--pdf-page-width`, and 13 `--trajectory-*` / `--request-boundary-offset`
geometry vars (those *are* written by JS at runtime, just not present statically).

Note `--dsw-font-*` name quirks worth mirroring for byte-compatibility but not for logic: `--dsw-font-m-18`
is **16px/28px** (not 18px); `--dsw-font-xxxs-*` is 11px.

---

## 2. Typography

### 2.1 Families

| role | token | value | consumed by |
|---|---|---|---|
| UI | `--dsw-font-family` (`:root`, `base.css`) | `-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial, sans-serif` | every `--dsw-font-*` composite, `body`, `--dsh-font-markdown-*`, `.uV2eYG_input` |
| Code | `--ds-font-family-code` (`:root`, `base.css`) | `"SF Mono", "JetBrains Mono", "Fira Code", Consolas, "Liberation Mono", Menlo, Courier, "PingFang SC", "Microsoft YaHei"` | `--dsw-font-markdown-code*`, `--dsl-terminal-font`, `.hHd-Xa_buildVersion`, `.XrJvXW_body` |
| KaTeX | `KaTeX_*` (20 `@font-face`, `vendor.css`, `font-display:block`) | `KaTeX_AMS / Caligraphic / Fraktur / Main / Math / SansSerif / Script / Size1-4 / Typewriter` in woff2/woff/ttf | math |

`button,input,select,textarea { font-family: inherit }`; `code,pre,[data-diff],[data-read],[data-search],[data-terminal] { text-autospace: no-autospace }`.

### 2.2 The complete `--dsw-font-*` scale (30 families × shorthand + 5 decomposed properties, `gradient-shadow-text.css`)

Component shorthand (`--dsw-font-<n>`) plus 5 decomposed properties (`-font-family`, `-font-weight`,
`-font-size`, `-line-height`, `-font-style`). `Δ` = `var(--dsh-content-font-delta)`; `Δ₂` = `var(--dsh-content-font-delta-secondary,0px)`; `C` = `var(--dsh-content-font-size,14px)`; `C₂` = `var(--dsh-content-font-size-secondary,13px)`.

| token | weight | size | line-height | style | family |
|---|---|---|---|---|---|
| `--dsw-font-xl-24` | 600 | `24px` | `32px` | normal | `--dsw-font-family` |
| `--dsw-font-l-20` | 500 | `20px` | `28px` | normal | ″ |
| `--dsw-font-m-18` | 500 | `16px` | `28px` | normal | ″ |
| `--dsw-font-base-16` | 400 | `16px` | `24px` | normal | ″ |
| `--dsw-font-base-strong-16` | 500 | `16px` | `24px` | normal | ″ |
| `--dsw-font-s-14` | 400 | `14px` | `22px` | normal | ″ |
| `--dsw-font-s-strong-14` | 500 | `14px` | `22px` | normal | ″ |
| `--dsw-font-xs-13` | 400 | `13px` | `20px` | normal | ″ |
| `--dsw-font-xs-strong-13` | 500 | `13px` | `20px` | normal | ″ |
| `--dsw-font-xxs-12` | 400 | `12px` | `18px` | normal | ″ |
| `--dsw-font-xxs-strong-12` | 500 | `12px` | `18px` | normal | ″ |
| `--dsw-font-xxxs-11` | 400 | `11px` | `14px` | normal | ″ |
| `--dsw-font-xxxs-strong-11` | 500 | `11px` | `14px` | normal | ″ |
| `--dsw-font-markdown-h1` | 700 | `calc(21px + Δ)` | `calc(30px + Δ)` | normal | ″ |
| `--dsw-font-markdown-h2` | 700 | `calc(19px + Δ)` | `calc(28px + Δ)` | normal | ″ |
| `--dsw-font-markdown-h3` | 700 | `calc(18px + Δ)` | `calc(26px + Δ)` | normal | ″ |
| `--dsw-font-markdown-h4` | 600 | `C` | `calc(24px + Δ)` | normal | ″ |
| `--dsw-font-markdown-base` | 400 | `C` | `calc(24px + Δ)` | normal | ″ |
| `--dsw-font-markdown-base-strong` | 600 | `C` | `calc(24px + Δ)` | normal | ″ |
| `--dsw-font-markdown-base-italic` | 400 | `C` | `calc(24px + Δ)` | **italic** | ″ |
| `--dsw-font-markdown-base-strong-italic` | 600 | `C` | `calc(24px + Δ)` | **italic** | ″ |
| `--dsw-font-markdown-table` | 400 | `C₂` | `calc(22px + Δ₂)` | normal | ″ |
| `--dsw-font-markdown-table-head` | 500 | `C₂` | `calc(22px + Δ₂)` | normal | ″ |
| `--dsw-font-markdown-small` | 400 | `12px` | `20px` | normal | ″ |
| `--dsw-font-markdown-small-strong` | 600 | `12px` | `20px` | normal | ″ |
| `--dsw-font-markdown-small-italic` | 400 | `12px` | `20px` | **italic** | ″ |
| `--dsw-font-markdown-small-strong-italic` | 600 | `12px` | `20px` | **italic** | ″ |
| `--dsw-font-markdown-code` | 400 | `12px` | `19px` | normal | `--ds-font-family-code` |
| `--dsw-font-markdown-code-block` | 400 | `11px` | `19px` | normal | ″ |
| `--dsw-font-markdown-code-block-small` | 400 | `11px` | `16px` | normal | ″ |

With the default `--dsh-content-font-size: 14px` → `Δ = 0`, `Δ₂ = 0`, `C = 14px`, `C₂ = 13px`, so the resolved
defaults are h1 `21/30`, h2 `19/28`, h3 `18/26`, h4 `14/24`, base `14/24`, table `13/22`.

### 2.3 Element → size / line-height / weight / colour (chat, transcript, composer, sidebar, tool)

Colour column = the token literally in the CSS (blank = inherits `--dsw-alias-label-primary` from `body`).

| element (selector) | size | line-height | weight | colour |
|---|---|---|---|---|
| `body` | inherited | — | — | `--dsw-alias-label-primary` |
| `.EvIC1a_turnStatus` (streaming status line) | `var(--dsh-content-font-size,14px)` | `calc(22px + Δ)` | 500 (`font:var(--dsw-font-s-strong-14)`) | transparent + shimmer gradient (§5) |
| `.EvIC1a_turnStatusClock` | `var(--dsh-content-font-size-secondary,13px)` (13px) | `calc(20px + Δ₂)` | 400 | `--dsw-alias-label-caption` |
| `.EvIC1a_hint`, `.EvIC1a_openError` | 13px | `calc(18px + Δ₂)` | — | `--dsw-alias-label-tertiary` / `--dsw-alias-state-error-primary` |
| `.EvIC1a_older button` | `12px` | — | — | `--dsw-alias-label-secondary` |
| `.Sixlwa_bubble` (user message) | `var(--dsh-content-font-size,14px)` | `calc(22px + Δ)` | — | `--dsw-alias-label-primary` |
| `.hWmORq_root` (assistant markdown wrapper) | `var(--dsh-content-font-size,14px)` | `calc(24px + Δ)` | 400 (`--dsw-font-markdown-base`) | `--dsw-alias-label-primary` |
| `.hWmORq_stopped` | `11px` | `18px` | — | `--dsw-alias-label-tertiary` |
| `._markdown_kcgor_5 h1` | `calc(21px + Δ)` | `calc(30px + Δ)` | 700 | inherit |
| `._markdown_kcgor_5 h2` | `calc(19px + Δ)` | `calc(28px + Δ)` | 700 | inherit |
| `._markdown_kcgor_5 h3` | `calc(18px + Δ)` | `calc(26px + Δ)` | 700 | inherit |
| `._markdown_kcgor_5 h4`, `:where(h5,h6)` | `14px` | `calc(24px + Δ)` | 600 / h5-h6 600 | inherit |
| `._markdown_kcgor_5 :not(pre)>code` | `font:var(--dsw-font-markdown-code)` then `font-size:.875em!important` (`12px` → 10.5px) | `19px` | 400 | inherit |
| `._markdown_kcgor_5 pre` / `._block_rsn9u_4 :where(pre)` | `var(--dsl-code-block-content-font)` = `--dsw-font-markdown-code-block` (`11px/19px` in C; `-small` `11px/16px` in B) | 19px | 400 | inherit |
| `._banner_rsn9u_24` (code-block banner) | `var(--dsl-code-block-banner-font)` = `11px/18px var(--dsw-font-family)` | 18px | inherit | inherit |
| `._infostring_rsn9u_45` | `11px` | `18px` | — | — |
| `._markdown_kcgor_5 th` | `13px` | `calc(22px + Δ₂)` | 500 | inherit |
| `._markdown_kcgor_5 td` | `13px` | `calc(22px + Δ₂)` | 400 | inherit |
| `._markdown_kcgor_5 table code` | `11px` | — | — | — |
| `._refChip_z12h9_11` | `inherit` | `inherit` | 500 | `--dsw-alias-state-business-primary` |
| `._slashChip_z12h9_27` | inherit | inherit | — | — (family = `--dsw-font-markdown-code-font-family`) |
| `.lcKema_summary` (reasoning summary) | 13px | `calc(20px + Δ₂)` | — | — |
| `.lcKema_thinkBody` | 13px | `calc(20px + Δ₂)` | — | — |
| `.o3BgMG_summary` (tool row summary) | 13px | `calc(24px + Δ)` | — | — |
| `.o3BgMG_title` | inherit | inherit | 400 (500 for `[data-tool^=cordis_]`) | — |
| `.o3BgMG_fileLink` | 13px | `calc(24px + Δ)` | inherit | — |
| `.o3BgMG_inspectButton` | `11px` | `16px` | — | — |
| `.o3BgMG_ioCard`, `.CY-8Ka_ioCard` | `var(--dsw-font-markdown-code-block-small)` = `11px/16px` mono | 16px | 400 | — |
| `.o3BgMG_diffStat` | `calc(var(--dsh-content-font-size-secondary,13px) - 2px)` = 11px | — | — | — |
| `.l_V-RG_label` (turn-process header) | `14px` | `24px` | — | — |
| `.Q51KRG_trigger` (usage) | 13px | `calc(24px + Δ)` | — | — |
| `.bOPqQW_root` (stats pills row) | `var(--dsh-content-font-size-secondary,13px)` | `calc(20px + Δ₂)` | — | — |
| `.bOPqQW_pill` | `inherit` | `inherit` | — | — |
| `.xzv4MW_timeStart`, `.xzv4MW_timeEnd` | 13px | `calc(24px + Δ)` | — | — |
| `.xzv4MW_timeStart` (padding) | — | — | — | `padding-right:12px` |
| `.ZkiH0q_fieldKey` (context body) | inherit | inherit | — | `min-width:96px` |
| `.XrJvXW_body` (context injection body) | `font:400 11px/16px var(--ds-font-family-code)` | 16px | 400 | — |
| `.wSkVaW_crumb`, `.wSkVaW_crumbSep` (header breadcrumb) | `14px` | `20px` | — | `--dsw-alias-label-tertiary` / `--dsw-alias-label-caption` |
| `.wSkVaW_crumbCurrent` | ″ | ″ | 500 | `--dsw-alias-label-primary` |
| `.wSkVaW_crumbSubagent` | `12px` | `18px` | — | — |
| `.wSkVaW_tab` (session tabs) | `13px` | `16px` | 500 | `--dsw-alias-label-tertiary`; active `--dsw-alias-state-business-primary` |
| `.uV2eYG_card` (composer surface) | `var(--dsh-content-font-size,14px)` | `calc(24px + Δ)` | inherit | — |
| `.uV2eYG_input` | `inherit` | `inherit` | inherit | `--dsw-alias-label-primary`; caret `--dsw-alias-state-business-primary` |
| `.uV2eYG_placeholder` | inherit | inherit | — | `--dsw-alias-label-caption` |
| `.uV2eYG_input p:last-child:after` (hint) | inherit | inherit | — | `--dsw-alias-label-caption` |
| `.uV2eYG_notice` | `12px` | `18px` | — | `--dsw-alias-label-secondary` |
| `.uV2eYG_select` (model/permission select) | `13px` | `20px` | 500 | `--dsw-alias-label-secondary` |
| `.uV2eYG_retry` | `12px` | — | — | inherit |
| `.pXSMma_headline` (hero) | `26px` | `32px` | 500 | — |
| `.pXSMma_previewBadge` | `12px` | `18px` | 500 | — |
| `.pXSMma_workspace` | `13px` | `20px` | 500 | — |
| `.pXSMma_modalInput` | `14px` | `22px` | 400 | — |
| `.pXSMma_modalError` | `12px` | `18px` | — | — |
| `.lXshSW_title`, `.lXshSW_progress`, `.lXshSW_item` (todo panel) | `13px` | `24px` / `20px` / `20px` | 500 / 400 / — | — |
| `._7yHdaG_count` (queue) | `13px` | `24px` | 500 | — |
| `._7yHdaG_fileName`, `._7yHdaG_preview`, `._7yHdaG_editor`, `._7yHdaG_status` | `var(--dsw-font-xs-13)` = 13px/20px | 20px | 400 | — |
| `._7yHdaG_fileSize` | `10px` | — | — | — |
| `.Sh0Q9G_trigger` (permission trigger) | `13px` | `20px` | 500 | — |
| `.hHd-Xa_root` (sidebar) | `14px` | — | — | `--dsw-alias-label-primary` |
| `.hHd-Xa_brandName` | `18px` (+`letter-spacing:.04em`) | `24px` | 600 | inherit |
| `.hHd-Xa_fallbackBrandName` | `17px` | — | — | — |
| `.hHd-Xa_localBuildTitle` | `12px` | `13px` | — | — |
| `.hHd-Xa_buildVersion` | `6px` (mono) | `10px` | 500 | bg `--dsw-alias-label-primary`, text `--dsw-alias-label-primary-inverted`, radius `2px`, padding `0 3px`, height `10px` |
| `.hHd-Xa_newSession` | `14px` | `22px` | 500 | `--dsw-alias-label-primary` |
| `.hHd-Xa_panelRow` | `inherit` | `22px` | 400 (500 when `.panelActive`) | `--dsw-alias-label-secondary` → active `--dsw-alias-label-primary` |
| `.P3OORG_unavailable` (right panel) | 13px | — | — | `--dsw-alias-label-tertiary` |
| `.JObwrW_panel` (context meter popover) | `12px` | `20px` | — | — |
| `.fsXYAq_question/.answer/.verdict/.unansweredQuestion` (ask-question card) | `var(--dsh-content-font-size,14px)` | `calc(24px + Δ)` | — | — |
| `.*_label_onbk6_26`, `.*_lang_onbk6_49` (read card) | `12px` | `18px` | — | — |
| `.*_sourceLink_19q7d_54` (web card) | `14px` | `20px` | 500 | — |
| `.*_snippet_19q7d_78` | `13px` | `19px` | — | — |
| `.*_fetchUrl_19q7d_110` | `13px` | `19px` | 500 | — |
| font-size census over the whole component corpus | `12px`×109, `14px`×72, `13px`×62, `11px`×43, 13px-token×44, 14px-token×16, `16px`×7, `15px`×5, `12.5px`×5, `18px`×4, `10px`×4, `26px`×1, `20px`×1, `17px`×1, `6px`×1 | — | — | — |
| font-weight census | `500`×69, `400`×27, `600`×19, `510`×5, `650`×1 | — | — | — |

> **Key rule**: the transcript body is expressed *relationally* — `var(--dsh-content-font-size)` and
> `calc(Npx + var(--dsh-content-font-delta))`. A re-implementation that hard-codes 14px/24px will break the
> user's font-size setting (12–17px) and every downstream line-height.

---

## 3. Layout metrics

### 3.1 The shell: three-column grid (algorithm in `dsh-client-ui-layout/lib/client.js`)

```js
const SIDEBAR_AUTO_COLLAPSE = 1024;   // deepsuite LG breakpoint
const RIGHTBAR_MAX_RATIO   = .7;
const RIGHTBAR_DEFAULT_RATIO = .45;

function computeColumns(viewport, sidebar, rightbar) {
  const s = sidebar === 0 ? 56 : clampWidth(sidebar, 264, 420);
  const available = viewport - s - 400;
  const r = rightbar === 0 || available < 300
          ? 0
          : Math.min(available, clampWidth(rightbar, 300, viewport * RIGHTBAR_MAX_RATIO));
  return { sidebar: s, center: Math.max(0, viewport - s - r), rightbar: r };
}
```

| fact | value | source |
|---|---|---|
| sidebar preference default | `280` | `sidebar: 280` literal in layout client.js |
| sidebar clamp | `264` … `420` px | `clampWidth(sidebar, 264, 420)` |
| sidebar rail (collapsed) width | **`56px`** | `sidebar === 0 ? 56` |
| auto-collapse viewport threshold | **`1024px`** (`SIDEBAR_AUTO_COLLAPSE`) | comment: *"deepsuite LG breakpoint"*; a manual toggle below it re-expands over the squeezed center (`stores.ts narrowExpanded`) |
| right panel min / max | `300` … `viewport * 0.7` | `clampWidth(rightbar, 300, viewport * RIGHTBAR_MAX_RATIO)` |
| right panel first-open default | `45%` of frame (`RIGHTBAR_DEFAULT_RATIO = .45`) | idem |
| center-column reserve before the right panel appears | `400px` (i.e. `viewport - s - 400 ≥ 300`) | `available = viewport - s - 400` |
| grid | `gridTemplateColumns: \`${cols.sidebar}px minmax(0, …)\`` | layout client.js |
| frame | `.pI_x6G_frame { height:100%; grid-template-rows:100%; display:grid; position:relative; overflow:hidden; background:var(--dsw-alias-bg-base); transition:grid-template-columns var(--ds-transition-duration-slow) var(--ds-ease-in-out) }` | AppFrame |
| drag-resize handle | `.pI_x6G_handle { width:8px; margin-left:-4px; cursor:col-resize; touch-action:none; position:absolute; top:0; bottom:0; z-index:11; transition:left var(--ds-transition-duration-slow) var(--ds-ease-in-out) }` | AppFrame |
| overlay layer | `.pI_x6G_overlayLayer { z-index:20; pointer-events:none; position:absolute; inset:0 }` → children `pointer-events:auto` | AppFrame |
| left column | `.pI_x6G_sidebarCol { background:var(--dsw-specific-sidebar-fill); border-right:.5px solid var(--dsw-alias-border-l3); min-width:0; overflow:hidden }` | AppFrame |
| right column | `.pI_x6G_rightbarCol { min-width:0; position:relative; overflow:visible }` | AppFrame |

### 3.2 Left sidebar (`ui-sidebar/SidebarRoot.module.css`)

| selector | metric |
|---|---|
| `.hHd-Xa_root` | `--dsh-sidebar-inline-padding:12px`; `padding:6px 12px`; `height:100%`; `font-size:14px`; `background:var(--dsw-specific-sidebar-fill)` |
| `.hHd-Xa_root.hHd-Xa_collapsed` | `padding:18px 10px 6px` (rail) |
| `.hHd-Xa_logoRow` | `height:60px`; `margin-bottom:8px`; `padding:8px 0 8px 4px`; `gap:8px` |
| `.hHd-Xa_collapsed .hHd-Xa_logoRow` | `height:36px`; `margin-bottom:12px`; `padding:0` |
| `.hHd-Xa_brandIdentity`, `.hHd-Xa_brandName`, `.hHd-Xa_localBuildBrand` | `height:24px`; `gap:8px` / `gap:6px` / `gap:1px` |
| `.hHd-Xa_iconButton` | `width:28px; height:28px; border-radius:50%; padding:0` |
| `.hHd-Xa_collapsed .hHd-Xa_iconButton` | `width:36px; height:36px` |
| `.hHd-Xa_newSession` | `height:38px`; `border:.5px solid var(--dsw-alias-border-l3)`; `border-radius:12px`; `margin:0 2px 8px`; `padding:8px 16px`; `gap:6px` |
| `.hHd-Xa_collapsed .hHd-Xa_newSession` | `width:36px; height:36px`; `margin:0 0 12px`; `padding:0`; `gap:0` |
| `.hHd-Xa_newSessionLabel` | `max-width:200px` (→ `0` collapsed) |
| `.hHd-Xa_panelList` | `gap:4px`; `margin-bottom:8px` (collapsed `gap:12px; margin-bottom:12px`) |
| `.hHd-Xa_panelRow` | `min-height:36px`; `gap:8px`; `padding:7px 8px`; `border-radius:8px`; `line-height:22px` |
| `.hHd-Xa_collapsed .hHd-Xa_panelRow` | `width:36px; height:36px; padding:0` |
| `.hHd-Xa_regionArea` | `margin-left:-4px`; `margin-right:calc(-1 * var(--dsh-sidebar-inline-padding))`; `padding-left:4px` |
| `.hHd-Xa_footArea` | `flex-direction:column; flex:none` (collapsed: `align-items:center`) |
| `.hHd-Xa_fading>*` | `opacity:0; transition:opacity .15s var(--ds-ease-in-out)` |

### 3.3 Right sidebar / DockKit (`ui-sidebar-right`, dist `17p4l`)

| selector | metric |
|---|---|
| `.P3OORG_panel` | `position:absolute; top:0; bottom:0; right:0`; `transform:translate(100%)`; `border-left:.5px solid var(--dsw-alias-border-l4)`; `background:var(--dsw-alias-bg-base)`; `visibility:hidden`; `z-index:10`; `transition:transform var(--ds-transition-duration-slow) var(--ds-ease-in-out), visibility 0s linear var(--ds-transition-duration-slow)` |
| `.P3OORG_panel[data-sidebar-right-open]` | `visibility:visible; transform:none; transition:transform var(--ds-transition-duration-slow) var(--ds-ease-in-out)` |
| `.P3OORG_panel[data-sidebar-right-panel=fullscreen]` | `position:fixed; inset:0; z-index:40; border:none` |
| `.P3OORG_iconButton`, `._1kL45W_button` | `28px×28px`; `padding:6px`; `border-radius:28px`; `svg { width:15px; height:15px }` |
| `.P3OORG_collapseGlyph`, `._1kL45W_icon`, `._dockGlyph_17p4l_681` | `transform:scaleX(-1)` |
| `.P3OORG_unavailable` | `padding:12px` |
| `._float_17p4l_306` | `border-radius:20px; box-shadow:var(--dsw-elevation-prominent)` |
| `._floatResize_17p4l_696` | `width:20px; height:20px` at `right:0;bottom:0`; `:after` `16×16` at `right:4px;bottom:4px`; `border-right/bottom:1.5px solid var(--dsw-alias-label-caption)`; `transition:opacity .12s ease-out`; hover → `--dsw-alias-label-tertiary` |
| `._tabStrip_17p4l_156` | `height:28px; gap:4px; padding:10px 6px 0 10px` |
| `._tab_17p4l_156` | `min-width:80px; max-width:170px; height:28px; padding:0 10px; border-radius:12px; font-size:var(--dsh-content-font-size-secondary,13px); line-height:1` |
| `._tabClose_17p4l_314` | `20×20` at `top:4px; right:4px`; `border-radius:20px` |
| `._addTab_17p4l_346` | `28×28`; `border-radius:12px` |
| `._slot_17p4l_224` | `10×28`; `:before` `0.5px×14` |
| `._slotCaret_17p4l_243:before` | `2px×20` |
| `._stripChrome_17p4l_212` | `height:28px; gap:8px; margin-left:4px` |
| `._menu_17p4l_444` | `min-width:96px; padding:4px; border:.5px solid var(--dsw-alias-border-l2); border-radius:6px; z-index:70` |
| `._menuItem_17p4l_460` | `padding:5px 8px; border-radius:4px; font-size:13px` |
| `._dockScrim_17p4l_498` | `inset:0; z-index:10; animation:_dockScrimIn_17p4l_1 .14s ease-out` |
| `._dockHint_17p4l_500` | `padding:8px; z-index:10`; zones: `center{inset:0}`, `left/right{width:40%}`, `top/bottom{height:40%}`; horizontal mode → `width:50%` + `padding-right/left:4px` |
| `._dockHintCard_17p4l_505` | `padding:12px; border:1.5px dashed var(--dsw-alias-border-l2); border-radius:12px; gap:8px; animation:_dockHintIn_17p4l_1 .14s ease-out; transition:color .12s ease-out,background-color .12s ease-out,border-color .12s ease-out`; `svg{20×20}` |
| `._dockHintCard` when `[data-dockkit-drop-active]` | `border-color:var(--dsw-alias-brand-primary-new-colorprimary-new-color)` |
| `._divider_17p4l_39` | row: `width:0`, `:before{width:.5px; top:0;bottom:0;left:-.25px}`, `:after{inset:0 -4px}`; column mirrored; `:after { transition:opacity .12s ease-out }` |

### 3.4 Transcript (chat)

| selector | metric |
|---|---|
| `.EvIC1a_scroll` (scroller) | `padding:16px calc(var(--dsh-composer-side-clearance) + 16px)` = **`16px 32px`**; `overflow-y:auto`; `container-type:inline-size` |
| `.EvIC1a_column` | `max-width:var(--dsh-chat-content-width)`; `width:100%`; `margin:0 auto` |
| **content width** | `max(680, min(columnWidth * 0.64, 920))` where `columnWidth = root.offsetWidth` (JS `resolveContentWidth`), or the dragged preference, floored at `CONTENT_MIN = 640` and capped at `max(640, columnWidth - CONTENT_EDGE_BUDGET)` with `CONTENT_EDGE_BUDGET = 176` (**88px per side**); persisted at `localStorage["dsh.conversation.contentWidth"]` |
| row gap | `.EvIC1a_column>:not([hidden])…~… { margin-top:var(--dsh-chat-flow-gap,16px) }`; `[data-turn-process-answer]` sets `--dsh-chat-flow-gap:8px` |
| `.EvIC1a_callRow` | `border-radius:6px` |
| `.EvIC1a_turnStatus` | `height:calc(26px + Δ)`; `align-self:flex-start` |
| `.EvIC1a_toBottomSlot` | `position:sticky; bottom:16px; height:0; z-index:8; padding-right:max(0px, calc((100% - var(--dsh-chat-content-width)) / 2))`; in `[data-conversation-scroll]`: `bottom:calc(var(--dsh-composer-height,152px) + 16px)` |
| `.EvIC1a_toBottom` (FAB) | `34×34`; `border-radius:100px`; `margin-top:-34px`; `box-shadow:var(--dsw-elevation-panel)`; `background:var(--dsw-alias-button-floating-fill)`; hover `--dsw-alias-button-floating-hover` |
| `.EvIC1a_modalAction` | `min-width:72px` |
| `.Sixlwa_userRow` | `align-items:flex-end; gap:6px` |
| `.Sixlwa_userStack` | `max-width:min(calc(var(--dsh-chat-content-width,748px) * .702), 82%)`; `gap:8px` |
| `.Sixlwa_bubble` | `border-radius:22px`; `padding:10px 16px`; `background:var(--dsw-specific-bubble)` |
| `.Sixlwa_attachmentRow` | `gap:8px`; `flex-wrap:wrap`; right-aligned |
| `.Sixlwa_fileCard` | `width:240px`; `flex:0 0 240px`; `min-height:64px`; `padding:8px 12px`; `gap:10px`; `border:.5px solid var(--dsw-alias-border-l2)`; `border-radius:16px` |
| `.Sixlwa_fileIcon` | `28×28` |
| `.Sixlwa_compactionLeading` | `width/height:calc(16px + Δ)`; `margin-right:6px`; svg `calc(14px + Δ)` |
| `.Sixlwa_compactionSep` | `2×2`; `margin:0 8px`; `border-radius:1px` |
| `.Sixlwa_compactionBody` | `padding:4px 0 4px calc(22px + Δ)` |
| `.Sixlwa_retrySummary:after` | `6×6`; `border-bottom/right:1.5px solid`; `transition:transform .12s`; `rotate(-45deg)` → `[open]` `rotate(45deg)` |
| `.Sixlwa_turnErrorRow` | `grid-template-columns:10px minmax(0,1fr) auto`; `gap:8px` |
| `.Sixlwa_turnErrorDot` | `margin-top:5px` |
| `.hWmORq_body` | `gap:16px` |
| `.hWmORq_body>[data-turn-process-inline][hidden]` | `margin-bottom:-16px` |
| `.hWmORq_actions` | `margin-top:16px; margin-left:-6px` |
| `.TS9iAW_root` (turn tail) | `gap:16px`; `.TS9iAW_actions { margin-top:4px; margin-left:-6px }` |
| `.l_V-RG_root` (turn process header) | `height:33px`; `padding:0 0 8px`; `border-bottom:.5px solid var(--dsw-alias-border-l2)`; `:not([data-open])` → `margin-bottom:8px` |
| `.l_V-RG_chevron` | `16×16`; `margin-left:6px`; `transition:transform .1s`; closed `rotate(-90deg)` |
| `.o3BgMG_bodyScroll` | `max-height:260px` |
| `.o3BgMG_ioCard` | `border-radius:12px`; `margin:4px 0 4px 4px`; `border:.5px solid var(--dsw-alias-border-l1)` |
| `.o3BgMG_ioSection` | `grid-template-columns:max-content 1fr`; `column-gap:14px`; `max-height:150px`; `padding:12px 16px` |
| `.ztWv_q_subCalls` (tool call tree) | `border-left:.5px solid var(--dsw-alias-border-l2)`; `gap:4px`; `margin:4px 0 2px 22px`; `padding-left:8px` |
| `.o3BgMG_sep` / `.lcKema_separator` / `._5OnbHa_separator` | `2×2`; `border-radius:1px`; `margin:0 8px` |
| `.fsXYAq_card` (ask-question) | `border:.5px solid var(--dsw-alias-border-l1)`; `border-radius:12px`; `gap:16px`; `max-height:360px`; `margin:4px 0 4px 4px`; `padding:16px 20px` |
| `.bOPqQW_root` (stats pills) | `max-width:var(--dsh-chat-content-width)`; `padding:4px calc(var(--dsh-composer-side-clearance) + 16px) 0`; `gap:12px`; `margin:0 auto` |
| `.bOPqQW_pill` | `border-radius:24px`; `padding:1px 8px`; `gap:6px`; `svg{14×14}` |
| `.xzv4MW_actions` | `height:calc(28px + Δ)`; `gap:8px` |
| `.xzv4MW_action` | `calc(28px + Δ)` square; `border-radius:28px`; `padding:6px`; `svg calc(15px + Δ)` |
| `.xzv4MW_timeStart` | `padding-right:12px` |
| `.eGxaPq_frame` (turn navigator rail) | `width:28px`; `right:calc(12px - (var(--dsh-composer-side-clearance) + 16px))` = **`-20px`**; `top:calc(var(--turn-rail-band)/2)` where `--turn-rail-band: calc(var(--dsh-conversation-viewport-height,100dvh) - var(--dsh-composer-height,152px))`; `height:min(var(--turn-natural-height), max(0px, calc(var(--turn-rail-band) - 64px)), 420px)`; `transform:translateY(-50%)`; `transition:height .22s cubic-bezier(.2,.8,.2,1)` |
| `.eGxaPq_markPosition` | `height:10px`; `transition:top .22s cubic-bezier(.2,.8,.2,1)` |
| `.eGxaPq_mark` | `width:20px`; `border-radius:8px` |
| `.eGxaPq_mark:before` | `12×2`; `border-radius:2px`; `transition:width .14s,background-color .14s`; `markUnloaded`→`8px`, `markPreview`→`18px`, `markActive`/`:focus-visible`→`20px` |
| `.eGxaPq_preview` | `width:min(300px, 100cqw - 120px)`; `max-height:var(--turn-preview-height)` = `100px`; `border-radius:10px`; `padding:10px 12px`; `right:calc(100% + 10px)`; `box-shadow:var(--dsw-elevation-panel)`; `transition:top .14s cubic-bezier(.2,.8,.2,1)` |
| `.JObwrW_panel` (context meter) | `width:264px`; `padding:12px`; `border-radius:12px`; `bottom:calc(100% + 8px)`; `box-shadow:var(--dsw-elevation-prominent)` |
| `.JObwrW_bar` | `height:4px`; `gap:1px`; `border-radius:999px`; `margin:10px 0 12px` |
| `.JObwrW_segment` | `min-width:2px`; `border-radius:1px` |
| `.JObwrW_swatch` | `8×8`; `border-radius:2px`; `margin-right:6px` |
| `.JObwrW_trigger` | `28×28`; `border-radius:999px` |

### 3.5 Conversation shell + composer

| selector | metric |
|---|---|
| `.wSkVaW_header` | `min-height:76px`; `padding:10px 28px 0 20px`; `border-bottom:.5px solid var(--dsw-alias-border-l3)` |
| `.wSkVaW_titleRow` | `min-height:30px`; `gap:0` |
| `.wSkVaW_titleCluster` | `gap:10px` |
| `.wSkVaW_crumbs` | `gap:4px` |
| `.wSkVaW_crumb` | `max-width:220px`; `padding:4px 8px`; `border-radius:12px` |
| `.wSkVaW_headerActions`, `.wSkVaW_headerUtilities` | `gap:8px`; utilities `margin-left:20px` |
| `.wSkVaW_headerCorner` | `margin-left:8px; margin-right:-16px` |
| `.wSkVaW_tabs` | `gap:36px`; `margin-top:10px`; `padding-left:8px` |
| `.wSkVaW_tab` | `padding:0 0 9px`; `:after { height:2px; bottom:-1px; border-radius:2px }` |
| `.wSkVaW_scrollBody` | `scrollbar-gutter:stable`; `margin-right:2px`; `overflow-y:auto`; `::-webkit-scrollbar-track{margin:2px}` |
| `.wSkVaW_widthHandle` | `width:min(40px, calc((100% - var(--dsh-chat-content-width)) / 2 - 24px - 24px))`; `[data-side=left]{right:calc(50% + var(--dsh-chat-content-width)/2 + 24px)}`; `[data-side=right]{left:…+24px}`; `:after{width:3px;border-radius:3px;opacity:0}` — glow gradient `transparent calc(y-52px) → var(--dsw-alias-scrollbar-hover-l1) calc(y±12px) → transparent calc(y+52px)`; `:after` inset `16px` from the outer edge |
| `.wSkVaW_composerStack` | `--dsh-composer-stack-gap:6px; gap:6px` |
| `.wSkVaW_composerSeat` | `--dsh-composer-text-max-height:336px`; `[data-phase=active]` → `position:sticky; bottom:0; z-index:7; background:linear-gradient(180deg, color-mix(in srgb, var(--dsw-alias-bg-base) 0%, transparent) 0px, var(--dsw-alias-bg-base) 36px)` |
| `.wSkVaW_composerHero` | `width:min(calc(var(--dsh-composer-card-max-width) + 2 * var(--dsh-composer-side-clearance)), 100%)`; `padding-bottom:32px`; `gap:8px` |
| `.wSkVaW_heroWorkspaceRow` | `margin-top:4px`; `padding:0 16px 0 20px`; `gap:2px` |
| `.uV2eYG_root` (composer root) | `padding:0 var(--dsh-composer-side-clearance) 8px` (= `0 16px 8px`); `:has([data-composer-stats])` → `padding-bottom:4px` |
| `.uV2eYG_card` (the composer pill) | `max-width:var(--dsh-composer-card-max-width)` = **content width + 32px**; `border-radius:22px`; `padding-top:8px`; `gap:12px`; `background:var(--dsw-specific-input-major)`; `box-shadow:var(--dsw-elevation-soft)`; `border:0` |
| `.uV2eYG_cardWorkspaceTrigger:after` | `inset:-1px`; `border-radius:22px`; dashed SVG mask (`rx=22 stroke-width=2 stroke-dasharray="4 4"`); `background:var(--dsw-alias-border-l4)`; hover → `--dsw-alias-state-business-primary`; `transition:background-color .1s` |
| `.uV2eYG_accessory` | `padding:10px 12px 0`; `gap:8px` |
| `.uV2eYG_scroll` | `max-height:var(--dsh-composer-text-max-height)` = `336px`; `margin-right:4px`; `::-webkit-scrollbar-track{margin-top:8px}` |
| `.uV2eYG_input` | `min-height:36px`; `padding:4px 8px 0 14px` (hero: `min-height:52px`) |
| `.uV2eYG_placeholder` | `inset:4px 8px auto 14px` |
| `.uV2eYG_row` (toolbar row) | `padding:2px 8px 6px`; `gap:12px`; `flex-wrap:wrap`; `container-type:inline-size` |
| `.uV2eYG_tools`, `.uV2eYG_modes`, `.uV2eYG_trailing` | `gap:12px`; trailing `margin-left:auto` |
| `.uV2eYG_add` (+ button) | `28×28`; `border-radius:999px`; `background:var(--dsw-specific-selector)` |
| `.uV2eYG_select` | `max-width:220px`; `height:28px`; `border-radius:8px`; `padding:0 20px 0 8px`; chevron bg `12×12` at `right 4px center` |
| `.uV2eYG_primary` (send) | `34×34`; `border-radius:999px`; `transform:translateY(-2px)`; `background:var(--dsw-alias-button-info-fill)`; `color:#fff`; `transition:background-color .1s` |
| `.uV2eYG_pending` | `8×8` dot; `border-radius:50%`; `background:var(--dsw-alias-state-business-primary)` |
| `._54WpYG_rail` / `.JVDQca_rail` (attachments) | rail `gap:10px`; thumbs `64×64`; `border-radius:16px`; `border:.5px solid var(--dsw-alias-border-l2-darkmode-thin)`; remove `18×18` at `top:4px;right:4px`; carousel arrow `24×24` `border-radius:999px` `box-shadow:var(--dsw-elevation-panel)` at `left/right:4px` |
| `.yAWgPa_chip` (reference chip in editor) | `max-width:240px`; `height:22px`; `border-radius:6px`; `padding:0 6px`; `gap:3px` |
| `.lXshSW_root` (todo dock) | `width:calc(100% - 2*clearance - 4*dock-inset)`; `max-width:calc(card-max-width - 4*dock-inset)`; `border:.5px solid var(--dsw-alias-border-l1)`; `border-radius:12px`; `margin:0 auto`; body `gap:8px; padding:6px 12px`; list `max-height:180px`; glyph `16×16` |
| `._7yHdaG_dock` (queue dock) | `width:calc(100% - 2*clearance - 2*dock-inset)`; `max-width:calc(card-max-width - 2*dock-inset)`; `margin:0 auto calc(0px - var(--dsh-composer-stack-gap) - 3px)`; `padding:0 var(--dsh-composer-dock-inset)` |
| `._7yHdaG_panel` | `border-radius:12px 12px 0 0`; `padding:2px 0`; `:after{border:.5px solid var(--dsw-alias-border-l1); border-bottom:none; border-radius:inherit; inset:0}` |
| `._7yHdaG_header` / `._7yHdaG_row` | `height:36px`; `border-radius:8px`; `padding:4px 12px` / `padding:4px 5px 4px 12px` |
| `._7yHdaG_list` | `max-height:180px` |
| `._7yHdaG_file` | `height:24px`; `min-width:74px`; `border-radius:6px`; `padding:0 6px`; `border:.5px solid var(--dsw-alias-border-l1)` |
| `._7yHdaG_fileIcon` | `16×16` |
| `._7yHdaG_thumb` | `24×24`; `border-radius:4px` |
| `._7yHdaG_editor` | `height:28px`; `border-radius:6px`; `padding:0 8px` |
| `._7yHdaG_action` | `28×28`; `border-radius:999px` |
| `.pXSMma_root` (hero) | `padding:0 24px` |
| `.pXSMma_stack` | `max-width:var(--dsh-composer-card-max-width)`; `gap:12px` |
| `.pXSMma_headline` | `gap:12px 10px` |
| `.pXSMma_workspace` | `max-width:min(100%,360px)`; `min-height:28px`; `border-radius:16px`; `padding:0 8px` |
| `.pXSMma_modalInput` | `height:44px`; `border-radius:22px`; `padding:7px 14px` |
| `.Sh0Q9G_trigger` (permission) | `max-width:220px`; `height:28px`; `border-radius:24px`; `padding:0 4px 0 8px`; `svg{14×14}` |
| `._3e4SsG_menu` (composer @-menu) | `max-height:320px`; `padding:4px`; `border-radius:20px`; `box-shadow:var(--dsw-elevation-prominent)`; `background:var(--dsw-specific-menu)`; `position:absolute; bottom:calc(100% + 4px); left:0; right:0` |
| `._3e4SsG_item` | `min-height:40px`; `padding:8px 10px`; `border-radius:10px`; `gap:8px` |
| `._3e4SsG_sectionTitle` | `min-height:26px`; `padding:6px 10px 2px` |
| `._3e4SsG_itemIcon` | `16×16` |
| `._3e4SsG_drill` | `20×20`; `border-radius:4px` |
| `._3e4SsG_skeletonRow` | `min-height:40px; padding:8px 10px`; bar `height:20px; border-radius:4px; background:var(--dsw-alias-bg-skeleton)` |
| `._3e4SsG_crumbs` | `padding:4px 4px 6px; gap:2px; border-bottom:.5px solid var(--dsw-alias-border-l1)` |
| `._3e4SsG_crumb` | `max-width:40%; padding:2px 6px; border-radius:6px` |

### 3.6 Corner radii (census, 33 distinct)

`6px`×37 · `8px`×35 · `12px`×29 · `50%`×27 · `999px`×19 · `10px`×17 · `4px`×16 · `16px`×15 · `20px`×15 ·
`18px`×12 · `1px`×11 · `14px`×10 · `28px`×10 · `22px`×7 · `3px`×7 · `24px`×6 · `2px`×6 · `7px`×4 ·
`5px`×3 · `12px 12px 0 0`×2 · `1px 1px 0 0`×2 · `0`×2 · `100px`×1 · `32px`×1 · `2px 2px 0 0`×1 ·
`0 0 2px`×1 · plus the six `var(--dsl-*)` radii.

**Named radii** (canonical): user bubble & composer card `22px` · Button & FontSizeRow stepper `18px` ·
menu / DockKit float `20px` · modal dialog `24px` · toast `14px` · tooltip & input `8px` · card/banner `12px` ·
tool cards `12px` · tag `999px` · pill `12px` · icon button `28px` or `50%` · switch `10px`.

### 3.7 Breakpoints, media & container queries

| query | count | where (examples) |
|---|---|---|
| `@media (prefers-reduced-motion:reduce)` | 26 | see §5 |
| `@media (width<=720px)` | 10 | `LVzXQa_card/_body/_footer`, `Mbwy4a_card/_header/_options/_title/_footer/_footerActions` |
| `@media (prefers-reduced-motion:no-preference)` | 9 | TrajectoryTable/Timeline animations, `qSYn7G_chevron` |
| `@media (pointer:coarse)` | 6 | always-reveal remove buttons: `JVDQca_remove:focus-visible`, `_54WpYG_remove:focus-visible`, `gSkjMW_remove`, `nyYjTG_split`, `nyYjTG_open` |
| `@media (width<=560px)` | 4 | `GL8Viq_editor`, `jLrgrW_content`, `t1T8VW_primary`, `DBuyfa_phaseList` |
| `@media (width<=480px)` | 3 | `Q51KRG_trigger` (+`_label`, `_root+_root`) |
| `@media (hover:hover)` | 2 | `xzv4MW_actions` reveal-on-hover (80ms opacity) |
| `@media (width<=760px)` | 1 | `Y0dWHa_details` |
| `@media (width<=680px)` | 1 | `qSYn7G_cards` |
| `@media (hover:hover) and (prefers-reduced-motion:no-preference)` | 1 | `pXSMma_fish` |
| **JS breakpoint** | — | `SIDEBAR_AUTO_COLLAPSE = 1024` |
| `@container (width<=271px / 360 / 375 / 460 / 479 / 583 / 620 / 687 / 900)` | 1–2 each | transcript is `container-type:inline-size` (`.EvIC1a_scroll`), composer row is `container-type:inline-size` (`.uV2eYG_row`) |
| `@container Y0dWHa_trajectory-table (width<=620px)` | 8 | trajectory table |

### 3.8 Scrollbar

`--dsh-scrollbar-width:8px`; `::-webkit-scrollbar{width:8px;height:8px}`; thumb `border-radius:4px`;
`scrollbar-width:thin` + `scrollbar-color: var(--dsh-scrollbar-thumb) transparent` in the non-webkit fallback.
Card headers/output panes widen the thumb by 2px transparent border and use `border-radius:6px`
(`._header_1gdtu_32`, `._output_1gdtu_156`, `.*_ioSection_*`).

---

## 4. The primitive components (`ui-primitives`, shipped inside the dist bundle)

`dsh-client-ui-primitives` is **not installed as a package** in this tree; it is compiled into
`dsh-web-frontend/dist`. Its 28 modules are recoverable from `index.css` by hash. Component identity is read off
the CSS-module key names exported in `index-BKQ_L1z6.js` (e.g. `ro={button:…, md:…, sm:…, primary:…, ghost:…,
outline:…, toolbar:…, icon:…}`).

### 4.1 Button — module `cfgyt`

```css
._button_cfgyt_4 { display:inline-flex; align-items:center; justify-content:center; gap:4px;
  border:none; border-radius:18px; cursor:pointer; font-size:14px; line-height:22px;
  color:var(--dsw-alias-label-primary); background:transparent; padding:0 14px }
._button_cfgyt_4:disabled { cursor:not-allowed; opacity:.4 }
```

| variant | rule |
|---|---|
| **size md** (default) | `._md_cfgyt_24 { height:36px }` |
| **size sm** | `._sm_cfgyt_30 { height:28px; font-size:12px; line-height:18px; padding:0 10px; border-radius:14px }` |
| **primary** | `background:var(--dsw-alias-button-primary-fill)` (near-black `#0f1115` light / `#f9fafb` dark); `color:var(--dsw-alias-label-primary-foreground)`; `:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}` |
| **ghost** | `:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}`; `:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active)}` |
| **outline** | `border:.5px solid var(--dsw-alias-border-l3)`; `background:transparent`; hover → `--dsw-alias-interactive-bg-hover` |
| **toolbar** | `background:var(--dsw-alias-button-tool-bar-fill)` (`#54555780`, identical both themes); hover → `#54555799` |
| **icon slot** | `._icon_cfgyt_73 { display:inline-flex; width:16px; height:16px; align-items:center; justify-content:center }` |

### 4.2 Icon button — no single primitive; one **converged pattern** repeated 8×

`28×28` · `border:none` · `border-radius:28px` or `50%` · `padding:6px` · `svg{15×15}` · hover
`--dsw-alias-interactive-bg-hover`. Instances: `.P3OORG_iconButton`, `._1kL45W_button` (ExpandButton),
`.hHd-Xa_iconButton` (radius `50%`, padding `0`), `.xzv4MW_action` (scales with `--dsh-content-font-delta`),
`.Q51KRG_trigger` (`padding:6px 8px`), `._7yHdaG_action` (`padding:0`, radius `999px`),
`._iconButton_17p4l_408`. Collapsed sidebar variant: `36×36`.

### 4.3 Tag / chip — module `brmue` (single class + `data-tone`)

```css
._tag_brmue_4 { display:inline-flex; align-items:center; border-radius:999px; corner-shape:round;
  padding:1px 8px; font-size:11px; line-height:17px; font-weight:500; white-space:nowrap }
```

| `data-tone` | colours |
|---|---|
| `outline` | `border:.5px solid var(--dsw-alias-border-l4)`; `color:var(--dsw-alias-label-tertiary)` |
| `solid` | `background:var(--dsw-alias-label-primary)`; `color:var(--dsw-alias-bg-layer-3)` |
| `neutral` | `background:var(--dsw-alias-bg-module-platform)`; `color:var(--dsw-alias-label-secondary)` |
| `quiet` | `color:var(--dsw-alias-label-tertiary)` |
| `success` | `background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent)`; `color:var(--dsw-alias-state-success-primary)` |
| `info` | `color-mix(... var(--dsw-alias-state-business-primary) 10% ...)` |
| `warning` | `color-mix(... var(--dsw-alias-state-warn-primary) **12%** ...)` |
| `danger` | `color-mix(... var(--dsw-alias-state-error-primary) 10% ...)` |

### 4.4 Pill (segmented / mode pill) — module `e3ygd`

```css
._pill_e3ygd_1 { display:inline-flex; align-items:center; gap:4px; height:24px; padding:0 8px;
  border:none; border-radius:12px; font-size:12px; line-height:18px;
  color:var(--dsw-alias-label-secondary); background:var(--dsw-alias-bg-layer-2) }
._interactive_e3ygd_15 { cursor:pointer }
._interactive_e3ygd_15:hover { background:var(--dsw-alias-interactive-bg-hover) }
._active_e3ygd_23 { color:var(--dsw-alias-label-primary);
  background:var(--dsw-alias-button-ghost-active-fill);
  box-shadow:inset 0 0 0 1px var(--dsw-alias-button-ghost-active-border) }
```

### 4.5 Tooltip — module `1nw3t` (class key: `bubble`)

```css
._bubble_1nw3t_1 { position:fixed; z-index:100; width:max-content; max-width:50vw; padding:3px 7px;
  border-radius:8px; background:var(--dsw-alias-tooltip-bg); color:var(--dsw-static-neutral-bluish-00);
  font-size:13px; line-height:20px; white-space:pre-line; overflow-wrap:break-word; pointer-events:none;
  animation:_tooltip-in_1nw3t_1 .15s var(--ds-ease-in-out) }
```
Placement via `[data-side]`: `right{transform:translateY(-50%)}`, `bottom{translate(-50%)}`,
`top{translate(-50%,-100%)}`. `@keyframes _tooltip-in_1nw3t_1 {0%{opacity:0}}`.
`@media (prefers-reduced-motion:reduce){ animation:none }`.

### 4.6 Menu / popover — module `1nxmc` (keys: `root,list,portal,viewport,item,…`)

```css
._list_1nxmc_8, ._submenu_1nxmc_9 { box-sizing:border-box; padding:4px; display:flex; flex-direction:column;
  gap:0; border:0; border-radius:20px; background:var(--dsw-specific-menu);
  --dsw-elevation-stroke-color:var(--dsw-alias-border-l1); box-shadow:var(--dsw-elevation-prominent);
  --dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);
  --dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2) }
._list_1nxmc_8 { position:absolute; top:calc(100% + 4px); left:0; z-index:100; min-width:218px; max-width:360px }
._portal_1nxmc_44 { position:fixed; top:auto; left:auto; z-index:1100 }
._sideTop_1nxmc_52 { top:auto; bottom:calc(100% + 4px) }
._alignEnd_1nxmc_57 { left:auto; right:0 }
._scrollable_1nxmc_22 { max-height:calc(100vh - 24px) }
._item_1nxmc_92 { display:flex; align-items:center; gap:8px; width:100%; min-height:40px;
  padding:8px 10px; border:none; border-radius:10px; background:transparent; cursor:pointer;
  font-size:14px; line-height:22px; color:var(--dsw-alias-label-primary); text-align:left }
._item_1nxmc_92:hover:not(:disabled) { background:var(--dsw-alias-interactive-bg-hover) }
._item_1nxmc_92:disabled { opacity:.4; cursor:not-allowed }
._itemIcon_1nxmc_144 { width:16px; height:16px; color:var(--dsw-alias-label-tertiary) }
._label_1nxmc_124 { padding:8px 10px; font-size:12px; line-height:16px; color:var(--dsw-alias-label-tertiary) }
._separator_1nxmc_82 { height:.5px; margin:4px 2px; background:var(--dsw-alias-border-l1) }
._check_1nxmc_182 { color:var(--dsw-alias-label-primary) }
._selectedFill_1nxmc_194 { background:var(--dsw-alias-interactive-bg-hover) }
._danger_1nxmc_199, ._danger_1nxmc_199 ._itemIcon_1nxmc_144 { color:var(--dsw-alias-state-error-primary) }
._danger_1nxmc_199:hover:not(:disabled) { background:var(--dsw-alias-interactive-bg-hover-danger) }
._submenu_1nxmc_9 { position:absolute; bottom:-4px; left:calc(100% + 10px); z-index:101; min-width:163px }
._submenu_1nxmc_9:before { content:""; position:absolute; top:0; bottom:0; left:-10px; width:10px }
._footer_1nxmc_64 { margin-top:4px; padding-top:4px; border-top:.5px solid var(--dsw-alias-border-l2) }
```

| variant | rule |
|---|---|
| **dense** | `._denseList_1nxmc_119 ._item_1nxmc_92 { min-height:34px; padding-block:5px }`; label `padding-block:4px` |
| **compact** | `._list._compactList_1nxmc_128 { min-width:164px; padding:2px; border-radius:7px }`; `._compactList ._item { min-height:26px; gap:6px; padding:3px 7px; border-radius:5px; font-size:12px; line-height:18px }`; `._itemIcon{14×14}`; `._separator{margin:2px}`; `._label{padding:4px 7px; font-size:11px; line-height:16px}` |

The composer `@`/`/` menu (`ui-input-trigger/MenuView`) uses the same visual grammar with its own class module:
radius `20px`, `padding:4px`, `max-height:320px`, item `min-height:40px / padding:8px 10px / radius:10px`,
section title `min-height:26px / 12px/18px / w500`, drill button `20×20 / radius:4px`,
skeleton bar `height:20px / radius:4px / background:var(--dsw-alias-bg-skeleton)` with the
`_3e4SsG_dsh-menu-skeleton` opacity pulse.

### 4.7 Modal / dialog — module `w1urq`

```css
._root_w1urq_2   { position:fixed; inset:0; z-index:1000; display:flex; align-items:center;
                   justify-content:center; padding:24px }
._mask_w1urq_14  { position:absolute; inset:0; background:var(--dsw-alias-bg-mask-1);
                   backdrop-filter:var(--dsw-mask-blur) }         /* blur(2px) */
._dialog_w1urq_22{ position:relative; z-index:1; display:flex; flex-direction:column; gap:20px;
                   width:min(380px,100%); padding:0 0 24px; overflow:hidden; border:0;
                   border-radius:24px; background:var(--dsw-alias-bg-layer-2);
                   box-shadow:var(--dsw-elevation-prominent) }
._header_w1urq_45{ display:flex; align-items:center; justify-content:space-between; gap:8px;
                   padding:22px 14px 12px 24px }
._title_w1urq_53 { margin:0; font-size:16px; line-height:24px; font-weight:500;
                   color:var(--dsw-alias-label-primary) }
._close_w1urq_61 { width:28px; height:28px; border:none; border-radius:8px; background:transparent;
                   cursor:pointer; color:var(--dsw-alias-label-secondary) }
._description_w1urq_80 { margin:0; padding:0 24px; font-size:14px; line-height:22px; font-weight:400;
                   color:var(--dsw-alias-label-primary) }
._body_w1urq_89  { margin-top:20px; padding:0 24px }
._footer_w1urq_97{ display:flex; align-items:center; justify-content:flex-end; gap:8px; padding:0 24px }
```
Pattern: **24px radius, 24px side padding, 20px section gap, `min(380px,100%)` width, 24px viewport padding.**

### 4.8 Toast — module `e5v0f`

```css
._toast_e5v0f_6 { position:fixed; top:40px; left:50%; z-index:1100; pointer-events:none; display:flex;
  align-items:center; gap:10px; width:max-content; max-width:min(640px, calc(100vw - 48px));
  padding:12px 16px; border-radius:14px; background:var(--dsw-alias-button-contrast-fill);
  color:var(--dsw-alias-label-primary-inverted); font-size:14px; line-height:22px;
  box-shadow:var(--dsw-shadow-lv3); transform:translate(-50%);
  animation:_dsh-toast-in_e5v0f_1 .16s ease-out,
            _dsh-toast-fade_e5v0f_1 1s ease var(--dsh-toast-hold, 3s) forwards }
._icon_e5v0f_37 { display:grid; place-items:center; flex:none; color:var(--dsw-alias-state-warn-label) }
._text_e5v0f_44 { min-width:0 }
```
`@keyframes _dsh-toast-in_e5v0f_1 {0%{opacity:0;transform:translate(-50%,-6px)} to{opacity:1;transform:translate(-50%)}}`
`@keyframes _dsh-toast-fade_e5v0f_1 { to{opacity:0} }`
Reduced motion: keeps the fade, drops the slide-in (`animation:_dsh-toast-fade_e5v0f_1 1s ease var(--dsh-toast-hold,3s) forwards`).

### 4.9 Input (search / field) — module `1g6ru`

```css
._wrap_1g6ru_1  { display:inline-flex; align-items:center; gap:6px; height:32px; padding:0 8px;
                  border:.5px solid var(--dsw-alias-border-l4); border-radius:8px;
                  background:var(--dsw-alias-bg-layer-1) }
._wrap_1g6ru_1:focus-within { border-color:var(--dsw-alias-brand-primary) }
._icon_1g6ru_16 { width:16px; height:16px; color:var(--dsw-alias-label-tertiary) }
._input_1g6ru_25 { border:none; outline:none; background:transparent; font-size:14px; line-height:22px;
                  color:var(--dsw-alias-label-primary) }
._input_1g6ru_25::placeholder { color:var(--dsw-alias-label-dimmed) }
```
Composer-adjacent field variants: `.Sh0Q9G_editor`/`._7yHdaG_editor` (`height:28px; radius:6px; padding:0 8px;
border:.5px solid var(--dsw-alias-border-l4)`; focus → `--dsw-alias-state-business-primary`),
`.pXSMma_modalInput` (`height:44px; radius:22px; padding:7px 14px`).

### 4.10 Switch — module `1vyxu`

```css
._switch_1vyxu_10 { box-sizing:border-box; position:relative; flex:0 0 auto; width:36px; height:20px;
  padding:2px; border:0; border-radius:10px; corner-shape:round;
  background:var(--dsw-alias-border-l3); cursor:pointer }
._switch_1vyxu_10[aria-checked=true] { background:var(--dsw-alias-brand-primary) }
._switch_1vyxu_10:disabled { cursor:default; opacity:.5 }
._switch_1vyxu_10:focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:2px }
._thumb_1vyxu_38 { display:block; width:16px; height:16px; border-radius:50%; corner-shape:round;
  background:var(--dsw-alias-label-primary-foreground); transition:transform .12s ease }
._switch_1vyxu_10[aria-checked=true] ._thumb_1vyxu_38 { transform:translate(16px) }
```

### 4.11 Status dot / status matrix — module `1tljr`

```css
._dot_1tljr_3, ._matrix_1tljr_4 { --dsh-state-ongoing: var(--dsw-static-deepseek-450) }
._dot_1tljr_3 { position:relative; display:inline-block; flex:none }
._dot_1tljr_3:before { content:""; position:absolute; inset:0; border-radius:50%; corner-shape:round;
  background:currentColor; opacity:.1 }
._dot_1tljr_3:after  { content:""; position:absolute; inset:20%; border-radius:50%; corner-shape:round;
  background:currentColor }
._dot_1tljr_3[data-state=done]    { color:var(--dsw-alias-state-success-primary) }
._dot_1tljr_3[data-state=warning] { color:var(--dsw-alias-state-warn-primary) }
._dot_1tljr_3[data-state=error]   { color:var(--dsw-alias-state-error-primary) }
._dot_1tljr_3[data-state=idle]    { color:var(--dsw-alias-label-tertiary) }
._cell_1tljr_62 { fill:currentColor; opacity:.15; animation:_dsh-state-dot-chase_1tljr_1 1s infinite }
```
The dot is a **10 %-opacity halo (`:before{inset:0}`) plus a solid disc at `:after{inset:20%}`**
(60 % of the box diameter), both `currentColor`. Ongoing (no `data-state`) = `deepseek-450`.
`@keyframes _dsh-state-dot-chase_1tljr_1` cycles opacity `1 → .6 → .35 → .15` in 4 steps.

### 4.12 File-type icon — module `1wejo`

`._icon_1wejo_1 { color:var(--dsh-file-type-icon-color, var(--dsh-file-type-default-color)) }`
+ local `--dsh-file-type-violet: rgb(139,118,246)` and one `--dsh-file-type-default-color` per type:

| type | colour | type | colour |
|---|---|---|---|
| `code`, `html`, `markdown` | `--dsw-static-deepseek-500` `#4176e6` | `word` | `--dsw-static-deepseek-450` `#5686fe` |
| `excel` | `--dsw-static-green-500` `#22c55e` | `pdf` | `--dsw-static-red-600` `#ec1313` |
| `folder` | `--dsw-static-amber-400` `#f7ad31` | `ppt` | `--dsw-static-amber-500` `#f59e0b` |
| `image`, `video` | `rgb(139,118,246)` | `other` | `--dsw-static-neutral-bluish-300` `#cfd3d6` |

### 4.13 Hover card / copy feedback — module `1b2ny`

```css
._card_1b2ny_13 { --dsw-hovercard-bg:#2C2C2E; position:fixed; z-index:100; box-sizing:border-box;
  width:244px; padding:12px 16px; border-radius:12px; background:var(--dsw-hovercard-bg);
  box-shadow:var(--dsw-shadow-lv3) }
._copyable_1b2ny_25:focus-visible { outline:2px solid var(--dsw-alias-state-business-primary); outline-offset:2px }
._copied_1b2ny_40 { color:#fff; font-size:14px; line-height:20px; text-align:center }
._status_1b2ny_47 { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0) }
```
Note the hover card is a **hard-coded `#2C2C2E`** (dark in both themes) — an intentional "always dark" surface.

### 4.14 Collapsible section / confirm modal (tool + approval)

`1fdcq` = `{root, toggle, body}` — `._toggle_1fdcq_*:hover` reveals; used by `ui-approval/ApprovalPanel`.
`1nu42` = approval confirm chrome: `._confirmation_*`, `._warning_*` (`._warning p`), `._warningIcon_*`,
`._acknowledgement_*` (`input`, `input:focus-visible`, `input:disabled`), `._modalAction_*` (`min-width:72px`),
`._confirmAction_*`.

### 4.15 Skeleton

There is **no standalone Skeleton primitive**. The only skeleton idiom is
`background:var(--dsw-alias-bg-skeleton)` (`#0000000a` light / `#ffffff14` dark) on a `border-radius:4px` bar
plus an opacity pulse — see `._3e4SsG_skeletonBar` / `@keyframes _3e4SsG_dsh-menu-skeleton`
(`0%{opacity:1} 40%{opacity:.6} 80%,to{opacity:1}`, `2s cubic-bezier(.36,0,.64,1) infinite`).
`./invariant.js` and the boot screen (`1fywu`) use a spinner instead.

### 4.16 Avatars

**There is no avatar component and no avatar size token anywhere in the shipped CSS.** The transcript has no
per-message avatar; user turns are right-aligned bubbles (`.Sixlwa_userRow`) and assistant turns are plain
markdown (`.hWmORq_root`). The nearest things are the `28×28` file icon (`.Sixlwa_fileIcon`), the `28×28`
icon-button family, and the brand mark (`.hHd-Xa_brandMark`, 24px row).

### 4.17 Other dist modules for completeness

`17p4l` DockKit · `kcgor` Markdown · `rsn9u` CodeBlock · `1gdtu` TerminalCard · `onbk6` ReadCard ·
`1h7p4` SearchCard · `12o37` DiffCard · `19q7d` WebCard · `4qrvp` JSON tree · `luwio` SkillRow ·
`z12h9` ReferenceChip · `1ycze` ContextMeter · `1fywu` boot screen · `1cfrq` onboarding stage ·
`1nw3t` Tooltip · `brmue` Tag.

---

## 5. Motion

### 5.1 Global constants (`base.css` `:root`)

| token | value |
|---|---|
| `--ds-ease-in-out` | `cubic-bezier(.4, 0, .2, 1)` |
| `--ds-transition-duration` | `.2s` |
| `--ds-transition-duration-fast` | `.1s` |
| `--ds-transition-duration-slow` | `.3s` |

### 5.2 Duration ladder actually used (census of 43 distinct `transition` values)

| duration | typical use |
|---|---|
| **`80ms`** | message action row reveal: `@media (hover:hover){ transition:opacity 80ms }` (`.xzv4MW_actions`) |
| **`.1s`** | hover tints (`background-color .1s`), composer send button, `transform .1s` on the turn-process chevron, `opacity .1s ease` |
| **`.12s`** | the workhorse: `.12s` bare ×8 (transform), `opacity .12s`, `background-color .12s,border-color .12s`, `border-color .12s,box-shadow .12s`, `transform .12s ease` (switch thumb), retry chevron `transform .12s` |
| **`.14s`** | `width .14s,background-color .14s` (turn mark), `transform .14s var(--ds-ease-in-out)` |
| **`.15s`** | sidebar fade `opacity .15s var(--ds-ease-in-out)`, `transform .15s`, tooltip-in `.15s` |
| **`.16s`** | `transform .16s`, toast-in `.16s ease-out`, `border-color .16s, background .16s` |
| **`.18s`** | *all* the width/expansion transitions: `max-width .18s / margin-right .18s / opacity .12s / transform .18s / visibility 0s linear`, `max-width .18s, padding-left .18s`, `width .18s, padding .18s, border-color .18s, background-color .18s`, `left .18s ease-out` |
| **`.2s`** | `opacity .2s ease-in-out` (attachment remove), `--ds-transition-duration` |
| **`.22s`** | the turn navigator: `transition:height .22s cubic-bezier(.2,.8,.2,1)`, `top .22s cubic-bezier(.2,.8,.2,1)` |
| **`.3s`** | `--ds-transition-duration-slow`: shell column resize (`grid-template-columns`), sidebar handle `left`, right panel `transform` |

**Easings**: bare (default `ease`), `var(--ds-ease-in-out)` = `cubic-bezier(.4,0,.2,1)` (10 uses), `ease-out`
(cards, dock hints), and the "UI spring" `cubic-bezier(.2,.8,.2,1)` reserved for the turn navigator's
height/top. Keyframe-specific: `.16,1,.3,1` (hero seat icon), `.36,0,.64,1` (menu skeleton + fish).

### 5.3 Which interactions animate

| interaction | spec |
|---|---|
| **hover (surfaces)** | instantaneous background swap; where it eases: `background-color .12s var(--ds-ease-in-out)`, `background .12s var(--ds-ease-in-out), box-shadow .12s` (markdown links) |
| **hover (reveal)** | `@media (hover:hover)` — message actions start `opacity:0` and fade in over `80ms`; attachment remove buttons rely on `:focus-visible` and `@media (pointer:coarse)` to stay visible |
| **expand / collapse** | text/tool disclosures are **not animated** — the tool-row body is conditionally rendered (`max-height:260px` is a clamp, not a transition). Animated expansion exists only in the sidebar rail (`max-width .18s …`), the dockkit tabs (`width .14s`), and the `details` chevrons (`transform .12s`) |
| **dialog** | **no enter animation** — dialog/mask appear instantly; only `backdrop-filter: blur(2px)`. Dock drag hints do animate: `_dockHintIn .14s ease-out` (`scale(.98)→none`), `_dockScrimIn .14s ease-out` |
| **toast** | `_dsh-toast-in .16s ease-out` (slide 6px up + fade) then `_dsh-toast-fade 1s ease var(--dsh-toast-hold,3s) forwards` |
| **tooltip** | `_tooltip-in .15s var(--ds-ease-in-out)` (opacity only) |
| **streaming text** | three shimmer loops, all `background-clip:text` + `-webkit-text-fill-color:transparent`: turn status `1.8s linear infinite` (`background-size:250% 100%`, gradient `deepseek-500 0-40% → deepseek-200 50% → deepseek-500 60-100%`); retry text `1.6s ease-in-out infinite` (`background-size:200%`); turn-status clock is plain. Busy turn marks: `_dsh-turn-mark-busy 1s ease-in-out infinite` |
| **running tool rows** | a 300px sweeping highlight: `[data-state=running] .row:after { width:300px; animation:2.6s ease-out infinite <name>-sweep }` — present in ToolRow (`o3BgMG`), ReasoningRow (`lcKema`), GenericCommandCard (`_5OnbHa`), bash-sample (`CY-8Ka`), SkillRow (`iWrAna`) |
| **spinners** | boot `_spin_1fywu_47 .8s linear infinite`; file card `gSkjMW_file-card-spin .8s linear infinite`; todo progress `lXshSW_todo-progress-spin 1s linear infinite`; trajectory `Y0dWHa_history-loading-spin .7s linear infinite`; turn preview `tKrPPq_turn .8s linear infinite`; pending dot `uV2eYG_input-pending 1s ease-in-out infinite alternate` (opacity .35↔1) |
| **file card progress** | `gSkjMW_file-card-progress 1.2s ease-in-out infinite alternate` |
| **status matrix** | `_dsh-state-dot-chase_1tljr_1 1s infinite` (4-step opacity) |
| **context meter dots** | `_reveal-second-dot_1ycze_1 1.5s step-end infinite`, `_reveal-third-dot_1ycze_1 1.5s step-end infinite` |
| **sidebar rail** | `_rail-in .15s var(--ds-ease-in-out) backwards` (`translate(49px)→0` + fade), `_rail-fade-in .15s`, `_wide-in .2s` (opacity), `_fading>* { opacity:0; transition:opacity .15s }` |
| **onboarding seat** | `.15s cubic-bezier(.16,1,.3,1) both` (icon), `.4s ease-out forwards` (chars) |
| **hero easter egg** | `pXSMma_hero-fish-swim 1.6s ease-in-out infinite`, only under `@media (hover:hover) and (prefers-reduced-motion:no-preference)` |
| **trajectory** | viewport-driven animations gated behind `@media (prefers-reduced-motion:no-preference)` |

**35 distinct `@keyframes`** total: `_dsh-state-dot-chase_1tljr_1`, `_reveal-second-dot_1ycze_1`,
`_reveal-third-dot_1ycze_1`, `_tooltip-in_1nw3t_1`, `_dsh-toast-in_e5v0f_1`, `_dsh-toast-fade_e5v0f_1`,
`_dockHintIn_17p4l_1`, `_dockScrimIn_17p4l_1`, `_spin_1fywu_47`, `_3e4SsG_dsh-menu-skeleton`,
`_5OnbHa_dsh-command-row-sweep`, `o3BgMG_dsh-tool-row-sweep`, `lcKema_dsh-reasoning-row-sweep`,
`CY-8Ka_dsh-bash-row-sweep`, `iWrAna_dsh-skill-row-sweep`, `EvIC1a_dsh-turn-status-shimmer`,
`Sixlwa_retry-shimmer`, `eGxaPq_dsh-turn-mark-enter`, `eGxaPq_dsh-turn-mark-busy`,
`eGxaPq_dsh-turn-preview-enter`, `uV2eYG_input-pending`, `lXshSW_todo-progress-spin`,
`gSkjMW_file-card-spin`, `gSkjMW_file-card-progress`, `tKrPPq_turn`, `hHd-Xa_wide-in`, `hHd-Xa_rail-in`,
`hHd-Xa_rail-fade-in`, `bhn1Oq_wide-in`, `YDXeBa_row-in`, `BInVoG_fade-in`, `cubgiG_seat-char-in`,
`cubgiG_seat-icon-in`, `pXSMma_hero-fish-swim`, `Y0dWHa_history-loading-spin`, plus
`EvIC1a_dsh-turn-status-shimmer`'s reduced-motion override.

### 5.4 Reduced motion — the exact rule set (26 occurrences)

Three patterns, applied consistently:

1. **Kill the transition/animation entirely** (most common):
   ```css
   @media (prefers-reduced-motion:reduce){ .selector { transition:none } }
   ```
   Applies to: `.pI_x6G_frame` (grid columns), `.pI_x6G_handle` (left), `.hHd-Xa_*`
   (wide-in / fading / rail-in — `transition:none; animation:none`), `.P3OORG_panel,
   .P3OORG_panel[data-sidebar-right-open]`, `.eGxaPq_*` (turn navigator `transition:none; animation:none`),
   and ~15 more.
2. **Keep the end state, drop the animation** (tooltip, toast):
   ```css
   @media (prefers-reduced-motion:reduce){ ._bubble_1nw3t_1 { animation:none } }
   @media (prefers-reduced-motion:reduce){ ._toast_e5v0f_6 {
     animation:_dsh-toast-fade_e5v0f_1 1s ease var(--dsh-toast-hold, 3s) forwards } }
   ```
3. **Replace the animated gradient with a static one** (streaming text):
   ```css
   @media (prefers-reduced-motion:reduce){ .EvIC1a_turnStatus {
     background-position:0 0; background-size:100% 100%; animation:none } }
   @media (prefers-reduced-motion:reduce){ .Sixlwa_retryRow[data-active] .Sixlwa_retryText {
     color:inherit; background:0 0; animation:none } }
   ```
4. **Opt-in animations** use the inverse query so they simply never run:
   ```css
   @media (prefers-reduced-motion:no-preference){ … }   /* 9 occurrences: trajectory, plugin chevron */
   ```

`forced-colors: active` is detected in JS (`matchMedia("(forced-colors: active)")`) but has **no stylesheet
rules**. `(hover: hover)` and `(pointer: coarse)` gate hover-reveal affordances.

---

## 6. Look-alike checklist (priority order)

A frontend that matches items **1–12** will read as "the same product" at a glance; **13–28** make it
indistinguishable in a side-by-side; **29–40** are the details that only show up in motion/edge states.

1. **Two-layer token system with a `body[data-ds-dark-theme]` boolean.** Light is the absence of the attribute.
   Default preference is `system`, resolved by an inline boot script *before* the app mounts
   (`document.body.toggleAttribute('data-ds-dark-theme', dark)`, `documentElement.style.colorScheme`).
   Set every token on `<body>`, never on `:root` — except `--dsw-font-family`, `--ds-font-family-code`,
   `--ds-ease-in-out`, `--ds-transition-duration{,-fast,-slow}`, `--dsw-corner-shape`, `--shiki-*` foreground/background.
2. **`--dsw-static-*` → `--dsw-alias-*` → component.** Ship the *identical* 73-colour static palette in both
   themes (differing only in `neutral-bluish-60`: `#f5f6f7` light / `#f9fafb` dark) and 90 alias tokens
   (13 identical, 77 themed).
3. **`--dsw-alias-bg-base` = `#fff` light / `#151517` dark.** The whole shell is white-on-white with 0.5px
   hairlines; dark is a warm-neutral `#151517`→`#353638` ramp, **never pure black**.
4. **`--dsw-alias-brand-primary` is near-black/white, not blue.** The blue accent is
   `--dsw-alias-state-business-primary` `#4176e6` light / `#679efe` dark. Using blue for the primary button
   would be immediately wrong.
5. **Borders are 0.5px** (`border:.5px solid …` / `border-bottom:.5px solid …`), never 1px. Ramp:
   `l1 #0000000a · l2 #0000001a · l3 #0000001f · l4 #00000029` (dark: `#ffffff0f · #ffffff1f · #ffffff29 · #fff3`).
6. **`--dsw-alias-label-*` text ramp** `primary → secondary → tertiary → caption → dimmed`
   (`#0f1115 / #61666b / #81858c / #adb2b8 / #e1e5ee`; dark `#f9fafb / #cfd3d6 / #adb2b8 / #81858c / #43454a`).
   Caption is *lighter* than tertiary in light mode and *darker* in dark mode — do not collapse the ramp.
7. **Font family** `-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB",
   "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial, sans-serif`; code
   `"SF Mono", "JetBrains Mono", "Fira Code", Consolas, "Liberation Mono", Menlo, Courier, "PingFang SC",
   "Microsoft YaHei"`; body `-webkit-font-smoothing:antialiased`, `-moz-osx-font-smoothing:grayscale`.
8. **Content font size is a user setting**, `12–17px`, default `14px`, published on `<body>` as
   `--dsh-content-font-size`, and **every** transcript line-height is
   `calc(Npx + var(--dsh-content-font-delta))`. Derive `-secondary` = `min(size-1, max(13, size-2))`.
9. **Transcript content width** = `clamp(680px, columnWidth * 0.64, 920px)` — measured from the live
   conversation column, not the viewport — centred with `max-width` + `margin:0 auto`, and the scroller padded
   `16px 32px`. Drag-to-widen floor `640px`, side budget `176px` (88px each), persisted at
   `dsh.conversation.contentWidth`.
10. **The three-column shell**: sidebar `280px` default, clamp `264–420px`, rail `56px`, auto-collapse
    below `1024px`; right panel `300px … 70% of frame`, first open at `45%`, and the centre keeps `400px`
    before the right panel is allowed to appear.
11. **User messages are right-aligned bubbles**: `border-radius:22px`, `padding:10px 16px`,
    `background:var(--dsw-specific-bubble)` (`#edf3fe` / `#2c2c2e`), `max-width:min(contentWidth*.702, 82%)`,
    `gap:6px` rows / `gap:8px` stack. **Assistant messages have no bubble** — plain markdown at
    `14/24` with `gap:16px` between blocks and `margin-top:16px` between transcript rows
    (`8px` inside a turn-process answer).
12. **The composer is a 22px-radius pill** with `box-shadow:var(--dsw-elevation-soft)`,
    `background:var(--dsw-specific-input-major)`, `max-width = contentWidth + 32px`, `padding-top:8px`,
    `gap:12px`; input `min-height:36px; padding:4px 8px 0 14px` (hero `52px`); toolbar row
    `padding:2px 8px 6px; gap:12px`; a `34×34` `border-radius:999px` send button in
    `--dsw-alias-button-info-fill` with `transform:translateY(-2px)`; an `28×28` round "+" in
    `--dsw-specific-selector`. Textarea scroll clamp `336px`.
13. **The squircle**: `@supports (corner-shape:superellipse(1.5)){ :root{--dsw-corner-shape:superellipse(1.5)}
    *,:before,:after{corner-shape:var(--dsw-corner-shape)} }`, with `corner-shape:round` pinned on every
    `50%`/`999px` shape (49 sites).
14. **Tool/message rows**: `min-height` ~24–36px, `border-radius:6px`, summary at `13px/24px`, a `2×2`
    `border-radius:1px` separator with `margin:0 8px`, chevron `16×16` with `transition:transform .1s`
    rotating `-90deg → 0`.
15. **Tool call cards** share one recipe: `margin:16px 0` (or `4px 0 4px 4px` nested), `border-radius:12px`
    (`var(--dsl-*-radius)`), a banner/header at `padding:9px 14px; gap:12px` with
    `border-bottom:.5px solid var(--dsw-alias-border-l2)` when idle, and a mono body at
    `11px/19px` (`--dsw-font-markdown-code-block`) or `11px/16px`.
16. **Markdown body**: `p` `margin:16px 0`; `h1/h2/h3` `700` at `21/30`, `19/28`, `18/26` with
    `margin:32px 0 16px`; `h4` `600 14/24` `margin:16px 0`; `ul/ol` `margin:16px 0; padding-left:18px`,
    `li+li{margin-top:6px}`; `hr` `height:.5px; margin:32px 0`; `blockquote` `border-left:2px solid
    var(--dsw-alias-label-caption); padding-left:14px`; inline `code` `border:.5px solid var(--dsw-alias-border-l1);
    border-radius:6px; padding:0 5px; font-size:.875em`; tables `border-collapse:collapse`,
    `th/td{padding:10px 16px; min-width:100px; max-width:min(30vw,320px)}` with `th→border-l3`, `td→border-l2`,
    first-child `padding-left:0`, last-child `padding-right:0`.
17. **Code block**: `margin:16px 0; border-radius:12px; background:var(--dsw-alias-markdown-code-block)`;
    banner `background:var(--dsw-alias-markdown-code-block-banner); padding:9px 14px; gap:12px;
    font:11px/18px`; `<pre>` `padding:16px; font:400 11px/19px var(--ds-font-family-code)`;
    optional line numbers in a `ch`-measured gutter; Shiki token colours per §1.7.
18. **Primitives — Button**: `border-radius:18px`, `padding:0 14px`, `gap:4px`, `14px/22px`,
    md `height:36px`, sm `height:28px; font-size:12px; line-height:18px; padding:0 10px; border-radius:14px`;
    variants primary / ghost / outline / toolbar / icon-16; disabled `opacity:.4`.
19. **Primitives — Menu**: `padding:4px; border-radius:20px; min-width:218px; max-width:360px;
    background:var(--dsw-specific-menu); box-shadow:var(--dsw-elevation-prominent)` with the stroke recoloured
    to `--dsw-alias-border-l1`; items `min-height:40px; padding:8px 10px; border-radius:10px; gap:8px;
    14px/22px`; icons `16×16` in `--dsw-alias-label-tertiary`; separators `height:.5px; margin:4px 2px`;
    compact variant `min-width:164px; padding:2px; border-radius:7px` with `26px` items at `12px/18px`.
20. **Primitives — Dialog**: scrim `--dsw-alias-bg-mask-1` + `backdrop-filter:var(--dsw-mask-blur)` (`blur(2px)`);
    panel `min(380px,100%)`, `border-radius:24px`, `background:var(--dsw-alias-bg-layer-2)`,
    `box-shadow:var(--dsw-elevation-prominent)`, `padding:0 0 24px`, `gap:20px`; header
    `padding:22px 14px 12px 24px`; title `16px/24px w500`; 28px close button with a `20px` gap to the title;
    body/footer `padding:0 24px`. **No enter animation.**
21. **Primitives — Toast**: `position:fixed; top:40px; left:50%; transform:translate(-50%); z-index:1100;
    max-width:min(640px, 100vw - 48px); padding:12px 16px; border-radius:14px;
    background:var(--dsw-alias-button-contrast-fill); color:var(--dsw-alias-label-primary-inverted);
    14px/22px; box-shadow:var(--dsw-shadow-lv3)`; in `.16s ease-out`, fade after `3s`.
22. **Primitives — Tooltip**: `max-width:50vw; padding:3px 7px; border-radius:8px;
    background:var(--dsw-alias-tooltip-bg)` (`#2c2c2e` / `#43454a`); text `13px/20px` **always light**
    (`var(--dsw-static-neutral-bluish-00)`); `pointer-events:none`; `.15s` fade.
23. **Primitives — Tag / Pill / Switch / Input / StatusDot**: tag `11px/17px w500; padding:1px 8px;
    radius:999px` with 8 `data-tone`s (state tones use `color-mix(… 10–12%, transparent)` backgrounds);
    pill `24px` tall, `12px/18px`, `radius:12px`; switch `36×20; padding:2px; radius:10px` with a `16px` thumb
    travelling `16px` in `.12s ease`; input `32px` tall, `radius:8px`, `border:.5px var(--dsw-alias-border-l4)`,
    focus → `--dsw-alias-brand-primary`; status dot = 10%-opacity halo (`:before{inset:0; opacity:.1}`) plus a
    solid disc at `:after{inset:20%}` (i.e. **60% of the box diameter**) in `currentColor`
    (done/warning/error/idle = success/warn/error/tertiary, ongoing = `--dsw-static-deepseek-450`).
24. **Elevation**: one composed 3-part shadow family —
    `--dsw-elevation-stroke` = `0 0 0 .5px var(--dsw-elevation-stroke-color)`, then
    `panel` (`3px/8px @8% + 16px @5%`), `prominent` (`3px/8px @10% + 20px @13%`),
    `soft` (`4px/16px @8% + 24px @8%`). The stroke colour is retuned locally per surface
    (menu/dock `l1`, composer `l2`, FAB `l3`). All theme-independent.
25. **Scrollbars**: `8px` wide, transparent track, thumb `border-radius:4px` in
    `--dsw-alias-scrollbar-bg-l2` / hover `-hover-l2`, recoloured per surface via
    `--dsh-scrollbar-thumb(-hover)`, plus a `scrollbar-width:thin` fallback.
26. **Icon buttons converge on `28×28`, `border-radius:28px` (or `50%`), `padding:6px`, `svg 15×15`,
    hover `--dsw-alias-interactive-bg-hover`.** Collapsed sidebar uses `36×36`.
27. **Hover states are tint-only**: `--dsw-alias-interactive-bg-hover` `#2631480f` / `#ffffff14`;
    active `#2631481a` / `#ffffff24`; danger-hover `#ec13130d` / `#f25a5a26`; "solid" variant
    `--dsw-alias-interactive-bg-hover-solid` = `bluish-75` / `bluish-800`.
28. **Radius vocabulary**: `4/6/8/10/12/14/16/18/20/22/24px`, `999px`, `50%`. Named: bubble & composer `22px`,
    button `18px`, menu/float `20px`, dialog `24px`, card & code block `12px`, tooltip & input `8px`,
    tag `999px`, toast `14px`.
29. **Motion budgets**: hover/resize `.1–.12s`; sidebar and disclosure `.15–.18s`; the turn navigator
    `.22s cubic-bezier(.2,.8,.2,1)`; shell column resize `.3s var(--ds-ease-in-out)` (`.4,0,.2,1`);
    message-action reveal `80ms`; toast `.16s`; tooltip `.15s`. **Dialogs do not animate in.**
30. **Streaming shimmer**: `background-clip:text` + transparent fill, `1.8s linear infinite` for the turn
    status (`250% 100%` background, `deepseek-500 → deepseek-200 → deepseek-500`), `1.6s ease-in-out` for
    retry text (`200%`), and a 300px / `2.6s ease-out infinite` sweep pseudo-element on every running row.
31. **Reduced motion** must be honoured in all three shapes: `transition:none`/`animation:none`; keep-the-end-
    state for toast/tooltip; and de-animate the shimmer (`background-size:100% 100%; animation:none`).
    Opt-in animation uses `@media (prefers-reduced-motion:no-preference)`.
32. **`@media (hover:hover)` / `(pointer:coarse)`** decide whether affordances are hover-revealed or always
    visible — touch devices must never hide a control behind hover.
33. **Breadcrumb header**: `min-height:76px`, `padding:10px 28px 0 20px`,
    `border-bottom:.5px solid var(--dsw-alias-border-l3)`; crumbs `max-width:220px` with
    `padding:4px 8px; border-radius:12px; 14px/20px`; a `gap:36px` tab strip whose active tab is
    `--dsw-alias-state-business-primary` with a `2px; border-radius:2px` underline at `bottom:-1px`.
34. **Hero (empty state)**: headline `26px/32px w500`, stack `max-width = composerCardMaxWidth`, composer input
    grown to `min-height:52px`, `padding-bottom:32px`, two-line clamped placeholder.
35. **Right-panel / DockKit**: tabs `28px` tall, `border-radius:12px`, `min-width:80px / max-width:170px`,
    `13px/1`; close `20×20` at `top:4px; right:4px`; `+` button `28×28 radius:12px`; floating panel
    `border-radius:20px` with `--dsw-elevation-prominent`; drop hints `40%` bands with a `1.5px dashed
    var(--dsw-alias-border-l2)` `radius:12px` card, active border
    `--dsw-alias-brand-primary-new-colorprimary-new-color`.
36. **Composer overlays**: todo dock `border:.5px solid var(--dsw-alias-border-l1); border-radius:12px;
    max-height:180px list`; queue dock `border-radius:12px 12px 0 0` with an inset `.5px` hairline `:after`;
    both inset from the composer by `--dsh-composer-dock-inset: 8px` and lapped by
    `calc(0px - var(--dsh-composer-stack-gap) - 3px)`.
37. **Turn navigator rail** at the right edge of the transcript: `28px` wide, offset
    `calc(12px - 32px)` = `-20px`, band `100dvh - composerHeight`, marks `12×2` (`8/18/20px` for
    unloaded/preview/active), preview card `min(300px, 100cqw - 120px)`, `radius:10px`,
    `--turn-preview-height:100px`, `box-shadow:var(--dsw-elevation-panel)`.
38. **Attachments**: `64×64` thumbnails with `border-radius:16px` and `border:.5px solid
    var(--dsw-alias-border-l2-darkmode-thin)`; `18×18` circular remove button at `top:4px; right:4px`;
    `240×64` file cards with `border-radius:16px` and a `28×28` icon.
39. **Use `text-autospace:normal` on `body` and `no-autospace` on `code,pre,[data-diff],[data-read],
    [data-search],[data-terminal]`**, and `font-family:inherit` on `button,input,select,textarea`.
40. **Do not reproduce the 29 dangling tokens** (`--dsw-alias-label-error`, `--dsw-font`, `--dsw-font-mono`,
    `--dsw-font-sm-13`, `--dsw-alias-label-quaternary`, `--dsw-alias-bg-layer-4`, …). Use the alias tokens
    actually defined in §1.5.
