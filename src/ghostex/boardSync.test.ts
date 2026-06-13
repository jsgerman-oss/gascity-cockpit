import { describe, expect, test } from 'vitest';
import type { Bead } from '../beads/types.ts';
import type { GhostexBoardItem } from './types.ts';
import {
  applyPlan,
  type BeadCreateInput,
  type BeadPatch,
  type BeadsSide,
  type BoardItemCreateInput,
  type BoardItemPatch,
  type BoardSide,
  type ConflictPolicy,
  DEFAULT_CONFLICT_POLICY,
  DEFAULT_LINK_KEYS,
  defaultBoardStatusMapping,
  formatReport,
  type LinkKeys,
  planReconcile,
  reconcile,
} from './boardSync.ts';

// ---- Fixtures + in-memory ports --------------------------------------------

const T_EARLY = '2026-06-10T00:00:00.000Z';
const T_LATE = '2026-06-12T00:00:00.000Z';
const FIXED_NOW = new Date('2026-06-13T12:00:00.000Z');

function makeBead(over: Partial<Bead> & { id: string }): Bead {
  const base: Bead = {
    id: over.id,
    title: `Bead ${over.id}`,
    status: 'open',
    issue_type: 'task',
    created_at: T_EARLY,
  };
  return { ...base, ...over };
}

interface BoardRec {
  id: string;
  title: string;
  status?: string;
  metadata: Record<string, string>;
  updatedAt?: string;
}

function recToItem(r: BoardRec): GhostexBoardItem {
  return {
    id: r.id,
    title: r.title,
    ...(r.status !== undefined ? { status: r.status } : {}),
    raw: {
      id: r.id,
      title: r.title,
      ...(r.status !== undefined ? { status: r.status } : {}),
      metadata: { ...r.metadata },
      ...(r.updatedAt !== undefined ? { updatedAt: r.updatedAt } : {}),
    },
  };
}

/** Build a board item directly (for planner tests that don't need a live side). */
function makeItem(over: Partial<BoardRec> & { id: string }): GhostexBoardItem {
  return recToItem({ title: `Item ${over.id}`, metadata: {}, ...over });
}

class FakeBeadsSide implements BeadsSide {
  created: BeadCreateInput[] = [];
  updated: Array<{ id: string; patch: BeadPatch }> = [];
  failCreate = false;
  failUpdateIds = new Set<string>();
  private seq = 0;
  constructor(public beads: Bead[] = []) {}

  async list(): Promise<readonly Bead[]> {
    return this.beads;
  }

  async create(input: BeadCreateInput): Promise<Bead> {
    this.created.push(input);
    if (this.failCreate) throw new Error('bead create failed');
    const bead = makeBead({
      id: `bead-${++this.seq}`,
      title: input.title,
      status: input.status,
      metadata: { ...input.metadata },
      updated_at: T_LATE,
    });
    this.beads.push(bead);
    return bead;
  }

  async update(id: string, patch: BeadPatch): Promise<Bead> {
    this.updated.push({ id, patch });
    if (this.failUpdateIds.has(id)) throw new Error(`bead update ${id} failed`);
    const bead = this.beads.find((b) => b.id === id);
    if (!bead) throw new Error(`no bead ${id}`);
    const next: Bead = {
      ...bead,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.metadata ? { metadata: { ...(bead.metadata ?? {}), ...patch.metadata } } : {}),
    };
    this.beads[this.beads.indexOf(bead)] = next;
    return next;
  }
}

class FakeBoardSide implements BoardSide {
  created: BoardItemCreateInput[] = [];
  updated: Array<{ id: string; patch: BoardItemPatch }> = [];
  failCreate = false;
  failUpdateIds = new Set<string>();
  private seq = 0;
  constructor(public recs: BoardRec[] = []) {}

  async list(): Promise<readonly GhostexBoardItem[]> {
    return this.recs.map(recToItem);
  }

