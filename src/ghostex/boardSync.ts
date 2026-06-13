/**
 * Two-way reconciliation engine between gas-city work beads and a Ghostex
 * project board (the issues `runBeadsAction({ action: "board" })` surfaces).
 *
 * This is the D3(d) "two-way" fork from the integration decisions doc: a stable
 * per-item ID linkage, a per-field conflict policy (source-of-truth or
 * last-writer), and an *idempotent* reconcile pass. Like the rest of
 * `src/ghostex/`, the engine is `vscode`-free and pure at its core, so it is
 * unit-testable in plain Node (PRD "Seam 1").
 *
 * Shape — a functional core wrapped in an imperative shell:
 *   - {@link planReconcile} is pure: given two snapshots it computes the set of
 *     {@link ReconcileAction}s that would converge them. This *is* the dry run.
 *   - {@link applyPlan} executes a plan against the two injected ports
 *     ({@link BeadsSide}, {@link BoardSide}), collecting per-action outcomes and
 *     continuing past individual failures.
 *   - {@link reconcile} wires list → plan → (apply unless `dryRun`) → report.
 *
 * The status-vocabulary mapping is injected ({@link BoardStatusMapping}). The
 * dedicated status-reconciliation module owns the authoritative table;
 * {@link defaultBoardStatusMapping} here implements the decisions-doc defaults so
 * the engine is usable and testable standalone.
 *
 * Idempotency is the load-bearing invariant: a second reconcile with no external
 * change must produce zero actions. Two design choices guarantee it — field
 * comparison is by *value* (not timestamp), and status is compared through the
 * mapping in *both* directions, so the lossy parts of the vocabulary
 * (`review`/`test`/`backlog`, `blocked`/`deferred`) never thrash.
 */

import type { Bead } from '../beads/types.ts';
import type { GhostexBoardItem } from './types.ts';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

// ---- Status vocabulary mapping ---------------------------------------------

/**
 * Translates between the Ghostex board vocabulary
 * (`backlog/open/in_progress/review/test/closed`) and the gas-city bead
 * vocabulary (`open/in_progress/blocked/closed/deferred`). Injected so the
 * dedicated status-vocabulary module can supply the authoritative table.
 */
export interface BoardStatusMapping {
  /** Ghostex board status → gas-city bead status. */
  boardToBead(boardStatus: string | undefined): string;
  /** Gas-city bead status → Ghostex board status. */
  beadToBoard(beadStatus: string | undefined): string;
}

const BOARD_TO_BEAD = new Map<string, string>([
  ['backlog', 'open'],
  ['open', 'open'],
  ['in_progress', 'in_progress'],
  ['review', 'in_progress'],
  ['test', 'in_progress'],
  ['closed', 'closed'],
]);

const BEAD_TO_BOARD = new Map<string, string>([
  ['open', 'open'],
  ['in_progress', 'in_progress'],
  ['blocked', 'in_progress'],
  ['closed', 'closed'],
  ['deferred', 'backlog'],
]);

/**
 * The recommended default mapping from the integration decisions doc:
 * `backlog→open`, `review→in_progress`, `test→in_progress`; the reverse keeps
 * the coarser gas-city statuses (`blocked→in_progress`, `deferred→backlog`). An
 * unrecognised or absent status falls back to `open`, so a novel value never
 * blocks a reconcile. Round-trip fidelity (restoring `review`/`test`) is the
 * engine's job — it preserves the original board status in bead metadata.
 */
export const defaultBoardStatusMapping: BoardStatusMapping = {
  boardToBead: (s) => (s !== undefined ? (BOARD_TO_BEAD.get(s) ?? 'open') : 'open'),
  beadToBoard: (s) => (s !== undefined ? (BEAD_TO_BOARD.get(s) ?? 'open') : 'open'),
};

// ---- Linkage + conflict policy ---------------------------------------------

/** Metadata keys used to record the stable cross-side ID linkage. */
export interface LinkKeys {
  /** Bead metadata key holding the linked Ghostex board-item id. */
  readonly boardItemId: string;
  /** Bead metadata key preserving the original board status (for round-trips). */
  readonly boardStatus: string;
  /** Board-item metadata key holding the linked gas-city bead id. */
  readonly beadId: string;
}

