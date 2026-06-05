<script lang="ts">
	import { base } from '$app/paths';
	import CockpitMock from '$lib/components/CockpitMock.svelte';
	import Showcase from '$lib/components/Showcase.svelte';
	import Architecture from '$lib/components/Architecture.svelte';
	import Roadmap from '$lib/components/Roadmap.svelte';
	import CTA from '$lib/components/CTA.svelte';
	const repo = 'https://github.com/jsgerman-oss/gascity-cockpit';
</script>

<svelte:head>
	<title>GasCity Cockpit · drive your fleet from the editor</title>
	<meta
		name="description"
		content="GasCity Cockpit turns VS Code into a live, multi-pane cockpit for the towns of coding agents you run. Monitoring, the whole beads backlog, agent chat, and native approvals, all on the gascity /v0 API."
	/>
</svelte:head>

<section class="hero">
	<div class="field" aria-hidden="true"></div>
	<div class="shell hero-grid">
		<div class="hero-copy">
			<p class="eyebrow">VS Code extension</p>
			<h1 class="hero-title">
				Drive your fleet<br />
				<span class="accent-line">from inside the editor.</span>
			</h1>
			<p class="hero-lede">
				GasCity Cockpit turns VS Code into a live, multi-pane cockpit for the towns of coding
				agents you run: monitoring, the whole beads backlog, agent chat, and native
				tool-approvals, all on the gascity <code>/v0</code> API.
			</p>
			<div class="hero-cta">
				<a class="btn-primary" href={repo} target="_blank" rel="noreferrer">
					Get it on GitHub
					<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M5 12h14M13 6l6 6-6 6" stroke-linecap="square" /></svg>
				</a>
				<a class="btn-ghost" href="{base}/features/">Explore the features</a>
			</div>
			<dl class="hero-meta">
				<div><dt>Surfaces</dt><dd>17 shipped</dd></div>
				<div><dt>Tests</dt><dd>416 green</dd></div>
				<div><dt>Backend</dt><dd>/v0 client</dd></div>
				<div><dt>License</dt><dd>MIT</dd></div>
			</dl>
		</div>
		<div class="hero-art">
			<CockpitMock />
		</div>
	</div>
</section>

<Showcase />
<Architecture />
<Roadmap />
<CTA />

<style>
	.hero {
		position: relative;
		overflow: hidden;
		padding-block: clamp(3.5rem, 8vw, 7rem) clamp(4rem, 9vw, 8rem);
	}
	.field {
		position: absolute;
		inset: 0;
		background-image:
			linear-gradient(var(--grid-line) 1px, transparent 1px),
			linear-gradient(90deg, var(--grid-line) 1px, transparent 1px);
		background-size: 64px 64px;
		mask-image: radial-gradient(120% 90% at 70% 0%, #000 0%, transparent 70%);
		-webkit-mask-image: radial-gradient(120% 90% at 70% 0%, #000 0%, transparent 70%);
	}
	.field::after {
		content: '';
		position: absolute;
		top: -25%;
		right: -10%;
		width: 50rem;
		height: 50rem;
		background: radial-gradient(circle, var(--glow) 0%, transparent 60%);
		pointer-events: none;
	}
	.hero-grid {
		position: relative;
		display: grid;
		grid-template-columns: minmax(0, 1.05fr) minmax(0, 0.95fr);
		align-items: center;
		gap: clamp(2.5rem, 5vw, 4.5rem);
	}
	.hero-title {
		font-size: var(--text-display);
		font-weight: 600;
		letter-spacing: -0.035em;
		line-height: 1.04;
		margin-top: 1.25rem;
		max-width: 16ch;
	}
	.accent-line {
		color: var(--accent);
	}
	.hero-lede {
		margin-top: 1.75rem;
		max-width: 52ch;
		font-size: var(--text-lead);
		line-height: 1.45;
		color: var(--ink);
	}
	.hero-lede code {
		font-family: var(--font-mono);
		font-size: 0.85em;
		color: var(--accent);
	}
	.hero-cta {
		display: flex;
		flex-wrap: wrap;
		gap: 1rem;
		margin-top: 2.25rem;
	}
	.btn-primary {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.9rem 1.5rem;
		background: var(--accent);
		color: var(--bg);
		font-weight: 600;
		font-size: 0.9375rem;
		transition: background 140ms ease, transform 140ms ease;
	}
	.btn-primary:hover {
		background: var(--accent-strong);
		transform: translateY(-1px);
	}
	.btn-ghost {
		display: inline-flex;
		align-items: center;
		padding: 0.9rem 1.5rem;
		border: 1px solid var(--hairline-strong);
		color: var(--ink);
		font-weight: 500;
		font-size: 0.9375rem;
		transition: border-color 140ms ease, background 140ms ease, transform 140ms ease;
	}
	.btn-ghost:hover {
		border-color: var(--accent);
		background: var(--lifted);
		transform: translateY(-1px);
	}
	.hero-meta {
		display: flex;
		flex-wrap: wrap;
		gap: 2.25rem;
		margin-top: 3rem;
		padding-top: 1.75rem;
		border-top: 1px solid var(--hairline);
	}
	.hero-meta div {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}
	.hero-meta dt {
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--caption);
	}
	.hero-meta dd {
		margin: 0;
		font-family: var(--font-mono);
		font-size: 0.9375rem;
		color: var(--ink);
	}
	.hero-art {
		display: flex;
		justify-content: flex-end;
	}
	/* Above-the-fold load choreography. Ends at the natural state, so static
	   renders and reduced-motion users always see the final layout. */
	@keyframes rise {
		from {
			opacity: 0;
			transform: translateY(14px);
		}
		to {
			opacity: 1;
			transform: none;
		}
	}
	.hero-copy > * {
		animation: rise 0.7s var(--ease-out-expo) backwards;
	}
	.hero-copy > :nth-child(1) { animation-delay: 0.04s; }
	.hero-copy > :nth-child(2) { animation-delay: 0.11s; }
	.hero-copy > :nth-child(3) { animation-delay: 0.19s; }
	.hero-copy > :nth-child(4) { animation-delay: 0.27s; }
	.hero-copy > :nth-child(5) { animation-delay: 0.35s; }
	.hero-art {
		animation: rise 0.9s var(--ease-out-expo) 0.28s backwards;
	}
	@media (prefers-reduced-motion: reduce) {
		.hero-copy > *,
		.hero-art {
			animation: none;
		}
	}

	@media (max-width: 940px) {
		.hero-grid {
			grid-template-columns: 1fr;
			gap: 3rem;
		}
		.hero-art {
			justify-content: flex-start;
		}
		.hero-title {
			max-width: 18ch;
		}
	}
</style>
