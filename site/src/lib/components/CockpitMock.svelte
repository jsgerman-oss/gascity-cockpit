<script lang="ts">
	// The signature artifact: a faux-but-faithful VS Code window running the Cockpit.
	// Real bead IDs, real agent names, real /v0 surfaces — the surface is the proof.
	const beads = [
		{ id: 'cockpit-21l', label: 'Expansion', glyph: '▾', kind: 'epic', indent: 0 },
		{ id: 'cockpit-21l.3', label: 'cost & tier telemetry', glyph: '✓', kind: 'closed', indent: 1 },
		{ id: 'cockpit-21l.5', label: 'live town topology', glyph: '✓', kind: 'closed', indent: 1 },
		{ id: 'cockpit-1ll.19', label: 'state consistency', glyph: '◐', kind: 'wip', indent: 1 },
		{ id: 'cockpit-1ll', label: 'GasCity Cockpit', glyph: '▾', kind: 'epic', indent: 0 },
		{ id: 'cockpit-1ll.15', label: 'feature registry', glyph: '✓', kind: 'closed', indent: 1 }
	];

	const agents = [
		{ name: 'mayor', role: 'coordinator', state: 'active' },
		{ name: 'refinery', role: 'merge queue', state: 'active' },
		{ name: 'witness', role: 'health', state: 'active' },
		{ name: 'polecat ×5', role: 'pool', state: 'idle' }
	];
</script>

