<script lang="ts">
	const horizon = [
		{ name: 'Telemetry, end to end', v: 'Full model-advisor and token-budget data, via an upstream /v0 API change (filed).' },
		{ name: 'Companion surfaces, for real', v: 'An actual web or mobile companion on the shared typed client; the spike proved the core is portable.' },
		{ name: 'Beyond localhost', v: 'A remote and auth story so you can drive cities you don’t own. v1 is localhost-only by design; the seams are in place.' },
		{ name: 'Consistent edges', v: 'Unified empty, loading, and error states across every pane. In flight now.' }
	];
	const unstarted = [
		{ name: 'Multi-operator cockpit', v: 'Shared, presence-aware sessions over the same city.' },
		{ name: 'Saved views & dashboards', v: 'Pin the queries and panes you live in.' },
		{ name: 'Metrics over time', v: 'Throughput, cycle time, and reject rates per rig and per agent.' },
		{ name: 'Replay → regression test', v: 'Turn an event time-travel replay into a saved scenario test.' }
	];
	const repo = 'https://github.com/jsgerman-oss/gascity-cockpit';
</script>

<section class="section" id="roadmap">
	<div class="shell">
		<header class="sec-head">
			<p class="eyebrow">What's next</p>
			<h2 class="sec-title">The roadmap is open.</h2>
			<p class="sec-lede">
				The first wishlist on this page already shipped, it became the power tools. Here is what is
				on deck, and what we haven’t started. Proposals are genuinely wanted.
			</p>
		</header>

		<div class="cols">
			<div class="col">
				<div class="col-head"><span class="cg horizon" aria-hidden="true">◐</span> On the horizon</div>
				<ul class="rlist">
					{#each horizon as r}
						<li><span class="rname">{r.name}</span><span class="rv">{r.v}</span></li>
					{/each}
				</ul>
			</div>
			<div class="col">
				<div class="col-head"><span class="cg open" aria-hidden="true">○</span> Not started yet</div>
				<ul class="rlist">
					{#each unstarted as r}
						<li><span class="rname">{r.name}</span><span class="rv">{r.v}</span></li>
					{/each}
				</ul>
				<a class="file" href="{repo}/issues" target="_blank" rel="noreferrer">
					Have an idea? File an issue
					<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M5 12h14M13 6l6 6-6 6" stroke-linecap="square" /></svg>
				</a>
			</div>
		</div>
	</div>
</section>

<style>
	.section {
		padding-block: clamp(4rem, 9vw, 7.5rem);
	}
	.sec-head {
		max-width: 60rem;
		margin-bottom: clamp(2.5rem, 5vw, 3.5rem);
	}
	.sec-title {
		font-size: var(--text-headline);
		margin-top: 1rem;
	}
	.sec-lede {
		margin-top: 1.25rem;
		max-width: 60ch;
		font-size: var(--text-lead);
		line-height: 1.45;
		color: var(--mute);
	}
	.cols {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: clamp(2rem, 5vw, 4rem);
	}
	.col-head {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		font-family: var(--font-mono);
		font-size: 0.875rem;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--ink);
		padding-bottom: 0.9rem;
		margin-bottom: 0.5rem;
		border-bottom: 1px solid var(--hairline);
	}
	.cg {
		font-size: 1rem;
	}
	.cg.horizon {
		color: var(--accent);
	}
	.cg.open {
		color: var(--caption);
	}
	.rlist {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.rlist li {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		padding: 1.1rem 0;
		border-bottom: 1px solid var(--hairline);
	}
	.rname {
		font-size: 1rem;
		font-weight: 600;
		color: var(--ink);
	}
	.rv {
		font-size: 0.9rem;
		line-height: 1.5;
		color: var(--mute);
		max-width: 46ch;
	}
	.file {
		display: inline-flex;
		align-items: center;
		gap: 0.45rem;
		margin-top: 1.25rem;
		font-family: var(--font-mono);
		font-size: 0.875rem;
		color: var(--accent);
		transition: gap 160ms var(--ease-out-quart);
	}
	.file:hover {
		gap: 0.75rem;
	}
	@media (max-width: 760px) {
		.cols {
			grid-template-columns: 1fr;
			gap: 2.5rem;
		}
	}
</style>