export const DEFAULT_LINK_KEYS: LinkKeys = {
  boardItemId: 'ghostex.board_item_id',
  boardStatus: 'ghostex.board_status',
  beadId: 'gascity.bead_id',
};

/** Which side a value is taken from. */
export type SyncSide = 'beads' | 'board';

/**
 * How a per-field divergence is resolved: pin a side as the source of truth, or
 * let the more recently updated side win (`lastWriter`).
 */
export type FieldAuthority = SyncSide | 'lastWriter';

/** Per-field conflict policy for a linked bead ⇄ board-item pair. */
export interface ConflictPolicy {
  readonly title: FieldAuthority;
  readonly status: FieldAuthority;
}

export const DEFAULT_CONFLICT_POLICY: ConflictPolicy = {
  title: 'lastWriter',
  status: 'lastWriter',
};

// ---- Ports (the two sides) -------------------------------------------------

/** Fields needed to create a gas-city bead mirroring a board item. */
export interface BeadCreateInput {
  readonly title: string;
  readonly status: string;
  readonly metadata: Record<string, string>;
}

/** A sparse patch to a gas-city bead. `metadata` keys are set/merged, not replaced. */
export interface BeadPatch {
  readonly title?: string;
  readonly status?: string;
  readonly metadata?: Record<string, string>;
}

/** Fields needed to create a Ghostex board item mirroring a bead. */
export interface BoardItemCreateInput {
  readonly title: string;
  readonly status: string;
  readonly metadata: Record<string, string>;
  readonly projectId?: string;
}

/** A sparse patch to a board item. `metadata` keys are set/merged, not replaced. */
export interface BoardItemPatch {
  readonly title?: string;
  readonly status?: string;
  readonly metadata?: Record<string, string>;
}

/** The gas-city beads side of the sync (read + write). Injected; tests fake it. */
export interface BeadsSide {
  list(): Promise<readonly Bead[]>;
  create(input: BeadCreateInput): Promise<Bead>;
  update(id: string, patch: BeadPatch): Promise<Bead>;
}

/** The Ghostex board side of the sync (read + write). Injected; tests fake it. */
export interface BoardSide {
  list(): Promise<readonly GhostexBoardItem[]>;
  create(input: BoardItemCreateInput): Promise<GhostexBoardItem>;
  update(id: string, patch: BoardItemPatch): Promise<GhostexBoardItem>;
}

// ---- Plan model ------------------------------------------------------------

/** The field(s) an action touches, for the report and for assertions. */
export type ReconcileField = 'title' | 'status' | 'link';

interface BaseAction {
  /** Which fields this action changes. */
  readonly fields: readonly ReconcileField[];
  /** Human-readable rationale, surfaced in {@link formatReport}. */
  readonly reason: string;
}

/** Mirror an unlinked bead onto the board (then back-link the bead). */
export interface CreateBoardAction extends BaseAction {
  readonly type: 'create-board';
  readonly beadId: string;
  readonly boardCreate: BoardItemCreateInput;
}

/** Mirror an unlinked board item into gas-city (then back-link the item). */
export interface CreateBeadAction extends BaseAction {
  readonly type: 'create-bead';
  readonly boardItemId: string;
  readonly beadCreate: BeadCreateInput;
}

/** Patch a linked bead toward its board counterpart. */
export interface UpdateBeadAction extends BaseAction {
  readonly type: 'update-bead';
  readonly beadId: string;
  readonly boardItemId: string;
  readonly beadPatch: BeadPatch;
}

/** Patch a linked board item toward its bead counterpart. */
export interface UpdateBoardAction extends BaseAction {
  readonly type: 'update-board';
  readonly beadId: string;
  readonly boardItemId: string;
  readonly boardPatch: BoardItemPatch;
}

export type ReconcileAction =
  | CreateBoardAction
  | CreateBeadAction
  | UpdateBeadAction
  | UpdateBoardAction;