  async create(input: BoardItemCreateInput): Promise<GhostexBoardItem> {
    this.created.push(input);
    if (this.failCreate) throw new Error('board create failed');
    const rec: BoardRec = {
      id: `item-${++this.seq}`,
      title: input.title,
      status: input.status,
      metadata: { ...input.metadata },
      updatedAt: T_LATE,
    };
    this.recs.push(rec);
    return recToItem(rec);
  }

  async update(id: string, patch: BoardItemPatch): Promise<GhostexBoardItem> {
    this.updated.push({ id, patch });
    if (this.failUpdateIds.has(id)) throw new Error(`board update ${id} failed`);
    const rec = this.recs.find((r) => r.id === id);
    if (!rec) throw new Error(`no item ${id}`);
    if (patch.title !== undefined) rec.title = patch.title;
    if (patch.status !== undefined) rec.status = patch.status;
    if (patch.metadata) Object.assign(rec.metadata, patch.metadata);
    return recToItem(rec);
  }
}

const K = DEFAULT_LINK_KEYS;

// ---- defaultBoardStatusMapping ---------------------------------------------

describe('defaultBoardStatusMapping', () => {
  test('board → bead collapses the Ghostex-only columns', () => {
    expect(defaultBoardStatusMapping.boardToBead('backlog')).toBe('open');
    expect(defaultBoardStatusMapping.boardToBead('open')).toBe('open');
    expect(defaultBoardStatusMapping.boardToBead('in_progress')).toBe('in_progress');
    expect(defaultBoardStatusMapping.boardToBead('review')).toBe('in_progress');
    expect(defaultBoardStatusMapping.boardToBead('test')).toBe('in_progress');
    expect(defaultBoardStatusMapping.boardToBead('closed')).toBe('closed');
  });

  test('bead → board keeps the coarser gas-city statuses', () => {
    expect(defaultBoardStatusMapping.beadToBoard('open')).toBe('open');
    expect(defaultBoardStatusMapping.beadToBoard('in_progress')).toBe('in_progress');
    expect(defaultBoardStatusMapping.beadToBoard('blocked')).toBe('in_progress');
    expect(defaultBoardStatusMapping.beadToBoard('closed')).toBe('closed');
    expect(defaultBoardStatusMapping.beadToBoard('deferred')).toBe('backlog');
  });

  test('unknown and absent statuses fall back to open', () => {
    expect(defaultBoardStatusMapping.boardToBead('mystery')).toBe('open');
    expect(defaultBoardStatusMapping.boardToBead(undefined)).toBe('open');
    expect(defaultBoardStatusMapping.beadToBoard('mystery')).toBe('open');
    expect(defaultBoardStatusMapping.beadToBoard(undefined)).toBe('open');
  });
});

// ---- planReconcile: creation -----------------------------------------------

describe('planReconcile — creation', () => {
  test('empty inputs yield an empty plan', () => {
    const plan = planReconcile([], []);
    expect(plan).toEqual({ actions: [], inSync: 0, pairs: 0 });
  });

  test('an unlinked bead becomes a create-board action carrying the back-link', () => {
    const bead = makeBead({ id: 'b1', title: 'Ship it', status: 'in_progress' });
    const plan = planReconcile([bead], [], { projectId: 'P1' });
    expect(plan.actions).toHaveLength(1);
    const action = plan.actions[0];
    expect(action.type).toBe('create-board');
    expect(action.fields).toEqual(['title', 'status', 'link']);
    if (action.type !== 'create-board') throw new Error('unreachable');
    expect(action.beadId).toBe('b1');
    expect(action.boardCreate).toEqual({
      title: 'Ship it',
      status: 'in_progress',
      metadata: { [K.beadId]: 'b1' },
      projectId: 'P1',
    });
  });

  test('create-board omits projectId when none is given', () => {
    const plan = planReconcile([makeBead({ id: 'b1' })], []);
    const action = plan.actions[0];
    if (action.type !== 'create-board') throw new Error('unreachable');
    expect('projectId' in action.boardCreate).toBe(false);
  });

  test('an unlinked board item becomes a create-bead action preserving its status', () => {
    const item = makeItem({ id: 'i1', title: 'Investigate', status: 'review' });
    const plan = planReconcile([], [item]);
    expect(plan.actions).toHaveLength(1);
    const action = plan.actions[0];
    expect(action.type).toBe('create-bead');
    if (action.type !== 'create-bead') throw new Error('unreachable');
    expect(action.boardItemId).toBe('i1');
    expect(action.beadCreate).toEqual({
      title: 'Investigate',
      status: 'in_progress', // review → in_progress
      metadata: { [K.boardItemId]: 'i1', [K.boardStatus]: 'review' },
    });
  });

  test('create-bead from a statusless item omits the preserved-status key', () => {
    const plan = planReconcile([], [makeItem({ id: 'i1' })]);
    const action = plan.actions[0];
    if (action.type !== 'create-bead') throw new Error('unreachable');
    expect(action.beadCreate.metadata).toEqual({ [K.boardItemId]: 'i1' });
    expect(action.beadCreate.status).toBe('open'); // undefined → open
  });
});

