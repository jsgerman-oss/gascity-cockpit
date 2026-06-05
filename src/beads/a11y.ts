// Accessible-name composition for the Beads explorer tree (PRD Phase 3 a11y).
//
// VS Code announces a TreeItem's label + description to screen readers, but the
// status an item conveys through its *icon* (ready / blocked / in-progress …) is
// invisible to assistive tech. These pure helpers fold that icon-encoded state
// back into words so a single accessible label carries everything a sighted user
// sees. `../views/beadsExplorer.ts` sets the result as `TreeItem.accessibilityInformation`.
//
// Kept `vscode`-free (Seam 1) so the phrasing is unit-tested without an editor.
import { displayStatusLabel, priorityLabel } from "./status.ts";
import type { BeadTreeNode } from "./types.ts";

/** `1 bead` / `3 beads` — count with a correctly pluralised noun. */
function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * A screen-reader label for one bead-tree node, folding the icon-conveyed status
 * into words. Returns a comma-separated phrase (VS Code reads it as the item's
 * accessible name in place of the bare label).
 */
export function accessibleBeadNodeLabel(node: BeadTreeNode): string {
  switch (node.kind) {
    case "city": {
      const parts = [`City ${node.city}`];
      if (node.error) parts.push("failed to load");
      else if (!node.running) parts.push("stopped");
      else parts.push(plural(node.count, "bead") + (node.partial ? " (truncated)" : ""));
      return parts.join(", ");
    }
    case "group":
      return `${node.label}, ${plural(node.count, "bead")}`;
    case "bead": {
      const bead = node.record.bead;
      const parts = [bead.id, displayStatusLabel(node.displayStatus), priorityLabel(bead.priority)];
      if (bead.title) parts.push(bead.title);
      return parts.join(", ");
    }
    case "message":
      return node.detail ? `${node.label}: ${node.detail}` : node.label;
  }
}