/** The pure output of {@link planReconcile} — the dry-run result. */
export interface ReconcilePlan {
  readonly actions: readonly ReconcileAction[];
  /** Linked pairs that were already consistent (produced no action). */
  readonly inSync: number;
  /** Total linked pairs considered. */
  readonly pairs: number;
}

/** Options shared by {@link planReconcile} and {@link reconcile}. */
export interface ReconcileOptions {
  readonly mapping?: BoardStatusMapping;
  readonly policy?: ConflictPolicy;
  readonly linkKeys?: LinkKeys;
  readonly dryRun?: boolean;
  /** Side that wins when last-writer-wins cannot be decided from timestamps. */
  readonly defaultWinner?: SyncSide;
  /** Ghostex project id stamped onto board-item creates. */
  readonly projectId?: string;
  /** Clock for the report's `generatedAt`. Injectable for deterministic tests. */
  readonly now?: () => Date;
}

// ---- Planner (pure) --------------------------------------------------------

/**
 * Compute the actions needed to converge a snapshot of gas-city beads with a
 * snapshot of Ghostex board items. Pure and side-effect-free: this is exactly
 * what a dry run reports, and what {@link applyPlan} later executes.
 */
export function planReconcile(
  beads: readonly Bead[],
  boardItems: readonly GhostexBoardItem[],
  options: ReconcileOptions = {},
): ReconcilePlan {
  const mapping = options.mapping ?? defaultBoardStatusMapping;
  const policy = options.policy ?? DEFAULT_CONFLICT_POLICY;
  const keys = options.linkKeys ?? DEFAULT_LINK_KEYS;
  const defaultWinner = options.defaultWinner ?? 'beads';

  const boardById = new Map(boardItems.map((it) => [it.id, it] as const));
  const beadById = new Map(beads.map((b) => [b.id, b] as const));
  const boardByLinkedBead = new Map<string, GhostexBoardItem>();
  for (const it of boardItems) {
    const link = readBoardLink(it, keys.beadId);
    if (link) boardByLinkedBead.set(link, it);
  }

  const actions: ReconcileAction[] = [];
  const matchedBoardIds = new Set<string>();
  let pairs = 0;
  let inSync = 0;

  for (const bead of beads) {
    const item = matchBoardItem(bead, boardById, boardByLinkedBead, keys);
    if (!item) {
      actions.push(createBoardAction(bead, mapping, keys, options.projectId));
      continue;
    }
    matchedBoardIds.add(item.id);
    pairs += 1;
    const pairActions = reconcilePair(bead, item, { mapping, policy, keys, defaultWinner });
    if (pairActions.length === 0) inSync += 1;
    else actions.push(...pairActions);
  }

  for (const item of boardItems) {
    if (matchedBoardIds.has(item.id)) continue;
    // A board item linking to a bead that exists was already handled in the
    // beads loop (the bead matched some item); skip it rather than duplicate.
    const linkedBeadId = readBoardLink(item, keys.beadId);
    if (linkedBeadId && beadById.has(linkedBeadId)) continue;
    actions.push(createBeadAction(item, mapping, keys));
  }

  return { actions, inSync, pairs };
}

/** Resolve a bead's board counterpart: forward link first, then a back-link. */
function matchBoardItem(
  bead: Bead,
  boardById: ReadonlyMap<string, GhostexBoardItem>,
  boardByLinkedBead: ReadonlyMap<string, GhostexBoardItem>,
  keys: LinkKeys,
): GhostexBoardItem | undefined {
  const forward = bead.metadata?.[keys.boardItemId];
  if (forward) {
    const item = boardById.get(forward);
    if (item) return item;
  }
  return boardByLinkedBead.get(bead.id);
}

interface PairContext {
  readonly mapping: BoardStatusMapping;
  readonly policy: ConflictPolicy;
  readonly keys: LinkKeys;
  readonly defaultWinner: SyncSide;
}

