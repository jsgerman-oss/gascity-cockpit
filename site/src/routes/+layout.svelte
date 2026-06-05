<script lang="ts">
	import '../app.css';
	import '@fontsource-variable/inter';
	import '@fontsource-variable/jetbrains-mono';
	import Nav from '$lib/components/Nav.svelte';
	import Footer from '$lib/components/Footer.svelte';
	let { children } = $props();
</script>

<a class="skip" href="#main">Skip to content</a>
<Nav />
<main id="main">{@render children()}</main>
<Footer />

<style>
	.skip {
		position: fixed;
		top: 0.5rem;
		left: 0.5rem;
		z-index: 100;
		padding: 0.5rem 1rem;
		background: var(--accent);
		color: var(--bg);
		font-weight: 600;
		transform: translateY(-150%);
		transition: transform 150ms ease;
	}
	.skip:focus {
		transform: translateY(0);
	}
</style>
