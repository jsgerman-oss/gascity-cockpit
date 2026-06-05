<script lang="ts">
	import { base } from '$app/paths';
	import Showcase from '$lib/components/Showcase.svelte';

	const qualities = [
		{
			k: 'Accessible by default',
			v: 'Every surface is keyboard-navigable with visible focus, accessible names on tree items, and aria-live announcements on the chat and status panes. Theme-aware across light, dark, and high-contrast.'
		},
		{
			k: 'One registry, parallel merges',
			v: 'Each feature is a self-registering module under src/features carrying its own contributions. extension.ts stays a thin host, so a dozen features land in parallel without fighting over one file.'
		},
		{
			k: 'Cores without vscode',
			v: 'The logic worth testing lives behind vscode-free domain modules, exercised against a mock /v0. The editor layer stays thin glue. 416 tests run headless under one runner.'
		}
	];
	const repo = 'https://github.com/jsgerman-oss/gascity-cockpit';
</script>

<svelte:head>
	<title>Features · GasCity Cockpit</title>
	<meta name="description" content="The 17 surfaces of GasCity Cockpit: a beads explorer, live status, Mayor chat, approvals, dashboard projection, telemetry, topology, time-travel, and more." />
</svelte:head>

<Showcase />

<section class="section built">
	<div class="shell">
		<header class="sec-head">
			<p class="eyebrow">Under the panels</p>
			<h2 class="sec-title">Built to stay out of your way.</h2>
		</header>
		<dl class="qgrid">
			{#each qualities as q}
				<div class="q">
					<dt>{q.k}</dt>
					<dd>{q.v}</dd>
				</div>
			{/each}
		</dl>
		<div class="links">
			<a class="btn-ghost" href="{base}/architecture/">See the architecture</a>
			<a class="btn-ghost" href={repo} target="_blank" rel="noreferrer">View the source</a>
		</div>
	</div>
</section>

<style>
	.section {
		padding-block: clamp(3rem, 7vw, 6rem) clamp(4rem, 9vw, 7.5rem);
	}
	.built {
		border-top: 1px solid var(--hairline);
		background: var(--surface);
	}
	.sec-head {
		margin-bottom: clamp(2rem, 4vw, 3rem);
	}
	.sec-title {
		font-size: var(--text-title);
		margin-top: 0.9rem;
	}
	.qgrid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(17rem, 1fr));
		gap: clamp(1.5rem, 4vw, 3rem);
	}
	.q dt {
		font-family: var(--font-mono);
		font-size: 0.8125rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--accent);
		padding-bottom: 0.75rem;
		margin-bottom: 0.9rem;
		border-bottom: 1px solid var(--hairline);
	}
	.q dd {
		margin: 0;
		font-size: 0.9375rem;
		line-height: 1.55;
		color: var(--mute);
		max-width: 42ch;
	}
	.links {
		display: flex;
		flex-wrap: wrap;
		gap: 1rem;
		margin-top: clamp(2.5rem, 5vw, 3.5rem);
	}
	.btn-ghost {
		display: inline-flex;
		align-items: center;
		padding: 0.85rem 1.4rem;
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
</style>