<div class="window" role="img" aria-label="The GasCity Cockpit running in VS Code: a Beads explorer tree, a live Fleet status pane, and a Mayor chat prompt.">
	<div class="titlebar">
		<span class="lights" aria-hidden="true">
			<i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i>
		</span>
		<span class="title">gascity-cockpit <span class="dim">— Cockpit</span></span>
		<span class="pulse" aria-hidden="true"></span>
	</div>

	<div class="body">
		<div class="rail" aria-hidden="true">
			<span class="rail-ico active">▤</span>
			<span class="rail-ico">◉</span>
			<span class="rail-ico">⚑</span>
			<span class="rail-ico">⎇</span>
		</div>

		<div class="sidebar">
			<div class="pane-head">Beads Explorer</div>
			<ul class="tree">
				{#each beads as b, i}
					<li class="row" style="padding-left: {0.5 + b.indent * 1}rem; --i: {i}">
						<span class="glyph {b.kind}">{b.glyph}</span>
						<span class="bid">{b.id}</span>
						<span class="blabel">{b.label}</span>
					</li>
				{/each}
			</ul>
		</div>

		<div class="main">
			<div class="pane-head">
				Fleet <span class="dim">· blackrim-hq</span>
			</div>
			<ul class="fleet">
				{#each agents as a, i}
					<li class="agent" style="--i: {i}">
						<span class="dot {a.state}" aria-hidden="true"></span>
						<span class="aname">{a.name}</span>
						<span class="arole">{a.role}</span>
						<span class="astate {a.state}">{a.state}</span>
					</li>
				{/each}
			</ul>
			<div class="event">
				<span class="evt-time">07:21:55</span>
				<span class="evt-tag merged">merged</span>
				<span class="evt-txt">cockpit-21l.6 · event time-travel</span>
			</div>
			<div class="chat">
				<span class="prompt">&gt;</span>
				<span class="chat-txt">ask the mayor</span><span class="caret" aria-hidden="true"></span>
			</div>
		</div>
	</div>

	<div class="statusbar">
		<span class="st"><span class="st-ico">⎇</span> main</span>
		<span class="st ok"><span class="st-ico">✓</span> 416 tests</span>
		<span class="st spacer"></span>
		<span class="st live"><span class="live-dot" aria-hidden="true"></span> /v0 connected</span>
	</div>
</div>

<style>
	.window {
		--frame: var(--hairline-strong);
		font-family: var(--font-mono);
		font-size: 12.5px;
		line-height: 1.5;
		background: var(--surface);
		border: 1px solid var(--frame);
		box-shadow: 0 0 0 1px var(--halo-ring), 0 24px 80px -20px rgba(0, 0, 0, 0.6);
		width: 100%;
		max-width: 36rem;
		user-select: none;
	}
	.titlebar {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.6rem 0.85rem;
		border-bottom: 1px solid var(--hairline);
		background: var(--bg);
	}
	.lights {
		display: inline-flex;
		gap: 0.45rem;
	}
	.lights i {
		width: 11px;
		height: 11px;
		border-radius: 50%;
		display: block;
	}
	.title {
		color: var(--mute);
		font-size: 12px;
		letter-spacing: 0.01em;
	}
	.title .dim {
		color: var(--caption);
	}
	.pulse {
		margin-left: auto;
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--signal-green);
		box-shadow: 0 0 10px var(--signal-green);
		animation: pulse 2.4s ease-in-out infinite;
	}
	@keyframes pulse {
		0%, 100% { opacity: 0.45; }
		50% { opacity: 1; }
	}
	.body {
		display: grid;
		grid-template-columns: 2.6rem 13rem 1fr;
		min-height: 16.5rem;
	}
	.rail {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 1.1rem;
		padding: 0.9rem 0;
		border-right: 1px solid var(--hairline);
		background: var(--bg);
		color: var(--caption);
		font-size: 15px;
	}
	.rail-ico.active {
		color: var(--accent);
		box-shadow: inset 2px 0 0 var(--accent);
		width: 100%;
		text-align: center;
	}
	.sidebar {
		border-right: 1px solid var(--hairline);
		padding-bottom: 0.5rem;
		overflow: hidden;
	}
	.pane-head {
		font-size: 10.5px;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--caption);
		padding: 0.7rem 0.85rem;
		border-bottom: 1px solid var(--hairline);
	}
	.pane-head .dim {
		color: var(--caption);
		opacity: 0.7;
	}
	.tree {
		list-style: none;
		padding: 0.4rem 0;
		margin: 0;
	}
	.row {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		padding-block: 0.18rem;
		padding-right: 0.6rem;
		white-space: nowrap;
	}
	.glyph {
		width: 0.9rem;
		text-align: center;
		flex: none;
	}
	.glyph.epic { color: var(--mute); }
	.glyph.closed { color: var(--caption); }
	.glyph.wip { color: var(--accent); }
	.bid {
		color: var(--mute);
		font-size: 11.5px;
	}
	.blabel {
		color: var(--caption);
		font-size: 11.5px;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.main {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	.fleet {
		list-style: none;
		margin: 0;
		padding: 0.5rem 0.85rem;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.agent {
		display: flex;
		align-items: center;
		gap: 0.6rem;
	}
	.dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		flex: none;
	}
	.dot.active { background: var(--signal-green); box-shadow: 0 0 8px color-mix(in oklab, var(--signal-green) 60%, transparent); }
	.dot.idle { background: var(--caption); }
	.aname { color: var(--ink); }
	.arole {
		color: var(--caption);
		margin-left: 0.1rem;
	}
	.astate {
		margin-left: auto;
		font-size: 10.5px;
		letter-spacing: 0.1em;
		text-transform: uppercase;
	}
	.astate.active { color: var(--signal-green); }
	.astate.idle { color: var(--caption); }
	.event {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin: 0.2rem 0.85rem 0;
		padding-top: 0.6rem;
		border-top: 1px solid var(--hairline);
		font-size: 11.5px;
	}
	.evt-time { color: var(--caption); }
	.evt-tag.merged {
		color: var(--accent);
		border: 1px solid color-mix(in oklab, var(--accent) 40%, transparent);
		padding: 1px 6px;
		font-size: 10px;
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}
	.evt-txt { color: var(--mute); }
	.chat {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin: auto 0.85rem 0.85rem;
		padding: 0.6rem 0.7rem;
		border: 1px solid var(--hairline-strong);
		background: var(--bg);
	}
	.prompt { color: var(--accent); font-weight: 600; }
	.chat-txt { color: var(--caption); }
	.caret {
		width: 7px;
		height: 1.05em;
		background: var(--accent);
		margin-left: -0.3rem;
		animation: blink 1.1s steps(1) infinite;
	}
	@keyframes blink {
		0%, 50% { opacity: 1; }
		50.01%, 100% { opacity: 0; }
	}
	.statusbar {
		display: flex;
		align-items: center;
		gap: 1rem;
		padding: 0.4rem 0.85rem;
		border-top: 1px solid var(--hairline);
		background: var(--bg);
		font-size: 11px;
		color: var(--caption);
	}
	.st { display: inline-flex; align-items: center; gap: 0.35rem; }
	.st-ico { color: var(--caption); }
	.st.ok .st-ico { color: var(--signal-green); }
	.st.spacer { margin-left: auto; }
	.st.live { color: var(--mute); }
	.live-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--accent);
		box-shadow: 0 0 8px var(--accent);
	}
	/* Boot sequence: the panes populate in order, like the instrument coming up. */
	@keyframes boot {
		from {
			opacity: 0;
			transform: translateY(7px);
		}
		to {
			opacity: 1;
			transform: none;
		}
	}
	.pane-head {
		animation: boot 0.5s var(--ease-out-quart) both 0.35s;
	}
	.row {
		animation: boot 0.5s var(--ease-out-quart) both;
		animation-delay: calc(0.5s + var(--i, 0) * 0.045s);
	}
	.agent {
		animation: boot 0.5s var(--ease-out-quart) both;
		animation-delay: calc(0.8s + var(--i, 0) * 0.07s);
	}
	.event {
		animation: boot 0.5s var(--ease-out-quart) both 1s;
	}
	.chat {
		animation: boot 0.55s var(--ease-out-quart) both 1.1s;
	}

	@media (prefers-reduced-motion: reduce) {
		.pulse,
		.caret,
		.pane-head,
		.row,
		.agent,
		.event,
		.chat {
			animation: none;
		}
		.caret {
			opacity: 1;
		}
	}
	@media (max-width: 420px) {
		.body { grid-template-columns: 2.2rem 10.5rem 1fr; }
		.arole { display: none; }
	}
</style>
