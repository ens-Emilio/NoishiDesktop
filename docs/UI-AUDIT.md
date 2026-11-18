# Noishi Desktop — UI Audit Findings
**Date:** 2026-11-17 | **Scope:** 7 tabs × 2 themes (dark/light) at 1200×800
**Method:** CDP eval inside live app + Page.captureScreenshot + computed contrast ratio

---

## Severity key
- 🔴 WCAG AA fail (ratio < 4.5)
- 🟡 WCAG AA fail large text only (4.5–7.0) or tiny target (< 24px)
- 🟢 OK

---

## Finding 1 — Unnamed interactive controls
**Severity:** 🟡 | **WCAG:** 4.1.2

Two interactive elements have no accessible name (no `aria-label`, no text content):

| Class | Size | WCAG Fix |
|---|---|---|
| `button.icon-btn.icon-btn--tiny` (sidebar section toggle) | 18×18 | `aria-label="Alternar seção"` |
| `button.btn.btn--icon.btn--sm composer-send` | 24×32 | `aria-label="Enviar"` |

**Root cause:** `apps/desktop/src/renderer/App.tsx` — the icon buttons render `<svg>` without a parent `aria-label` or `<Icon label="…">` wrapper.

---

## Finding 2 — Tiny tap/click targets
**Severity:** 🟡 | **WCAG:** 2.5.8 (target size ≥ 24px)

| Class | Size | Has label | Fix |
|---|---|---|---|
| `button.icon-btn` (sidebar collapse) | 22×22 | "Colapsar barra lateral" | Pad to 24px or drop below 24px threshold |
| `button.icon-btn.icon-btn--tiny` | 18×18 | none | See Finding 1 |

The collapse button is 22×22 — 2px short of the WCAG non-touch target minimum (24×24). In a mouse-only desktop app this is borderline; for completeness, pad it.

---

## Finding 3 — Contrast failure (light theme)
**Severity:** 🔴 | **WCAG:** 1.4.3 AA

Only light theme is affected. Dark theme passes all checks (lowest ratio: 5.32).

| Element | Color | Background | Ratio | Threshold |
|---|---|---|---|---|
| `button.btn--ghost` (Clonar) | #5b41ae | #faf8fc | **2.33** | 4.5 |
| `button.view-tab` (Terminal) | #726a80 | #faf8fc | 2.92 | 4.5 |

**Root cause:** `tokens.css` `--fg-faint` (#726a80) on `--bg-window` (#faf8fc) → 2.92. The ghost button's text color may be `--fg-muted` which lands at 2.33.

**Fix (2 options):**
- *Option A (tokens):* Increase `--fg-muted` and `--fg-faint` luminance in light theme so all ratios ≥ 4.5.
- *Option B (per-element):* Set the ghost button's text color explicitly to `--fg-muted` (#5c5568) or ensure the hover/ghost token resolves correctly.

---

## Finding 4 — Breadcrumb stale on tab switch
**Severity:** 🟡 | **UX**

The topbar breadcrumb reads "Nova conversa" even when a project is open and the active tab is Git/Revisão/Contexto/Ajustes. It never reflects the current view or the open project.

**Root cause:** `App.tsx:1503` — `state?.sessionName ?? "Nova conversa"`. `sessionName` only changes on session start/commit; `setView()` never updates it.

```tsx
// Current:
<span className="crumb">{state?.sessionName ?? (mode === "buddy" ? "Buddy" : "Nova conversa")}</span>

// Fix (add view awareness):
<span className="crumb">
  {state?.sessionName
    ?? (view === "chat" ? "Nova conversa"
    : VIEW_LABELS[view] ?? "Nova conversa")}
</span>
```

---

## Positive findings

| Item | State | Note |
|---|---|---|
| Scroll overflow | 🟢 | No horizontal overflow at 1200px |
| Headings | 🟢 | H1 greeting present |
| Landmarks | 🟢 | aside, header, tablist, status all present |
| Terminal welcome state | 🟢 | No redundant empty state (confirmed hidden when CLI up) |
| View tabs a11y | 🟢 | `role="tab"`, `aria-selected`, `aria-label` on tablist |
| Dark theme contrast | 🟢 | Lowest ratio 5.32 (borderline but passes) |
| Git panel (no session) | 🟢 | Empty state renders correctly |
| Sidebar collapse | 🟢 | Has tooltip "Colapsar barra lateral" |

---

## Proposed fix priority

1. **Finding 3** — `aria-label` on send button + fix ghost button contrast (5 min)
2. **Finding 1** — `aria-label` on section toggle (2 min)
3. **Finding 4** — Breadcrumb view awareness (5 min)
4. **Finding 2** — Pad collapse button to 24×24 (1 min)

---

*Evidence: 14 PNG screenshots at `/tmp/noishi-audit/` (dark-{tab}.png, light-{tab}.png), contrast JSON at `probe.json`.*