// ---- planReconcile: matching -----------------------------------------------

describe('planReconcile — matching', () => {
  test('a fully consistent linked pair produces no actions', () => {
    const bead = makeBead({ id: 'b1', title: 'Same', status: 'open', metadata: { [K.boardItemId]: 'i1' } });
    const item = makeItem({ id: 'i1', title: 'Same', status: 'open', metadata: { [K.beadId]: 'b1' } });
    const plan = planReconcile([bead], [item]);
    expect(plan.actions).toEqual([]);
    expect(plan.pairs).toBe(1);
    expect(plan.inSync).toBe(1);
  });

  test('a pair matched only by the board back-link still reconciles', () => {
    const bead = makeBead({ id: 'b1', title: 'Same', status: 'open' });
    const item = makeItem({ id: 'i1', title: 'Same', status: 'open', metadata: { [K.beadId]: 'b1' } });
    const plan = planReconcile([bead], [item]);
    expect(plan.pairs).toBe(1);
    // Only the missing bead→board link needs writing.
    expect(plan.actions).toHaveLength(1);
    const action = plan.actions[0];
    expect(action.type).toBe('update-bead');
    expect(action.fields).toEqual(['link']);
    if (action.type !== 'update-bead') throw new Error('unreachable');
    expect(action.beadPatch.metadata).toEqual({ [K.boardItemId]: 'i1' });
  });

  test('a pair matched by the bead forward-link writes the missing board back-link', () => {
    const bead = makeBead({ id: 'b1', title: 'Same', status: 'open', metadata: { [K.boardItemId]: 'i1' } });
    const item = makeItem({ id: 'i1', title: 'Same', status: 'open' }); // no beadId link
    const plan = planReconcile([bead], [item]);
    expect(plan.pairs).toBe(1);
    expect(plan.actions).toHaveLength(1);
    const action = plan.actions[0];
    expect(action.type).toBe('update-board');
    expect(action.fields).toEqual(['link']);
    if (action.type !== 'update-board') throw new Error('unreachable');
    expect(action.boardPatch.metadata).toEqual({ [K.beadId]: 'b1' });
  });

  test('a dangling forward link (item gone) falls through to create-board', () => {
    const bead = makeBead({ id: 'b1', metadata: { [K.boardItemId]: 'gone' } });
    const plan = planReconcile([bead], []);
    expect(plan.actions[0].type).toBe('create-board');
  });

  test('a board item linking to an existing but otherwise-matched bead is skipped, not duplicated', () => {
    // b1 forward-links to i-a; i-c back-links to b1 (b1 already paired with i-a).
    const bead = makeBead({
      id: 'b1',
      title: 'Same',
      status: 'open',
      metadata: { [K.boardItemId]: 'i-a' },
    });
    const itemA = makeItem({ id: 'i-a', title: 'Same', status: 'open', metadata: { [K.beadId]: 'b1' } });
    const itemC = makeItem({ id: 'i-c', title: 'Same', status: 'open', metadata: { [K.beadId]: 'b1' } });
    const plan = planReconcile([bead], [itemA, itemC]);
    expect(plan.actions).toEqual([]); // i-c is neither paired nor re-created
    expect(plan.pairs).toBe(1);
  });

  test('a board item linking to a non-existent bead is mirrored as a new bead', () => {
    const item = makeItem({ id: 'i1', title: 'Orphan', status: 'open', metadata: { [K.beadId]: 'ghost' } });
    const plan = planReconcile([], [item]);
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0].type).toBe('create-bead');
  });
});

