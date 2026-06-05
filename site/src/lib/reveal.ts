/**
 * Scroll-into-view reveal, used sparingly (legit list rhythm + one earned moment).
 *
 * Safety: the "from" state is applied by JS only, so server-rendered / no-JS /
 * reduced-motion output is always visible. A fallback timer fires the reveal even
 * if the observer never does (hidden tabs, headless renderers), so nothing ships
 * blank. Cleans up inline styles afterward so component :hover transitions resume.
 */
type RevealOpts = { stagger?: number; y?: number };

export function reveal(node: HTMLElement, opts: RevealOpts = {}) {
	const reduce =
		typeof window !== 'undefined' &&
		window.matchMedia('(prefers-reduced-motion: reduce)').matches;
	if (reduce || typeof IntersectionObserver === 'undefined') return;

	const { stagger = 0, y = 16 } = opts;
	const targets: HTMLElement[] = stagger
		? (Array.from(node.children) as HTMLElement[])
		: [node];

	for (const [i, el] of targets.entries()) {
		el.style.opacity = '0';
		el.style.transform = `translateY(${y}px)`;
		el.style.transition = `opacity 0.6s var(--ease-out-quart) ${i * stagger}ms, transform 0.6s var(--ease-out-quart) ${i * stagger}ms`;
		el.style.willChange = 'opacity, transform';
	}

	let fired = false;
	const fire = () => {
		if (fired) return;
		fired = true;
		for (const el of targets) {
			el.style.opacity = '';
			el.style.transform = '';
		}
		const settle = 700 + targets.length * stagger;
		window.setTimeout(() => {
			for (const el of targets) {
				el.style.transition = '';
				el.style.willChange = '';
			}
		}, settle);
	};

	const io = new IntersectionObserver(
		(entries) => {
			for (const e of entries) {
				if (e.isIntersecting) {
					fire();
					io.disconnect();
					break;
				}
			}
		},
		{ threshold: 0.15, rootMargin: '0px 0px -10% 0px' }
	);
	io.observe(node);

	const fallback = window.setTimeout(fire, 1600);

	return {
		destroy() {
			io.disconnect();
			window.clearTimeout(fallback);
		}
	};
}
