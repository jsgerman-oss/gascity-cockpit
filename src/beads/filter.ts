// Filtering, grouping, and tree assembly for the Beads explorer.
//
// Pure transforms from the multi-city `ExplorerData` (plus a view spec) to the
// nested `BeadTreeNode[]` the VS Code provider renders. Keeping this here, free
// of `vscode`, is what makes the explorer's behaviour testable (PRD Seam 1).
import type {
  BeadFilters,
  BeadLeaf,
  BeadRecord,
  BeadTreeNode,
  CityNode,
  CityRecords,
  ExplorerData,
  GroupKey,
  GroupNode,
  MessageNode,
} from "./types.ts";
import {
  beadAssignee,
  beadRig,
  beadType,
  deriveDisplayStatus,
  displayStatusLabel,
  displayStatusRank,
  isOperationalBead,
  priorityLabel,
  priorityRank,
} from "./status.ts";
import { CITY_PLACEHOLDER } from "../cities/index.ts";

export interface BeadViewSpec {
  groupBy: GroupKey;
  filters: BeadFilters;
}

/** Apply every active filter (logical AND) to a record set. */
export function filterRecords(
  records: BeadRecord[],
  filters: BeadFilters,
  now: Date = new Date(),
): BeadRecord[] {
  const text = filters.text?.trim().toLowerCase();
  return records.filter((record) => {
    const status = deriveDisplayStatus(record, now);

    // Hide closed beads unless the caller asked for them, either via the global
    // toggle or by naming "closed" explicitly in the status filter.
    if (status === "closed" && !filters.includeClosed && !(filters.status?.includes("closed"))) {
      return false;
    }
    // Operational wisps (nudges, orders, patrols, sessions, mail) are plumbing,
    // not work — hidden unless the operator explicitly opts to show them.
    if (filters.hideOperational !== false && isOperationalBead(record.bead)) {
      return false;
    }
    if (filters.status && filters.status.length > 0 && !filters.status.includes(status)) {
      return false;
    }
    if (filters.rig !== undefined && beadRig(record.bead) !== filters.rig) {
      return false;
    }
    if (filters.assignee !== undefined && (record.bead.assignee ?? "") !== filters.assignee) {
      return false;
    }
    if (filters.type !== undefined && (record.bead.issue_type ?? "") !== filters.type) {
      return false;
    }
    if (filters.priority !== undefined && record.bead.priority !== filters.priority) {
      return false;
    }
    if (text) {
      const haystack = `${record.bead.id} ${record.bead.title ?? ""}`.toLowerCase();
      if (!haystack.includes(text)) return false;
    }
    return true;
  });
}

interface GroupKeyParts {
  key: string;
  label: string;
  rank: number;
}

function groupKeyFor(record: BeadRecord, groupBy: GroupKey, now: Date): GroupKeyParts {
  switch (groupBy) {
    case "status": {
      const status = deriveDisplayStatus(record, now);
      return { key: status, label: displayStatusLabel(status), rank: displayStatusRank(status) };
    }
    case "rig": {
      const rig = beadRig(record.bead);
      return { key: rig, label: rig, rank: 0 };
    }
    case "assignee": {
      const assignee = beadAssignee(record.bead);
      return { key: assignee, label: assignee, rank: assignee.startsWith("(") ? 1 : 0 };
    }
    case "type": {
      const type = beadType(record.bead);
      return { key: type, label: type, rank: 0 };
    }
    case "priority": {
      const p = record.bead.priority;
      return { key: p === undefined ? "unset" : String(p), label: priorityLabel(p), rank: priorityRank(p) };
    }
  }
}

/** Stable record order within a group: actionable status, then priority, then id. */
export function sortRecords(records: BeadRecord[], now: Date = new Date()): BeadRecord[] {
  return [...records].sort((a, b) => {
    const sr = displayStatusRank(deriveDisplayStatus(a, now)) - displayStatusRank(deriveDisplayStatus(b, now));
    if (sr !== 0) return sr;
    const pr = priorityRank(a.bead.priority) - priorityRank(b.bead.priority);
    if (pr !== 0) return pr;
    return a.bead.id.localeCompare(b.bead.id);
  });
}

/** Partition records into ordered groups for one city. */
export function groupRecords(
  city: string,
  records: BeadRecord[],
  groupBy: GroupKey,
  now: Date = new Date(),
): GroupNode[] {
  const groups = new Map<string, GroupNode>();
  for (const record of records) {
    const parts = groupKeyFor(record, groupBy, now);
    let group = groups.get(parts.key);
    if (!group) {
      group = {
        kind: "group",
        id: `group:${city}:${groupBy}:${parts.key}`,
        city,
        groupBy,
        key: parts.key,
        label: parts.label,
        rank: parts.rank,
        count: 0,
        children: [],
      };
      groups.set(parts.key, group);
    }
    group.children.push(leafFor(record, now));
  }

  const ordered = [...groups.values()].sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label));
  for (const group of ordered) {
    group.children = sortLeaves(group.children);
    group.count = group.children.length;
  }
  return ordered;
}

function leafFor(record: BeadRecord, now: Date): BeadLeaf {
  return {
    kind: "bead",
    id: `bead:${record.city}:${record.bead.id}`,
    city: record.city,
    beadId: record.bead.id,
    record,
    displayStatus: deriveDisplayStatus(record, now),
  };
}

function sortLeaves(leaves: BeadLeaf[]): BeadLeaf[] {
  return [...leaves].sort((a, b) => {
    const sr = displayStatusRank(a.displayStatus) - displayStatusRank(b.displayStatus);
    if (sr !== 0) return sr;
    const pr = priorityRank(a.record.bead.priority) - priorityRank(b.record.bead.priority);
    if (pr !== 0) return pr;
    return a.beadId.localeCompare(b.beadId);
  });
}

function cityNode(cityRecords: CityRecords, spec: BeadViewSpec, now: Date): CityNode {
  const children: Array<GroupNode | MessageNode> = [];

  if (cityRecords.error) {
    children.push({
      kind: "message",
      id: `msg:${cityRecords.city}:error`,
      label: "Failed to load beads",
      detail: cityRecords.error,
      icon: "error",
    });
  } else if (!cityRecords.running) {
    children.push({
      kind: "message",
      id: `msg:${cityRecords.city}:stopped`,
      label: "City stopped — no beads served",
      icon: "circle-slash",
    });
  }

  const filtered = filterRecords(cityRecords.records, spec.filters, now);
  const groups = groupRecords(cityRecords.city, filtered, spec.groupBy, now);
  children.push(...groups);

  if (!cityRecords.error && cityRecords.running && groups.length === 0) {
    children.push({
      kind: "message",
      id: `msg:${cityRecords.city}:empty`,
      label: "No matching beads",
      icon: "inbox",
    });
  }

  return {
    kind: "city",
    id: `city:${cityRecords.city}`,
    city: cityRecords.city,
    running: cityRecords.running,
    error: cityRecords.error,
    partial: cityRecords.partial,
    count: filtered.length,
    children,
  };
}

/**
 * Assemble the explorer tree: a city tier on top (PRD multi-city), each holding
 * the grouped, filtered beads. An empty dataset collapses to a single message
 * row so the view is never blank-and-confusing.
 */
export function buildBeadTree(
  data: ExplorerData,
  spec: BeadViewSpec,
  now: Date = new Date(),
): BeadTreeNode[] {
  if (data.cities.length === 0) {
    return [{ kind: "message", id: "msg:no-cities", label: CITY_PLACEHOLDER.noCities, icon: "info" }];
  }
  return data.cities.map((city) => cityNode(city, spec, now));
}
