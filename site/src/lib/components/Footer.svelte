<script lang="ts">
	import { base } from '$app/paths';
	const repo = 'https://github.com/jsgerman-oss/gascity-cockpit';
</script>

<footer class="footer">
	<div class="shell foot-inner">
		<div class="foot-brand">
			<a class="brand" href="{base}/">
				<svg viewBox="0 0 32 32" width="22" height="22" aria-hidden="true">
					<rect x="0.5" y="0.5" width="31" height="31" fill="none" stroke="currentColor" stroke-opacity="0.4" />
					<path d="M9 9.5 L15.5 16 L9 22.5" fill="none" stroke="var(--accent)" stroke-width="2.6" stroke-linecap="square" />
					<rect x="17.5" y="20" width="7" height="2.6" fill="var(--accent)" />
				</svg>
				<span>GasCity <span class="accent">Cockpit</span></span>
			</a>
			<p class="foot-tag">An editor-native cockpit for fleets of coding agents. A client of the gascity <code>/v0</code> API.</p>
		</div>
		<nav class="foot-cols" aria-label="Footer">
			<div class="col">
				<span class="col-head">Product</span>
				<a href="{base}/features/">Features</a>
				<a href="{base}/architecture/">Architecture</a>
				<a href="{base}/#roadmap">Roadmap</a>
			</div>
			<div class="col">
				<span class="col-head">Source</span>
				<a href={repo} target="_blank" rel="noreferrer">Extension repo</a>
				<a href="https://github.com/gastownhall/gascity" target="_blank" rel="noreferrer">Gas City engine</a>
				<a href="{repo}/issues" target="_blank" rel="noreferrer">File an issue</a>
			</div>
		</nav>
	</div>
	<div class="shell foot-base">
		<span>Built on <a href="https://github.com/gastownhall/gascity" target="_blank" rel="noreferrer">Gas City</a>.</span>
		<span class="dim">MIT licensed · alpha</span>
	</div>
</footer>

<style>
	.footer {
		border-top: 1px solid var(--hairline);
		background: var(--surface);
		margin-top: clamp(4rem, 10vw, 8rem);
	}
	.foot-inner {
		display: grid;
		grid-template-columns: 1.4fr 1fr;
		gap: clamp(2rem, 6vw, 5rem);
		padding-block: clamp(3rem, 6vw, 4.5rem) 2.5rem;
	}
	.brand {
		display: inline-flex;
		align-items: center;
		gap: 0.55rem;
		color: var(--ink);
		font-weight: 600;
		font-size: 1.0625rem;
		letter-spacing: -0.015em;
	}
	.brand .accent { color: var(--accent); }
	.foot-tag {
		margin-top: 1rem;
		max-width: 38ch;
		color: var(--mute);
		font-size: 0.9375rem;
	}
	.foot-tag code {
		font-family: var(--font-mono);
		font-size: 0.85em;
		color: var(--ink);
	}
	.foot-cols {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 2rem;
	}
	.col {
		display: flex;
		flex-direction: column;
		gap: 0.7rem;
	}
	.col-head {
		font-family: var(--font-mono);
		font-size: 0.75rem;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--caption);
		margin-bottom: 0.2rem;
	}
	.col a {
		color: var(--mute);
		font-size: 0.9375rem;
		width: fit-content;
		transition: color 140ms ease;
	}
	.col a:hover { color: var(--accent); }
	.foot-base {
		display: flex;
		align-items: center;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: 0.5rem;
		padding-block: 1.5rem;
		border-top: 1px solid var(--hairline);
		font-size: 0.875rem;
		color: var(--mute);
	}
	.foot-base a { color: var(--accent); }
	.foot-base .dim { color: var(--caption); font-family: var(--font-mono); font-size: 0.8125rem; }
	@media (max-width: 720px) {
		.foot-inner { grid-template-columns: 1fr; gap: 2.5rem; }
	}
</style>