/** Diff one linked pair into 0–2 update actions (at most one per side). */
function reconcilePair(bead: Bead, item: GhostexBoardItem, ctx: PairContext): ReconcileAction[] {
  const beadPatch: Mutable<BeadPatch> = {};
  const boardPatch: Mutable<BoardItemPatch> = {};
  const beadMeta: Record<string, string> = {};
  const boardMeta: Record<string, string> = {};
  const beadFields: ReconcileField[] = [];
  const boardFields: ReconcileField[] = [];

  // 1) Linkage — ensure each side records its counterpart's id.
  if (bead.metadata?.[ctx.keys.boardItemId] !== item.id) {
    beadMeta[ctx.keys.boardItemId] = item.id;
    beadFields.push('link');
  }
  if (readBoardLink(item, ctx.keys.beadId) !== bead.id) {
    boardMeta[ctx.keys.beadId] = bead.id;
    boardFields.push('link');
  }

  // 2) Title — plain value compare.
  if (bead.title !== item.title) {
    if (decideWinner(ctx.policy.title, bead, item, ctx.defaultWinner) === 'beads') {
      boardPatch.title = bead.title;
      boardFields.push('title');
    } else {
      beadPatch.title = item.title;
      beadFields.push('title');
    }
  }

  // 3) Status — compared through the mapping in both directions, so the lossy
  // parts of the vocabulary never thrash (idempotency).
  if (!statusInSync(bead, item, ctx.mapping)) {
    if (decideWinner(ctx.policy.status, bead, item, ctx.defaultWinner) === 'beads') {
      boardPatch.status = beadStatusToBoard(bead, ctx.mapping, ctx.keys);
      boardFields.push('status');
    } else {
      beadPatch.status = ctx.mapping.boardToBead(item.status);
      // Preserve the original board status so review/test round-trip faithfully.
      if (item.status !== undefined) beadMeta[ctx.keys.boardStatus] = item.status;
      beadFields.push('status');
    }
  }

  const actions: ReconcileAction[] = [];
  if (Object.keys(beadMeta).length > 0) beadPatch.metadata = beadMeta;
  if (Object.keys(boardMeta).length > 0) boardPatch.metadata = boardMeta;
  if (beadFields.length > 0) {
    actions.push({
      type: 'update-bead',
      fields: beadFields,
      reason: `bead ${bead.id} ← board ${item.id} (${beadFields.join('+')})`,
      beadId: bead.id,
      boardItemId: item.id,
      beadPatch,
    });
  }
  if (boardFields.length > 0) {
    actions.push({
      type: 'update-board',
      fields: boardFields,
      reason: `board ${item.id} ← bead ${bead.id} (${boardFields.join('+')})`,
      beadId: bead.id,
      boardItemId: item.id,
      boardPatch,
    });
  }
  return actions;
}

/**
 * Status agrees when *either* mapping direction lands on the other side's value.
 * `boardToBead(item) === bead` covers the board→bead collapse (`review`,
 * `test`); `beadToBoard(bead) === item` covers the bead→board collapse
 * (`blocked`, `deferred`). Checking both is what makes a lossy map idempotent.
 */
function statusInSync(bead: Bead, item: GhostexBoardItem, m: BoardStatusMapping): boolean {
  return m.boardToBead(item.status) === bead.status || m.beadToBoard(bead.status) === item.status;
}

/**
 * The board status to write when the bead wins: prefer a preserved original
 * (so a bead minted from a `review` item restores `review`, not `in_progress`)
 * when it still round-trips to the bead's current status; otherwise map forward.
 */
function beadStatusToBoard(bead: Bead, mapping: BoardStatusMapping, keys: LinkKeys): string {
  const preserved = bead.metadata?.[keys.boardStatus];
  if (preserved !== undefined && mapping.boardToBead(preserved) === bead.status) {
    return preserved;
  }
  return mapping.beadToBoard(bead.status);
}

/** Apply the per-field authority, falling back to a side when timestamps tie. */
function decideWinner(
  authority: FieldAuthority,
  bead: Bead,
  item: GhostexBoardItem,
  fallback: SyncSide,
): SyncSide {
  if (authority !== 'lastWriter') return authority;
  const beadAt = beadTimestamp(bead);
  const itemAt = boardTimestamp(item);
  if (beadAt === undefined || itemAt === undefined) return fallback;
  if (beadAt > itemAt) return 'beads';
  if (itemAt > beadAt) return 'board';
  return fallback;
}