// ---- planReconcile: field divergence + conflict policy ---------------------

describe('planReconcile — divergence + policy', () => {
  // Both sides share a title by default, so a test isolates the one field it
  // varies (a differing title would otherwise leak its own action in).
  const linked = (beadOver: Partial<Bead>, itemOver: Partial<BoardRec>) => {
    const bead = makeBead({
      id: 'b1',
      title: 'Same',
      metadata: { [K.boardItemId]: 'i1' },
      ...beadOver,
    });
    const item = makeItem({ id: 'i1', title: 'Same', metadata: { [K.beadId]: 'b1' }, ...itemOver });
    return { bead, item };
  };

  test('title: a pinned "beads" source pushes the bead title onto the board', () => {
    const { bead, item } = linked({ title: 'Canonical' }, { title: 'Stale' });
    const policy: ConflictPolicy = { title: 'beads', status: 'lastWriter' };
    const plan = planReconcile([bead], [item], { policy });
    expect(plan.actions).toHaveLength(1);
    const action = plan.actions[0];
    expect(action.type).toBe('update-board');
    if (action.type !== 'update-board') throw new Error('unreachable');
    expect(action.boardPatch.title).toBe('Canonical');
    expect(action.fields).toEqual(['title']);
  });

  test('title: a pinned "board" source pushes the item title onto the bead', () => {
    const { bead, item } = linked({ title: 'Stale' }, { title: 'Canonical' });
    const policy: ConflictPolicy = { title: 'board', status: 'lastWriter' };
    const plan = planReconcile([bead], [item], { policy });
    const action = plan.actions[0];
    expect(action.type).toBe('update-bead');
    if (action.type !== 'update-bead') throw new Error('unreachable');
    expect(action.beadPatch.title).toBe('Canonical');
  });

  test('title: last-writer picks the more recently updated side (board newer)', () => {
    const { bead, item } = linked(
      { title: 'Old', updated_at: T_EARLY },
      { title: 'New', updatedAt: T_LATE },
    );
    const plan = planReconcile([bead], [item]);
    expect(plan.actions[0].type).toBe('update-bead');
  });

  test('title: last-writer picks the more recently updated side (bead newer)', () => {
    const { bead, item } = linked(
      { title: 'New', updated_at: T_LATE },
      { title: 'Old', updatedAt: T_EARLY },
    );
    const plan = planReconcile([bead], [item]);
    expect(plan.actions[0].type).toBe('update-board');
  });

  test('title: last-writer ties break to the default winner', () => {
    const { bead, item } = linked(
      { title: 'A', updated_at: T_LATE },
      { title: 'B', updatedAt: T_LATE },
    );
    expect(planReconcile([bead], [item], { defaultWinner: 'board' }).actions[0].type).toBe('update-bead');
    expect(planReconcile([bead], [item], { defaultWinner: 'beads' }).actions[0].type).toBe('update-board');
  });

  test('title: last-writer with an unparseable timestamp falls back', () => {
    const { bead, item } = linked(
      { title: 'A', updated_at: 'not-a-date' },
      { title: 'B', updatedAt: T_LATE },
    );
    // bead timestamp is undefined → fall back (default 'beads' → push to board)
    expect(planReconcile([bead], [item]).actions[0].type).toBe('update-board');
  });

  test('last-writer reads bead.created_at and a snake_case board updated_at', () => {
    // bead has no updated_at → its timestamp comes from created_at (T_LATE);
    // the board item carries a snake_case `updated_at` (older).
    const bead = makeBead({
      id: 'b1',
      title: 'BeadT',
      status: 'open',
      created_at: T_LATE,
      metadata: { [K.boardItemId]: 'i1' },
    });
    const item: GhostexBoardItem = {
      id: 'i1',
      title: 'ItemT',
      status: 'open',
      raw: { id: 'i1', metadata: { [K.beadId]: 'b1' }, updated_at: T_EARLY },
    };
    const plan = planReconcile([bead], [item]);
    expect(plan.actions.find((a) => a.fields.includes('title'))?.type).toBe('update-board');
  });

  test('last-writer with a board item lacking any timestamp falls back', () => {
    const bead = makeBead({
      id: 'b1',
      title: 'BeadT',
      status: 'open',
      updated_at: T_LATE,
      metadata: { [K.boardItemId]: 'i1' },
    });
    const item = makeItem({ id: 'i1', title: 'ItemT', status: 'open', metadata: { [K.beadId]: 'b1' } });
    const plan = planReconcile([bead], [item], { defaultWinner: 'board' });
    expect(plan.actions.find((a) => a.fields.includes('title'))?.type).toBe('update-bead');
  });

  test('status: board wins → bead adopts the mapped status and preserves the original', () => {
    const { bead, item } = linked({ status: 'open' }, { status: 'review' });
    const policy: ConflictPolicy = { title: 'lastWriter', status: 'board' };
    const plan = planReconcile([bead], [item], { policy });
    const action = plan.actions[0];
    expect(action.type).toBe('update-bead');
    if (action.type !== 'update-bead') throw new Error('unreachable');
    expect(action.beadPatch.status).toBe('in_progress');
    expect(action.beadPatch.metadata).toEqual({ [K.boardStatus]: 'review' });
  });

  test('status: beads wins → board adopts the mapped status', () => {
    const { bead, item } = linked({ status: 'closed' }, { status: 'open' });
    const policy: ConflictPolicy = { title: 'lastWriter', status: 'beads' };
    const plan = planReconcile([bead], [item], { policy });
    const action = plan.actions[0];
    expect(action.type).toBe('update-board');
    if (action.type !== 'update-board') throw new Error('unreachable');
    expect(action.boardPatch.status).toBe('closed');
  });

  test('status: a preserved original is restored when the bead wins', () => {
    // bead is in_progress with a preserved "review"; board drifted to "open".
    const { bead, item } = linked(
      { status: 'in_progress', metadata: { [K.boardItemId]: 'i1', [K.boardStatus]: 'review' } },
      { status: 'open' },
    );
    const policy: ConflictPolicy = { title: 'lastWriter', status: 'beads' };
    const plan = planReconcile([bead], [item], { policy });
    const action = plan.actions[0];
    if (action.type !== 'update-board') throw new Error('unreachable');
    expect(action.boardPatch.status).toBe('review'); // restored, not collapsed to in_progress
  });

  test('status: a preserved original that no longer round-trips is ignored', () => {
    // preserved "review" maps to in_progress, but the bead is now "closed".
    const { bead, item } = linked(
      { status: 'closed', metadata: { [K.boardItemId]: 'i1', [K.boardStatus]: 'review' } },
      { status: 'open' },
    );
    const policy: ConflictPolicy = { title: 'lastWriter', status: 'beads' };
    const plan = planReconcile([bead], [item], { policy });
    const action = plan.actions[0];
    if (action.type !== 'update-board') throw new Error('unreachable');
    expect(action.boardPatch.status).toBe('closed'); // forward map, preserved ignored
  });

  test('status: the bead→board collapse (blocked) is treated as in-sync', () => {
    // blocked → in_progress; an in_progress board item already reflects that.
    const { bead, item } = linked({ status: 'blocked' }, { status: 'in_progress' });
    const plan = planReconcile([bead], [item]);
    expect(plan.actions).toEqual([]);
    expect(plan.inSync).toBe(1);
  });

  test('a genuinely diverged status (open vs in_progress) is not in-sync', () => {
    const { bead, item } = linked({ status: 'open' }, { status: 'in_progress' });
    const plan = planReconcile([bead], [item], { policy: { title: 'lastWriter', status: 'board' } });
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0].type).toBe('update-bead');
  });

  test('a divergence on both sides emits one action per side', () => {
    const bead = makeBead({ id: 'b1', title: 'BeadTitle', status: 'open' }); // no links yet
    const item = makeItem({ id: 'i1', title: 'BeadTitle', status: 'open', metadata: { [K.beadId]: 'b1' } });
    // Force the bead to win title, board to win status, both links missing on bead.
    const plan = planReconcile([bead], [{ ...item, title: 'ItemTitle' } as GhostexBoardItem], {
      policy: { title: 'beads', status: 'board' },
    });
    const types = plan.actions.map((a) => a.type).sort();
    expect(types).toEqual(['update-bead', 'update-board']);
    const beadAction = plan.actions.find((a) => a.type === 'update-bead');
    expect(beadAction?.fields).toContain('link'); // bead had no forward link
  });
});

