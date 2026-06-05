<script lang="ts">
	import { base } from '$app/paths';
	import { page } from '$app/state';

	let scrolled = $state(false);
	let menuOpen = $state(false);
	let theme = $state<'dark' | 'light'>('dark');

	$effect(() => {
		theme = document.documentElement.classList.contains('light') ? 'light' : 'dark';
		const onScroll = () => (scrolled = window.scrollY > 8);
		onScroll();
		window.addEventListener('scroll', onScroll, { passive: true });
		return () => window.removeEventListener('scroll', onScroll);
	});

	function toggleTheme() {
		theme = theme === 'dark' ? 'light' : 'dark';
		const root = document.documentElement;
		root.classList.toggle('dark', theme === 'dark');
		root.classList.toggle('light', theme === 'light');
		root.style.colorScheme = theme;
		try {
			localStorage.setItem('cockpit-theme', theme);
		} catch (e) {
			/* private mode */
		}
	}

	const links = [
		{ href: `${base}/features/`, label: 'Features' },
		{ href: `${base}/architecture/`, label: 'Architecture' },
		{ href: `${base}/#roadmap`, label: 'Roadmap' }
	];

	const repo = 'https://github.com/jsgerman-oss/gascity-cockpit';

	function isActive(href: string): boolean {
		const path = href.replace(base, '').split('#')[0];
		if (path === '/features/' || path === '/architecture/') return page.url.pathname.startsWith(href);
		return false;
	}
</script>

