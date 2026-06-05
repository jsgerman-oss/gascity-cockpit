<script lang="ts">
	const points = [
		{
			k: 'Pure /v0 client',
			v: 'The Cockpit adds no backend of its own. It speaks the same versioned, self-documenting /v0 HTTP API the web dashboard already uses, served by the running supervisor.'
		},
		{
			k: 'Feature registry',
			v: 'extension.ts is a thin host. Each surface is a self-registering module under src/features with its own package.json contributions, so features merge in parallel without contention.'
		},
		{
			k: 'Typed and resilient',
			v: 'The client is generated from /openapi.json and version-pinned; a discovery layer finds the supervisor and survives restarts and gc stop, keeping the panes live.'
		}
	];
</script>

<section class="section arch" id="architecture">
	<div class="shell">
		<header class="sec-head">
			<p class="eyebrow">How it works</p>
			<h2 class="sec-title">A pure client of one API.</h2>
			<p class="sec-lede">
				Everything you see is the editor talking to the supervisor over <code>/v0</code>. No second
				service, no duplicated state, no backend to run.
			</p>
		</header>

		<div class="diagram" role="img" aria-label="Data flow: the VS Code Cockpit talks to the supervisor's /v0 HTTP and SSE API, which fronts the gas city's agents — Mayor, polecats, refinery, and witness.">
			<div class="node">
				<span class="node-tag">editor</span>
				<span class="node-name">VS Code Cockpit</span>
				<span class="node-sub">typed client · SSE · webviews</span>
			</div>
			<div class="wire">
				<span class="wire-label">/v0 · HTTP + SSE</span>
				<svg class="wire-svg" viewBox="0 0 120 24" preserveAspectRatio="none" aria-hidden="true">
					<line x1="0" y1="12" x2="112" y2="12" stroke="var(--accent)" stroke-width="1.5" stroke-dasharray="4 4" />
					<path d="M104 6 L114 12 L104 18" fill="none" stroke="var(--accent)" stroke-width="1.5" />
				</svg>
			</div>
			<div class="node">
				<span class="node-tag">supervisor</span>
				<span class="node-name">/v0 API</span>
				<span class="node-sub">health · beads · sessions · events</span>
			</div>
			<div class="wire">
				<span class="wire-label">manages</span>
				<svg class="wire-svg" viewBox="0 0 120 24" preserveAspectRatio="none" aria-hidden="true">
					<line x1="0" y1="12" x2="112" y2="12" stroke="var(--hairline-strong)" stroke-width="1.5" />
					<path d="M104 6 L114 12 L104 18" fill="none" stroke="var(--hairline-strong)" stroke-width="1.5" />
				</svg>
			</div>
			<div class="node node-city">
				<span class="node-tag">gas city</span>
				<span class="node-name">The town</span>
				<ul class="agents">
					<li><span class="ad active"></span>Mayor</li>
					<li><span class="ad active"></span>Refinery</li>
					<li><span class="ad active"></span>Witness</li>
					<li><span class="ad idle"></span>Polecats</li>
				</ul>
			</div>
		</div>

		<dl class="points">
			{#each points as p}
				<div class="point">
					<dt>{p.k}</dt>
					<dd>{p.v}</dd>
				</div>
			{/each}
		</dl>
	</div>
</section>

<style>
	.arch {
		background: var(--surface);
		border-block: 1px solid var(--hairline);
	}
	.sec-head {
		max-width: 60rem;
		margin-bottom: clamp(2.5rem, 5vw, 3.5rem);
	}
	.sec-title {
		font-size: var(--text-headline);
		margin-top: 1rem;
		max-width: 16ch;
	}
	.sec-lede {
		margin-top: 1.25rem;
		max-width: 56ch;
		font-size: var(--text-lead);
		line-height: 1.45;
		color: var(--mute);
	}
	.sec-lede code,
	.points code {
		font-family: var(--font-mono);
		font-size: 0.85em;
		color: var(--accent);
	}
	.diagram {
		display: grid;
		grid-template-columns: 1fr auto 1fr auto 1fr;
		align-items: center;
		gap: 0.5rem;
		padding: clamp(1.5rem, 4vw, 2.75rem);
		border: 1px solid var(--hairline-strong);
		background: var(--bg);
	}
	.node {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		padding: 1.25rem;
		border: 1px solid var(--hairline);
		background: var(--surface);
		min-height: 8.5rem;
		justify-content: center;
	}
	.node-tag {
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--accent);
	}
	.node-name {
		font-size: 1.125rem;
		font-weight: 600;
		color: var(--ink);
	}
	.node-sub {
		font-family: var(--font-mono);
		font-size: 0.75rem;
		color: var(--caption);
		line-height: 1.4;
	}
	.agents {
		list-style: none;
		margin: 0.35rem 0 0;
		padding: 0;
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.4rem 0.75rem;
	}
	.agents li {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		font-family: var(--font-mono);
		font-size: 0.8125rem;
		color: var(--mute);
	}
	.ad {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		flex: none;
	}
	.ad.active {
		background: var(--signal-green);
		box-shadow: 0 0 6px color-mix(in oklab, var(--signal-green) 60%, transparent);
	}
	.ad.idle {
		background: var(--caption);
	}
	.wire {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.4rem;
		min-width: 6.5rem;
		padding-inline: 0.25rem;
	}
	.wire-label {
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		letter-spacing: 0.06em;
		color: var(--caption);
		white-space: nowrap;
	}
	.wire-svg {
		width: 100%;
		height: 18px;
	}
	.points {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
		gap: clamp(1.5rem, 4vw, 3rem);
		margin-top: clamp(2.5rem, 5vw, 3.5rem);
	}
	.point dt {
		font-family: var(--font-mono);
		font-size: 0.8125rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--accent);
		padding-bottom: 0.75rem;
		margin-bottom: 0.9rem;
		border-bottom: 1px solid var(--hairline);
	}
	.point dd {
		margin: 0;
		font-size: 0.9375rem;
		line-height: 1.55;
		color: var(--mute);
		max-width: 40ch;
	}
	@media (max-width: 860px) {
		.diagram {
			grid-template-columns: 1fr;
			gap: 0.25rem;
		}
		.wire {
			flex-direction: row;
			justify-content: center;
			gap: 0.6rem;
			padding-block: 0.5rem;
			min-width: 0;
		}
		.wire-svg {
			width: 4rem;
			transform: rotate(90deg);
			height: 24px;
		}
	}
</style>