function createBoardAction(
  bead: Bead,
  mapping: BoardStatusMapping,
  keys: LinkKeys,
  projectId: string | undefined,
): CreateBoardAction {
  const boardCreate: BoardItemCreateInput = {
    title: bead.title,
    status: beadStatusToBoard(bead, mapping, keys),
    metadata: { [keys.beadId]: bead.id },
    ...(projectId !== undefined ? { projectId } : {}),
  };
  return {
    type: 'create-board',
    fields: ['title', 'status', 'link'],
    reason: `bead ${bead.id} has no board item → create on board`,
    beadId: bead.id,
    boardCreate,
  };
}

function createBeadAction(
  item: GhostexBoardItem,
  mapping: BoardStatusMapping,
  keys: LinkKeys,
): CreateBeadAction {
  const metadata: Record<string, string> = { [keys.boardItemId]: item.id };
  if (item.status !== undefined) metadata[keys.boardStatus] = item.status;
  const beadCreate: BeadCreateInput = {
    title: item.title,
    status: mapping.boardToBead(item.status),
    metadata,
  };
  return {
    type: 'create-bead',
    fields: ['title', 'status', 'link'],
    reason: `board item ${item.id} has no bead → create in gas-city`,
    boardItemId: item.id,
    beadCreate,
  };
}

// ---- Linkage + timestamp readers -------------------------------------------

/**
 * Read the linked counterpart id stored on a board item. Board items expose
 * their full source record as `raw`; the link lives either under a `metadata`
 * bag or as a top-level field, so both are checked.
 */
