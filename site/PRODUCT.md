# Product

## Register

brand

## Users

Operators of one or more "gas cities" — orchestrated towns of AI coding agents (a Mayor
that coordinates, polecats that execute, witnesses and refineries that keep work healthy and
merged). They are engineers who already live in VS Code and currently drive the fleet from a
terminal (`gc`, `gc bd`, `gc mail`) plus a separate web dashboard. They land on this site to
decide, in under a minute, whether the Cockpit is worth installing. Context: a developer at a
laptop, technically fluent, allergic to marketing.

## Product Purpose

GasCity Cockpit is a VS Code extension that turns the editor into a live, multi-pane cockpit
for driving fleets of coding agents, built entirely on the gascity `/v0` HTTP API. The site
exists to communicate what it is and earn an install: it shows the 17 shipped surfaces (8
essentials + 9 power tools), the architecture (pure `/v0` client + feature-registry), and
the roadmap. Success = a visitor understands the product and clicks through to the repo.

## Brand Personality

Operations-room calm, instrumented, evidence-first. Three words: precise, observable,
unhurried. The surface is the proof — the same instrument the product is. Voice is a senior
engineer explaining their own tool, never a marketer performing enthusiasm.

## Anti-references

- Generic SaaS-cream landing (soft gradient hero, abstract mascot, three-icon feature row).
- Crypto / cyberpunk neon-on-black (saturated neon, glitch, "protocol" language).
- Enterprise tech-bro deck (stock photos of people pointing at monitors, navy+gold,
  "enterprise-grade" adjectives).
- The hero-metric template (giant number + small label + supporting stats).
- Editorial-magazine cosplay (display-serif italic + drop caps + broadsheet grid) on a tool
  that isn't a magazine.

## Design Principles

- **The surface is the proof.** Show the real instrument — a faithful Cockpit panel, real
  bead IDs, real command names — not an abstraction of it.
- **Mono carries evidence, sans carries argument.** Anything that is the work renders in
  JetBrains Mono; the argument about it renders in Inter.
- **Hairlines, not shadows.** 1px borders and background-step + Y-shift do the structural
  work. Flat by default; one reserved halo for the hero artifact.
- **One accent, high commitment.** Ignition azure is the only color of meaning. Signal
  colors (amber/red/green) appear only as runtime status, never decoration.
- **Density is respect.** Assume a reader who holds an argument across a paragraph and a code
  sample. No filler, no restated headings.

## Accessibility & Inclusion

WCAG 2.1 AA. Body text ≥4.5:1, large text ≥3:1, verified against both themes. Color never the
sole signal (pair with shape, weight, or label). Full keyboard navigation and visible focus
rings. Every animation has a `prefers-reduced-motion` alternative; the reduced-motion path is
fully functional, not "broken minus the motion." Dark is primary; light is full fidelity.
