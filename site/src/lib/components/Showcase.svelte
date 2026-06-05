<script lang="ts">
	import FeatureGrid from './FeatureGrid.svelte';
	import { essentials, powerTools } from '$lib/features';
</script>

<section class="section" id="features">
	<div class="shell">
		<header class="sec-head">
			<p class="eyebrow">What you get</p>
			<h2 class="sec-title">Seventeen surfaces, one cockpit.</h2>
			<p class="sec-lede">
				Every pane below is built and merged. Keyboard-navigable, theme-aware across light, dark,
				and high-contrast, and driven entirely by the <code>/v0</code> API.
			</p>
		</header>

		<div class="tier">
			<div class="tier-label">
				<span class="tnum">01</span>
				<span>The essentials</span>
				<span class="tdim">· the v1 surface</span>
			</div>
			<FeatureGrid items={essentials} start={1} />
		</div>

		<div class="tier">
			<div class="tier-label">
				<span class="tnum">02</span>
				<span>Power tools</span>
				<span class="tdim">· the expansion</span>
			</div>
			<FeatureGrid items={powerTools} start={10} />
		</div>
	</div>
</section>

<style>
	.section {
		padding-block: clamp(4rem, 9vw, 7.5rem);
	}
	.sec-head {
		max-width: 60rem;
		margin-bottom: clamp(2.5rem, 5vw, 4rem);
	}
	.sec-title {
		font-size: var(--text-headline);
		margin-top: 1rem;
		max-width: 18ch;
	}
	.sec-lede {
		margin-top: 1.25rem;
		max-width: 58ch;
		font-size: var(--text-lead);
		line-height: 1.45;
		color: var(--mute);
	}
	.sec-lede code {
		font-family: var(--font-mono);
		font-size: 0.85em;
		color: var(--accent);
	}
	.tier + .tier {
		margin-top: clamp(2.5rem, 5vw, 4rem);
	}
	.tier-label {
		display: flex;
		align-items: baseline;
		gap: 0.6rem;
		padding-bottom: 0.9rem;
		margin-bottom: 1.25rem;
		border-bottom: 1px solid var(--hairline);
		font-family: var(--font-mono);
		font-size: 0.9375rem;
		font-weight: 500;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--ink);
	}
	.tnum {
		font-size: 1.5rem;
		font-weight: 600;
		color: var(--accent);
		letter-spacing: 0;
	}
	.tdim {
		color: var(--caption);
		text-transform: none;
		letter-spacing: 0.02em;
		font-size: 0.8125rem;
	}
</style>