// ---- custom injection ------------------------------------------------------

describe('planReconcile — injection', () => {
  test('custom link keys and a custom mapping are honoured', () => {
    const keys: LinkKeys = { boardItemId: 'x.board', boardStatus: 'x.bs', beadId: 'x.bead' };
    const mapping = {
      boardToBead: () => 'frozen',
      beadToBoard: () => 'iced',
    };
    const bead = makeBead({ id: 'b1', status: 'frozen' });
    const plan = planReconcile([bead], [], { linkKeys: keys, mapping });
    const action = plan.actions[0];
    if (action.type !== 'create-board') throw new Error('unreachable');
    expect(action.boardCreate.status).toBe('iced');
    expect(action.boardCreate.metadata).toEqual({ 'x.bead': 'b1' });
  });

  test('DEFAULT_CONFLICT_POLICY is last-writer on both fields', () => {
    expect(DEFAULT_CONFLICT_POLICY).toEqual({ title: 'lastWriter', status: 'lastWriter' });
  });
});

// ---- readBoardLink edge cases (via matching) -------------------------------

describe('planReconcile — board link reading', () => {
  test('a top-level link field (no metadata bag) is honoured', () => {
    const bead = makeBead({ id: 'b1', title: 'Same', status: 'open' });
    const item: GhostexBoardItem = {
      id: 'i1',
      title: 'Same',
      status: 'open',
      raw: { id: 'i1', [K.beadId]: 'b1' },
    };
    const plan = planReconcile([bead], [item]);
    expect(plan.pairs).toBe(1); // matched via top-level raw link
  });

  test('a non-string / array metadata bag does not crash matching', () => {
    const item: GhostexBoardItem = {
      id: 'i1',
      title: 'Solo',
      status: 'open',
      raw: { id: 'i1', metadata: [1, 2, 3] },
    };
    const plan = planReconcile([], [item]);
    expect(plan.actions[0].type).toBe('create-bead'); // unlinked → mirrored
  });

  test('a non-string link value is ignored', () => {
    const item: GhostexBoardItem = {
      id: 'i1',
      title: 'Solo',
      status: 'open',
      raw: { id: 'i1', metadata: { [K.beadId]: 42 } },
    };
    const plan = planReconcile([], [item]);
    expect(plan.actions[0].type).toBe('create-bead');
  });
});