function readBoardLink(item: GhostexBoardItem, key: string): string | undefined {
  const raw = item.raw as Record<string, unknown>;
  const meta = raw['metadata'];
  if (meta !== null && typeof meta === 'object' && !Array.isArray(meta)) {
    const v = (meta as Record<string, unknown>)[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  const top = raw[key];
  if (typeof top === 'string' && top.length > 0) return top;
  return undefined;
}

function beadTimestamp(bead: Bead): number | undefined {
  const raw = bead.updated_at ?? bead.created_at;
  return parseTimestamp(raw);
}

function boardTimestamp(item: GhostexBoardItem): number | undefined {
  const raw = item.raw as Record<string, unknown>;
  const v = pickString(raw['updatedAt']) ?? pickString(raw['updated_at']);
  return parseTimestamp(v);
}

function parseTimestamp(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const t = Date.parse(value);
  return Number.isNaN(t) ? undefined : t;
}

function pickString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

// ---- Applier (imperative shell) --------------------------------------------

/** A single executed action and the ids it resolved to. */
export interface AppliedAction {
  readonly action: ReconcileAction;
  /** Resulting bead id (for `create-bead`, the freshly minted id). */
  readonly beadId?: string;
  /** Resulting board-item id (for `create-board`, the freshly minted id). */
  readonly boardItemId?: string;
}

/** A single action that threw while being applied. */
export interface ReconcileError {
  readonly action: ReconcileAction;
  readonly message: string;
}

export interface ApplyResult {
  readonly applied: readonly AppliedAction[];
  readonly errors: readonly ReconcileError[];
}

/**
 * Execute a plan against the two ports. Failures are collected, not thrown — one
 * bad action does not abort the rest, and the caller gets a per-action ledger.
 */
export async function applyPlan(
  plan: ReconcilePlan,
  beadsSide: BeadsSide,
  boardSide: BoardSide,
  options: { linkKeys?: LinkKeys } = {},
): Promise<ApplyResult> {
  const keys = options.linkKeys ?? DEFAULT_LINK_KEYS;
  const applied: AppliedAction[] = [];
  const errors: ReconcileError[] = [];
  for (const action of plan.actions) {
    try {
      applied.push(await applyAction(action, beadsSide, boardSide, keys));
    } catch (err) {
      errors.push({ action, message: errorMessage(err) });
    }
  }
  return { applied, errors };
}

async function applyAction(
  action: ReconcileAction,
  beadsSide: BeadsSide,
  boardSide: BoardSide,
  keys: LinkKeys,
): Promise<AppliedAction> {
  switch (action.type) {
    case 'create-board': {
      const item = await boardSide.create(action.boardCreate);
      // Back-link the source bead to the freshly created board item.
      await beadsSide.update(action.beadId, { metadata: { [keys.boardItemId]: item.id } });
      return { action, beadId: action.beadId, boardItemId: item.id };
    }
    case 'create-bead': {
      const bead = await beadsSide.create(action.beadCreate);
      // Back-link the source board item to the freshly created bead.
      await boardSide.update(action.boardItemId, { metadata: { [keys.beadId]: bead.id } });
      return { action, beadId: bead.id, boardItemId: action.boardItemId };
    }
    case 'update-bead': {
      const bead = await beadsSide.update(action.beadId, action.beadPatch);
      return { action, beadId: bead.id, boardItemId: action.boardItemId };
    }
    case 'update-board': {
      const item = await boardSide.update(action.boardItemId, action.boardPatch);
      return { action, beadId: action.beadId, boardItemId: item.id };
    }
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---- Orchestrator + report -------------------------------------------------

export interface ReconcileSummary {
  readonly createdBoard: number;
  readonly createdBead: number;
  readonly updatedBoard: number;
  readonly updatedBead: number;
  readonly inSync: number;
  readonly failed: number;
}

export interface ReconcileReport {
  readonly generatedAt: string;
  readonly dryRun: boolean;
  readonly plan: ReconcilePlan;
  readonly applied: readonly AppliedAction[];
  readonly errors: readonly ReconcileError[];
  readonly summary: ReconcileSummary;
}

/**
 * The top-level entry point: snapshot both sides, plan, and — unless `dryRun` —
 * apply, returning a {@link ReconcileReport}. Running it twice with no external
 * change yields an empty second plan (idempotent).
 */
export async function reconcile(
  beadsSide: BeadsSide,
  boardSide: BoardSide,
  options: ReconcileOptions = {},
): Promise<ReconcileReport> {
  const [beads, boardItems] = await Promise.all([beadsSide.list(), boardSide.list()]);
  const plan = planReconcile(beads, boardItems, options);
  const now = options.now ?? (() => new Date());
  if (options.dryRun) {
    return buildReport(plan, [], [], true, now());
  }
  const { applied, errors } = await applyPlan(plan, beadsSide, boardSide, {
    linkKeys: options.linkKeys,
  });
  return buildReport(plan, applied, errors, false, now());
}

function buildReport(
  plan: ReconcilePlan,
  applied: readonly AppliedAction[],
  errors: readonly ReconcileError[],
  dryRun: boolean,
  now: Date,
): ReconcileReport {
  // A dry run summarises what *would* happen; a real run summarises what *did*.
  const counted: readonly ReconcileAction[] = dryRun ? plan.actions : applied.map((a) => a.action);
  const summary: ReconcileSummary = {
    createdBoard: counted.filter((a) => a.type === 'create-board').length,
    createdBead: counted.filter((a) => a.type === 'create-bead').length,
    updatedBoard: counted.filter((a) => a.type === 'update-board').length,
    updatedBead: counted.filter((a) => a.type === 'update-bead').length,
    inSync: plan.inSync,
    failed: errors.length,
  };
  return { generatedAt: now.toISOString(), dryRun, plan, applied, errors, summary };
}

/** Render a {@link ReconcileReport} as a compact, human-readable block. */
export function formatReport(report: ReconcileReport): string {
  const s = report.summary;
  const lines = [
    `Reconcile report (${report.dryRun ? 'dry-run' : 'applied'}) @ ${report.generatedAt}`,
    `  board: +${s.createdBoard} created, ~${s.updatedBoard} updated`,
    `  beads: +${s.createdBead} created, ~${s.updatedBead} updated`,
    `  in-sync: ${s.inSync}   pairs: ${report.plan.pairs}   failed: ${s.failed}`,
  ];
  for (const action of report.plan.actions) {
    lines.push(`  • [${action.type}] ${action.reason}`);
  }
  for (const err of report.errors) {
    lines.push(`  ✗ [${err.action.type}] ${err.message}`);
  }
  return lines.join('\n');
}
