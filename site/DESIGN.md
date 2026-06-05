---
name: GasCity Cockpit
description: Marketing + docs site for the GasCity Cockpit VS Code extension. Inherits blackrim's "Working Lab Notebook" system with the Cockpit's own ignition-azure accent.
colors:
  ignition: "oklch(0.72 0.152 228)"
  ignition-lift: "oklch(0.8 0.14 228)"
  ignition-deep: "oklch(0.52 0.12 232)"
  bg-dark: "oklch(0.15 0.014 245)"
  surface-dark: "oklch(0.188 0.018 244)"
  lifted-dark: "oklch(0.236 0.022 243)"
  hairline-dark: "oklch(0.31 0.02 245)"
  hairline-strong-dark: "oklch(0.42 0.028 245)"
  ink-dark: "oklch(0.975 0.006 250)"
  mute-dark: "oklch(0.745 0.028 250)"
  caption-dark: "oklch(0.57 0.032 252)"
  bg-light: "oklch(0.976 0.005 95)"
  ink-light: "oklch(0.22 0.022 245)"
  accent-light: "oklch(0.56 0.16 236)"
  signal-amber: "oklch(0.82 0.14 76)"
  signal-red: "oklch(0.68 0.2 22)"
  signal-green: "oklch(0.88 0.18 158)"
typography:
  display:
    fontFamily: "'Inter Variable', Inter, sans-serif"
    fontSize: "clamp(2.75rem, 1.6rem + 5.4vw, 5.25rem)"
    fontWeight: 600
    letterSpacing: "-0.03em"
  headline:
    fontFamily: "'Inter Variable', Inter, sans-serif"
    fontSize: "clamp(2rem, 1.3rem + 3.2vw, 3.5rem)"
    fontWeight: 600
    letterSpacing: "-0.02em"
  mono:
    fontFamily: "'JetBrains Mono Variable', monospace"
    fontSize: "15px"
  label:
    fontFamily: "'JetBrains Mono Variable', monospace"
    fontSize: "13px"
    fontWeight: 500
    letterSpacing: "0.14em"
rounded:
  none: "0"
  code: "4px"
---

# Design System: GasCity Cockpit

The Cockpit site inherits the **blackrim "Working Lab Notebook"** system wholesale —
operations-room calm, evidence-first, the surface is the proof. Read
`/Users/jayse/Code/blackrim/DESIGN.md` for the full rationale; everything there holds unless
overridden below. One deliberate departure: the accent.

## The one departure: ignition azure

Where blackrim signs with **Armada Blue** (`#2b5fff`, an indigo-leaning blue, OKLCH hue ~266),
the Cockpit signs with **ignition azure** (`oklch(0.72 0.152 228)`, hue ~228) — a brighter,
cyan-shifted blue that reads as live telemetry / instrument glow, and is visibly its own
product beside blackrim. It carries the same role: the single color of meaning, on links,
eyebrows, the hero accent line, focus rings, the grid texture, and the hero halo. The neutral
ramp is re-tinted toward 228 at very low chroma (still a tinted near-black, never `#000`).

## Carried over unchanged

- **Inter + JetBrains Mono.** Identity preserved from blackrim (not a greenfield pick). Sans
  for argument, mono for evidence.
- **Square corners.** Radius `0` on buttons, badges, cards, inputs. Only `<pre>`/`<code>` get
  a 4px softening.
- **Hairline-driven hierarchy.** 1px borders carry structure; flat by default; hover lifts via
  `translateY(-2px)`, never shadow.
- **The `/` eyebrow.** Every section title is preceded by a mono uppercase eyebrow, accent
  color, prefixed with a `/` glyph in caption-slate.
- **Two themes.** Dark primary, light full fidelity, same accent role in both.

## Signature artifact: the hero cockpit

Blackrim's hero is a faux-but-real *terminal*. The Cockpit's is a faux-but-real **VS Code
window** showing the actual Cockpit panes — an activity-bar rail, a Beads explorer tree with
real bead IDs, a live status / Fleet pane, and a Mayor chat turn — rendered in the system's
own tokens (square, hairline, mono evidence, ignition accent, signal colors only as runtime
status). It is the only element that gets the reserved halo
(`0 0 0 1px var(--halo-ring), 0 24px 80px -20px rgba(0,0,0,0.6)`). Nothing else on the page does.

## Motion

Ambitious first-load choreography is a brand permission and the Cockpit takes it: a staged
hero reveal (eyebrow → headline lines → lede → cockpit panel fading up), the cockpit panes
settling in sequence, a blinking ignition caret, and the live-status pulse. Section reveals
enhance already-visible content, stagger to fit what they reveal, and every timeline has a
`prefers-reduced-motion` crossfade/instant fallback. Easing is `ease-out-expo`/`quart`; no
bounce, no elastic.

## Layout

Multi-page SvelteKit (prerendered static for GitHub Pages): `/` (landing), `/features`,
`/architecture`. Shared sticky nav (translucent + 12px backdrop blur, brand mark + wordmark,
mute→ink links with accent active-underline, theme toggle + GitHub ghost button) and footer.
Content shell caps at 76rem; prose caps at 64ch, leads at 52–64ch, headings at 14–26ch.