// ---- applyPlan -------------------------------------------------------------

describe('applyPlan', () => {
  test('create-board creates the item and writes the back-link onto the bead', async () => {
    const bead = makeBead({ id: 'b1', title: 'T', status: 'open' });
    const beads = new FakeBeadsSide([bead]);
    const board = new FakeBoardSide([]);
    const plan = planReconcile(beads.beads, board.recs.map(recToItem));
    const result = await applyPlan(plan, beads, board);

    expect(result.errors).toEqual([]);
    expect(board.created).toHaveLength(1);
    expect(beads.updated).toEqual([{ id: 'b1', patch: { metadata: { [K.boardItemId]: 'item-1' } } }]);
    expect(result.applied[0].boardItemId).toBe('item-1');
  });

  test('create-bead creates the bead and writes the back-link onto the item', async () => {
    const item: BoardRec = { id: 'i1', title: 'T', status: 'open', metadata: {} };
    const beads = new FakeBeadsSide([]);
    const board = new FakeBoardSide([item]);
    const plan = planReconcile(beads.beads, board.recs.map(recToItem));
    const result = await applyPlan(plan, beads, board);

    expect(result.errors).toEqual([]);
    expect(beads.created).toHaveLength(1);
    expect(board.updated).toEqual([{ id: 'i1', patch: { metadata: { [K.beadId]: 'bead-1' } } }]);
    expect(result.applied[0].beadId).toBe('bead-1');
  });

  test('update-bead and update-board are dispatched to the right side', async () => {
    const bead = makeBead({ id: 'b1', title: 'Old', status: 'open', metadata: { [K.boardItemId]: 'i1' } });
    const beads = new FakeBeadsSide([bead]);
    const board = new FakeBoardSide([
      { id: 'i1', title: 'New', status: 'open', metadata: { [K.beadId]: 'b1' }, updatedAt: T_LATE },
    ]);
    // board newer → bead adopts the title
    const beadWithTime = { ...bead, updated_at: T_EARLY };
    beads.beads[0] = beadWithTime;
    const plan = planReconcile(beads.beads, board.recs.map(recToItem));
    await applyPlan(plan, beads, board);
    expect(beads.updated[0].patch.title).toBe('New');
  });

  test('applies an update-board action to the board side', async () => {
    const bead = makeBead({ id: 'b1', title: 'Canonical', status: 'open', metadata: { [K.boardItemId]: 'i1' } });
    const beads = new FakeBeadsSide([bead]);
    const board = new FakeBoardSide([
      { id: 'i1', title: 'Stale', status: 'open', metadata: { [K.beadId]: 'b1' } },
    ]);
    const plan = planReconcile(beads.beads, board.recs.map(recToItem), {
      policy: { title: 'beads', status: 'lastWriter' },
    });
    expect(plan.actions[0].type).toBe('update-board');
    const result = await applyPlan(plan, beads, board);
    expect(result.errors).toEqual([]);
    expect(board.updated[0].patch.title).toBe('Canonical');
    expect(board.recs[0].title).toBe('Canonical');
  });

  test('a failing action is captured, and the rest still apply', async () => {
    const b1 = makeBead({ id: 'b1', title: 'A', status: 'open' });
    const b2 = makeBead({ id: 'b2', title: 'B', status: 'open' });
    const beads = new FakeBeadsSide([b1, b2]);
    const board = new FakeBoardSide([]);
    board.failUpdateIds.add('item-1'); // back-link write for the first create will fail
    const plan = planReconcile(beads.beads, []);
    // Both are create-board; make the first fail on its bead back-link instead:
    beads.failUpdateIds.add('b1');
    const result = await applyPlan(plan, beads, board);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain('bead update b1 failed');
    expect(result.applied).toHaveLength(1); // b2's create-board still succeeded
  });

  test('a non-Error throw is stringified into the error ledger', async () => {
    const bead = makeBead({ id: 'b1', title: 'A', status: 'open' });
    const beads = new FakeBeadsSide([bead]);
    const board: BoardSide = {
      list: async () => [],
      create: async () => {
        throw 'kaboom'; // non-Error
      },
      update: async () => {
        throw new Error('unused');
      },
    };
    const plan = planReconcile([bead], []);
    const result = await applyPlan(plan, beads, board);
    expect(result.errors[0].message).toBe('kaboom');
  });

  test('custom link keys are used when writing back-links', async () => {
    const keys: LinkKeys = { boardItemId: 'x.board', boardStatus: 'x.bs', beadId: 'x.bead' };
    const bead = makeBead({ id: 'b1', title: 'T', status: 'open' });
    const beads = new FakeBeadsSide([bead]);
    const board = new FakeBoardSide([]);
    const plan = planReconcile(beads.beads, [], { linkKeys: keys });
    await applyPlan(plan, beads, board, { linkKeys: keys });
    expect(beads.updated[0].patch.metadata).toEqual({ 'x.board': 'item-1' });
  });
});