<header class="nav" class:scrolled aria-label="Primary">
	<div class="shell nav-inner">
		<a class="brand" href="{base}/" aria-label="GasCity Cockpit, home">
			<svg class="brand-mark" viewBox="0 0 32 32" aria-hidden="true">
				<rect x="0.5" y="0.5" width="31" height="31" fill="none" stroke="currentColor" stroke-opacity="0.4" />
				<path d="M9 9.5 L15.5 16 L9 22.5" fill="none" stroke="var(--accent)" stroke-width="2.6" stroke-linecap="square" />
				<rect x="17.5" y="20" width="7" height="2.6" fill="var(--accent)" />
			</svg>
			<span class="wordmark">GasCity <span class="wordmark-accent">Cockpit</span></span>
		</a>

		<nav class="links" aria-label="Sections">
			{#each links as link}
				<a href={link.href} class="nav-link" class:active={isActive(link.href)}>{link.label}</a>
			{/each}
		</nav>

		<div class="cta">
			<button class="icon-btn" onclick={toggleTheme} aria-label="Toggle {theme === 'dark' ? 'light' : 'dark'} theme" type="button">
				{#if theme === 'dark'}
					<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" stroke-linecap="round" /></svg>
				{:else}
					<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" stroke-linejoin="round" /></svg>
				{/if}
			</button>
			<a class="ghost-btn" href={repo} target="_blank" rel="noreferrer">
				<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="currentColor"><path d="M12 2A10 10 0 0 0 8.8 21.5c.5.1.7-.2.7-.5v-1.7c-2.8.6-3.4-1.3-3.4-1.3-.5-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.5 2.3 1.1 2.9.8.1-.6.3-1.1.6-1.3-2.2-.300000-4.6-1.1-4.6-4.9 0-1.1.4-2 1-2.7-.1-.3-.4-1.3.1-2.7 0 0 .8-.3 2.7 1a9.4 9.4 0 0 1 5 0c1.9-1.3 2.7-1 2.7-1 .5 1.4.2 2.4.1 2.7.6.7 1 1.6 1 2.7 0 3.8-2.4 4.6-4.6 4.9.3.3.6.9.6 1.8v2.7c0 .3.2.6.7.5A10 10 0 0 0 12 2z" /></svg>
				<span>GitHub</span>
			</a>
			<button class="icon-btn menu-toggle" onclick={() => (menuOpen = !menuOpen)} aria-label="Menu" aria-expanded={menuOpen} type="button">
				<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="square">
					{#if menuOpen}<path d="M5 5l14 14M19 5L5 19" />{:else}<path d="M3 6h18M3 12h18M3 18h18" />{/if}
				</svg>
			</button>
		</div>
	</div>

	<div class="mobile-menu" class:open={menuOpen}>
		{#each links as link}
			<a href={link.href} class="mobile-link" onclick={() => (menuOpen = false)}>{link.label}</a>
		{/each}
		<a class="mobile-link" href={repo} target="_blank" rel="noreferrer">GitHub</a>
	</div>
</header>

<style>
	.nav {
		position: sticky;
		top: 0;
		z-index: var(--z-nav, 40);
		background: color-mix(in oklab, var(--bg) 78%, transparent);
		backdrop-filter: blur(12px) saturate(140%);
		-webkit-backdrop-filter: blur(12px) saturate(140%);
		border-bottom: 1px solid transparent;
		transition: background 200ms var(--ease-out-quart), border-color 200ms ease;
	}
	.nav.scrolled {
		background: color-mix(in oklab, var(--bg) 92%, transparent);
		border-bottom-color: var(--hairline);
	}
	.nav-inner {
		display: flex;
		align-items: center;
		justify-content: space-between;
		height: 4.25rem;
		gap: 1.5rem;
	}
	.brand {
		display: inline-flex;
		align-items: center;
		gap: 0.6rem;
		color: var(--ink);
	}
	.brand-mark {
		width: 26px;
		height: 26px;
		flex: none;
	}
	.wordmark {
		font-weight: 600;
		font-size: 1.0625rem;
		letter-spacing: -0.015em;
	}
	.wordmark-accent {
		color: var(--accent);
	}
	.links {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		margin-left: auto;
		margin-right: 0.5rem;
	}
	.nav-link {
		position: relative;
		padding: 0.55rem 0.9rem;
		font-size: 0.9375rem;
		font-weight: 500;
		color: var(--mute);
		transition: color 140ms ease;
	}
	.nav-link:hover {
		color: var(--ink);
	}
	.nav-link.active {
		color: var(--ink);
	}
	.nav-link.active::after {
		content: '';
		position: absolute;
		left: 0.9rem;
		right: 0.9rem;
		bottom: -1px;
		height: 1px;
		background: var(--accent);
	}
	.cta {
		display: flex;
		align-items: center;
		gap: 0.6rem;
	}
	.icon-btn {
		display: inline-grid;
		place-items: center;
		width: 38px;
		height: 38px;
		border: 1px solid var(--hairline-strong);
		background: transparent;
		color: var(--mute);
		cursor: pointer;
		transition: color 140ms ease, border-color 140ms ease, background 140ms ease;
	}
	.icon-btn:hover {
		color: var(--ink);
		border-color: var(--accent);
		background: var(--lifted);
	}
	.ghost-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0 1rem;
		height: 38px;
		border: 1px solid var(--hairline-strong);
		color: var(--ink);
		font-size: 0.9375rem;
		font-weight: 500;
		transition: border-color 140ms ease, background 140ms ease, transform 140ms ease;
	}
	.ghost-btn:hover {
		border-color: var(--accent);
		background: var(--lifted);
		transform: translateY(-1px);
	}
	.menu-toggle {
		display: none;
	}
	.mobile-menu {
		display: none;
		flex-direction: column;
		overflow: hidden;
		max-height: 0;
		border-top: 1px solid transparent;
		transition: max-height 280ms var(--ease-out-quart);
	}
	.mobile-link {
		padding: 0.9rem clamp(1.25rem, 4vw, 3rem);
		color: var(--mute);
		font-weight: 500;
		border-top: 1px solid var(--hairline);
	}
	.mobile-link:hover {
		color: var(--ink);
		background: var(--surface);
	}
	@media (max-width: 880px) {
		.links {
			display: none;
		}
		.ghost-btn span {
			display: none;
		}
		.ghost-btn {
			padding: 0;
			width: 38px;
			justify-content: center;
		}
		.menu-toggle {
			display: inline-grid;
		}
		.mobile-menu {
			display: flex;
		}
		.mobile-menu.open {
			max-height: 20rem;
			border-top-color: var(--hairline);
		}
	}
</style>
