---
# kind — ui: KEEP the token blocks (see template note in loopkit inception).
kind: "ui"
# Design tokens — the durable, agent-readable contract for this project's UI.
# Single source of truth; mirrored 1:1 as CSS custom properties in
# public/css/tokens.css (the only file allowed to contain raw values).
color:
  background: "#0f1115"   # page background
  foreground: "#e8eaed"   # primary text (contrast 15.7:1 on background)
  primary: "#ff7a1a"      # vivid orange accent: primary actions, progress bars, focus ring (7.3:1 with background text)
  secondary: "#1c2029"    # raised surfaces: cards, player bar, dialogs
  accent: "#4fb3ff"       # links, selected state, secondary highlights
  muted: "#9aa0aa"        # secondary text, meta info (contrast 7.2:1 on background)
  border: "#2a2f3a"       # dividers, input borders
  destructive: "#ff5c5c"  # delete, errors, "not playable" badge
type:
  font-sans: "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
  font-mono: "ui-monospace, 'SFMono-Regular', Consolas, 'Liberation Mono', monospace"
  scale: "12 / 14 / 16 / 20 / 24 / 32 / 48 px"
  weights: "400 / 600 / 700"
  line-height: "1.5 body / 1.2 headings"
spacing:
  unit: "4px"
  scale: "4 / 8 / 12 / 16 / 24 / 32 / 48 / 64 px"
radii:
  sm: "4px"
  md: "8px"
  lg: "16px"
  full: "9999px"
shadow:
  sm: "0 1px 2px rgba(0,0,0,.4)"
  md: "0 8px 24px rgba(0,0,0,.5)"
---

# Design contract

> Design contract for the loopkit skills (`/loopkit:design`, `/loopkit:plan`,
> `/loopkit:implement`) — the single source for this project's design medium,
> rules, and handoff. The sibling of `docs/workflow.md`.

## Overview

Dark, media-first interface in the spirit of a home cinema: content (titles,
thumbnails, the player) carries the page, chrome stays quiet. Dark background
reduces glare on TVs and in the evening; a single vivid orange accent marks what
is actionable and how far something has been watched. Layouts are responsive
from phone (360 px) to TV (1920 px), with touch targets of at least 44×44 px and
full keyboard/remote navigation (arrow keys, Enter, Escape). Accessibility
target: WCAG 2.1 AA — every text/background pair in the tokens meets 4.5:1.
No web fonts are loaded (constitution: no outbound calls), hence system font
stacks. UI copy is German.

## Design tool

- Tool / MCP: **Google Stitch (MCP)** — primary editor for screen mockups. No
  secondary tool.
- The tool is the **editor, never the source of truth.** The durable design
  state is the committed files in this repo (see Durable form).
- Auth: in-session / subscription only — no headless run, no API key, no
  scheduler.

## Where designs live

- Source / working designs: the Google Stitch project `videothek`; each spec
  that ships UI notes its Stitch screen link as a working reference only.
- Committed tokens: `docs/design.md` front-matter (this file), mirrored in
  `public/css/tokens.css`.
- Committed assets: `docs/design/assets/<phase-or-scope>/` — exported PNG per
  screen and viewport (`<screen>-mobile.png`, `<screen>-desktop.png`), plus the
  exported HTML when Stitch provides it.

## Durable form

The durable design form is **a file committed to this repo** — a tokens file,
an exported image, or a screenshot — referenced from the spec or the issue. An
external-tool URL (a Figma / v0 / Paper share link) is NOT a valid durable form:
the tool is the editor, the committed file is the state (constitution:
GitHub-only durable state). When `/loopkit:design` finishes, the design exists
as a committed file at the location above, not as a link.

## Review path

- Reviewer: an in-session Agent reviewer checking the exports against this
  contract (tokens only, WCAG 2.1 AA contrast and target sizes, mobile + desktop
  viewport present, German copy).
- The design is reviewed **AT the spec-acceptance gate** as part of the spec
  package — never a separate stop after planning. Reference, do not restate.

## Handoff format

- The issue references the committed PNG exports under `docs/design/assets/`;
  the implementer builds the screen with vanilla HTML/CSS using only the custom
  properties from `public/css/tokens.css`. Exported Stitch HTML is a layout
  reference only — never copied verbatim (it may pull external fonts/CDNs).
- `/loopkit:implement` consumes the committed artifact referenced from the
  design-surface issue; it never reaches into the design tool.

## Components

- **Button** — variants `primary` (orange background, `#0f1115` text), `secondary`
  (secondary surface, foreground text, border), `danger` (destructive text on
  secondary surface); height ≥ 44 px, radius `md`; states: hover lightens 8 %,
  active darkens 8 %, disabled 40 % opacity, focus = 2 px `primary` outline with
  2 px offset.
- **Input** — secondary surface, 1 px `border`, radius `md`, 16 px text (avoids
  iOS zoom); focus = `primary` outline; error = `destructive` border + message
  below.
- **Media card** — thumbnail (16:9 video, 1:1 audio/image, 2:3 poster
  fallback), title (1 line, ellipsis), meta in `muted`; radius `md`, `shadow-sm`;
  progress bar 4 px `primary` along the bottom edge when started; "Nicht
  abspielbar" badge in `destructive` for incompatible files.
- **Category nav** — five fixed entries (Filme, Serien, Musik, Hörbücher,
  Bilder); top bar on desktop, bottom bar on mobile; active entry in `primary`.
- **Player** — native `<video>`/`<audio>` controls on a `background` stage;
  title + back action above; audio player as a persistent bottom bar on
  `secondary` surface.
- **Grid / list** — media cards in a responsive grid (min column 160 px, gap
  16 px); phones always get at least two columns:
  `grid-template-columns: repeat(auto-fill, minmax(min(var(--grid-min), calc(50% - 8px)), 1fr))`
  (8 px = half the gap, written `calc(50% - var(--space-2))` in CSS;
  `--grid-min` = 160 px); episodes and tracks as list rows (≥ 48 px height).

## Do's and Don'ts

**Do**

- Use the spacing scale above for every margin and padding.
- Meet WCAG 2.1 AA and a visible focus state on every interactive element.
- Reference only the named tokens via `public/css/tokens.css` — never a raw hex
  outside that file and this front-matter.
- Show progress (bar or percentage) wherever a started item appears.

**Don't**

- Introduce a color, font, or radius not in the front-matter.
- Load web fonts, icon fonts or CSS from a CDN — inline SVG icons only.
- Treat a Stitch share link as the design — commit the export.
- Add a third human gate — design is reviewed at spec-acceptance.
