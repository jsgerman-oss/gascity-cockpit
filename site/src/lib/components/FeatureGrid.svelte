<script lang="ts">
	import type { Feature } from '$lib/features';
	let { items, start = 1 }: { items: Feature[]; start?: number } = $props();
</script>

<div class="fgrid">
	{#each items as f, i}
		<article class="cell">
			<span class="idx">{String(start + i).padStart(2, '0')}</span>
			<h3 class="fname">{f.name}</h3>
			<p class="fblurb">{f.blurb}</p>
			<span class="fmod">{f.module}</span>
		</article>
	{/each}
</div>

<style>
	.fgrid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(17.5rem, 1fr));
		border-top: 1px solid var(--hairline);
		border-left: 1px solid var(--hairline);
	}
	.cell {
		background: var(--bg);
		border-right: 1px solid var(--hairline);
		border-bottom: 1px solid var(--hairline);
		padding: 1.6rem 1.6rem 1.4rem;
		display: flex;
		flex-direction: column;
		gap: 0.55rem;
		position: relative;
		transition: background 160ms ease;
	}
	.cell::before {
		content: '';
		position: absolute;
		left: 0;
		top: 0;
		width: 0;
		height: 2px;
		background: var(--accent);
		transition: width 200ms var(--ease-out-quart);
	}
	.cell:hover {
		background: var(--surface);
	}
	.cell:hover::before {
		width: 2.2rem;
	}
	.idx {
		font-family: var(--font-mono);
		font-size: 0.75rem;
		letter-spacing: 0.1em;
		color: var(--caption);
	}
	.fname {
		font-size: 1.0625rem;
		font-weight: 600;
		color: var(--ink);
		letter-spacing: -0.01em;
	}
	.fblurb {
		font-size: 0.9rem;
		line-height: 1.5;
		color: var(--mute);
		max-width: 42ch;
		flex: 1;
	}
	.fmod {
		margin-top: 0.4rem;
		font-family: var(--font-mono);
		font-size: 0.75rem;
		color: var(--accent);
	}
</style>