// ---- reconcile orchestrator + idempotency ----------------------------------

describe('reconcile', () => {
  test('dry-run plans but performs no writes', async () => {
    const beads = new FakeBeadsSide([makeBead({ id: 'b1', title: 'T', status: 'open' })]);
    const board = new FakeBoardSide([]);
    const report = await reconcile(beads, board, { dryRun: true, now: () => FIXED_NOW });

    expect(report.dryRun).toBe(true);
    expect(report.generatedAt).toBe(FIXED_NOW.toISOString());
    expect(report.applied).toEqual([]);
    expect(report.summary.createdBoard).toBe(1);
    expect(beads.created).toEqual([]);
    expect(board.created).toEqual([]); // nothing written
  });

  test('a full run writes both sides and a second run is a no-op (idempotent)', async () => {
    const beads = new FakeBeadsSide([makeBead({ id: 'b1', title: 'T', status: 'in_progress' })]);
    const board = new FakeBoardSide([
      { id: 'i9', title: 'From board', status: 'review', metadata: {}, updatedAt: T_LATE },
    ]);

    const first = await reconcile(beads, board, { now: () => FIXED_NOW });
    expect(first.summary.createdBoard).toBe(1);
    expect(first.summary.createdBead).toBe(1);
    expect(first.errors).toEqual([]);

    const second = await reconcile(beads, board, { now: () => FIXED_NOW });
    expect(second.plan.actions).toEqual([]);
    expect(second.summary.inSync).toBe(2);
    expect(second.summary.createdBoard).toBe(0);
    expect(second.summary.createdBead).toBe(0);
  });

  test('uses a real clock when none is injected', async () => {
    const beads = new FakeBeadsSide([]);
    const board = new FakeBoardSide([]);
    const report = await reconcile(beads, board);
    expect(Number.isNaN(Date.parse(report.generatedAt))).toBe(false);
  });

  test('the summary reflects applied work and counts failures', async () => {
    const beads = new FakeBeadsSide([makeBead({ id: 'b1', title: 'T', status: 'open' })]);
    const board = new FakeBoardSide([]);
    board.failCreate = true; // the create-board action will fail
    const report = await reconcile(beads, board, { now: () => FIXED_NOW });
    expect(report.summary.createdBoard).toBe(0); // nothing applied
    expect(report.summary.failed).toBe(1);
  });
});

// ---- formatReport ----------------------------------------------------------

describe('formatReport', () => {
  test('renders the header, counts, action lines, and error lines', async () => {
    const beads = new FakeBeadsSide([makeBead({ id: 'b1', title: 'T', status: 'open' })]);
    const board = new FakeBoardSide([]);
    board.failCreate = true;
    const report = await reconcile(beads, board, { now: () => FIXED_NOW });
    const text = formatReport(report);

    expect(text).toContain('Reconcile report (applied)');
    expect(text).toContain('board: +0 created');
    expect(text).toContain('• [create-board]');
    expect(text).toContain('✗ [create-board] board create failed');
  });

  test('labels a dry run as such', () => {
    const plan = planReconcile([makeBead({ id: 'b1' })], []);
    const report = {
      generatedAt: FIXED_NOW.toISOString(),
      dryRun: true,
      plan,
      applied: [],
      errors: [],
      summary: {
        createdBoard: 1,
        createdBead: 0,
        updatedBoard: 0,
        updatedBead: 0,
        inSync: 0,
        failed: 0,
      },
    };
    expect(formatReport(report)).toContain('Reconcile report (dry-run)');
  });
});
