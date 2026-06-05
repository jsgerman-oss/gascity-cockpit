<script lang="ts">
	import { base } from '$app/paths';
	const repo = 'https://github.com/jsgerman-oss/gascity-cockpit';
</script>

<section class="cta-section">
	<div class="field" aria-hidden="true"></div>
	<div class="shell cta-inner">
		<p class="eyebrow">Get started</p>
		<h2 class="cta-title">Run the whole town<br />from where you read the code.</h2>
		<p class="cta-sub">
			Clone it, point it at a running supervisor, press F5. It auto-discovers the API and the panes
			come up live.
		</p>
		<div class="cta-row">
			<a class="btn-primary" href={repo} target="_blank" rel="noreferrer">
				Get it on GitHub
				<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M5 12h14M13 6l6 6-6 6" stroke-linecap="square" /></svg>
			</a>
			<a class="btn-ghost" href="{base}/architecture/">How it works</a>
		</div>
		<p class="cta-meta">alpha · MIT · a client of the gascity <code>/v0</code> API</p>
	</div>
</section>

<style>
	.cta-section {
		position: relative;
		overflow: hidden;
		border-top: 1px solid var(--hairline);
		background: var(--surface);
		padding-block: clamp(4.5rem, 9vw, 7.5rem);
	}
	.field {
		position: absolute;
		inset: 0;
		background-image:
			linear-gradient(var(--grid-line) 1px, transparent 1px),
			linear-gradient(90deg, var(--grid-line) 1px, transparent 1px);
		background-size: 64px 64px;
		mask-image: radial-gradient(80% 120% at 50% 100%, #000 0%, transparent 70%);
		-webkit-mask-image: radial-gradient(80% 120% at 50% 100%, #000 0%, transparent 70%);
	}
	.field::after {
		content: '';
		position: absolute;
		bottom: -40%;
		left: 50%;
		transform: translateX(-50%);
		width: 55rem;
		height: 40rem;
		background: radial-gradient(circle, var(--glow) 0%, transparent 60%);
	}
	.cta-inner {
		position: relative;
		text-align: center;
		display: flex;
		flex-direction: column;
		align-items: center;
	}
	.cta-title {
		font-size: var(--text-headline);
		margin-top: 1.1rem;
		letter-spacing: -0.025em;
		max-width: 22ch;
	}
	.cta-sub {
		margin-top: 1.5rem;
		max-width: 50ch;
		font-size: var(--text-lead);
		line-height: 1.45;
		color: var(--mute);
	}
	.cta-row {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: 1rem;
		margin-top: 2.5rem;
	}
	.btn-primary {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.9rem 1.6rem;
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
		padding: 0.9rem 1.6rem;
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
	.cta-meta {
		margin-top: 2.5rem;
		font-family: var(--font-mono);
		font-size: 0.8125rem;
		color: var(--caption);
	}
	.cta-meta code {
		color: var(--accent);
	}
</style>
