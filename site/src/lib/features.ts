export type Feature = {
	name: string;
	blurb: string;
	module: string;
};

export const essentials: Feature[] = [
	{
		name: 'Beads explorer',
		blurb: 'A multi-city tree of every work item with rich status, filter and group, full detail, and rendered dependency graphs.',
		module: 'src/beads'
	},
	{
		name: 'Live status panes',
		blurb: 'City health, agents, and sessions plus a real-time event feed over SSE, with a Fleet view that moves as agents work.',
		module: 'src/status'
	},
	{
		name: 'Chat with the Mayor',
		blurb: 'A structured conversation panel over the session transcript / submit / stream API, including interrupting the loop.',
		module: 'src/chat'
	},
	{
		name: 'Bead authoring',
		blurb: 'Create, update, assign, edit dependencies, and dispatch beads to a polecat pool, all without leaving the editor.',
		module: 'src/beads'
	},
	{
		name: 'Tool-approval cockpit',
		blurb: 'Surface pending tool-approvals and input prompts across every session, answer them inline, and set permission mode.',
		module: 'src/chat'
	},
	{
		name: 'Dashboard projection',
		blurb: 'Embed the gascity dashboard as a Cockpit tab through a real webview contract: CSP, theme sync, deep-link, bridge.',
		module: 'src/dashboard'
	},
	{
		name: 'Code & worktree nav',
		blurb: 'Jump from a bead to its polecat worktree and the diff for the work in flight, and run formulas while watching them.',
		module: 'src/code'
	},
	{
		name: 'Conversation participant',
		blurb: 'The editor registers as a durable extmsg participant, so agents can address VS Code through the town’s own fabric.',
		module: 'src/extmsg'
	},
	{
		name: 'Typed /v0 foundation',
		blurb: 'An OpenAPI-generated, version-pinned /v0 client plus a discovery and resilience layer that survives supervisor restarts and gc stop.',
		module: 'src/api · src/discovery'
	}
];

export const powerTools: Feature[] = [
	{
		name: 'Fleet command palette',
		blurb: 'Plain-language queries (e.g. show failing beads in cockpit) resolved into structured /v0 queries across every city.',
		module: 'src/fleet'
	},
	{
		name: 'In-editor merge-queue review',
		blurb: 'Surface refinery PRs with their diff and approve or merge in one click, closing the bead → polecat → merge loop.',
		module: 'src/mergeQueue'
	},
	{
		name: 'Cost & tier telemetry',
		blurb: 'Model-advisor tier decisions and token-budget spend, visualized per agent and per bead.',
		module: 'src/telemetry'
	},
	{
		name: 'File a bead from a selection',
		blurb: 'Right-click any code selection to open a new bead with file:line context auto-attached.',
		module: 'src/features'
	},
	{
		name: 'Live town topology',
		blurb: 'An SSE-driven graph of controller → mayor → rigs → polecats / witness / refinery, color-coded by health.',
		module: 'src/town'
	},
	{
		name: 'Event time-travel',
		blurb: 'Scrub and replay the event feed to reconstruct exactly what the agents did, for debugging and audit.',
		module: 'src/timetravel'
	},
	{
		name: 'Native notifications',
		blurb: 'VS Code toasts for escalations, tool-approvals, and mail, so nothing waits unseen in a background pane.',
		module: 'src/notifications'
	},
	{
		name: 'Worktree code lens',
		blurb: 'Files annotated inline with the bead and polecat touching them right now.',
		module: 'src/features'
	},
	{
		name: 'Companion surfaces',
		blurb: 'A spike: groundwork and portability guarantees for a future web or mobile companion on the shared typed client.',
		module: 'spike'
	}
];
