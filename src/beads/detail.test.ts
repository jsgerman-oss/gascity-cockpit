import { describe, expect, it } from "vitest";
import { formatBeadDetailMarkdown } from "./detail";
import { makeRecord } from "./fixtures";

const NOW = new Date("2026-06-05T00:00:00Z");

describe("formatBeadDetailMarkdown", () => {
  it("renders the heading, rich status line, and field table", () => {
    const md = formatBeadDetailMarkdown(
      makeRecord(
        {
          id: "cockpit-1ll.5",
          title: "Beads explorer",
          status: "open",
          issue_type: "task",
          priority: 2,
          assignee: "rigA/agent",
        },
        true,
      ),
      NOW,
    );
    expect(md).toContain("# cockpit-1ll.5 — Beads explorer");
    expect(md).toContain("**Ready** · task · P2 · normal");
    expect(md).toContain("| Field | Value |");
    expect(md).toContain("`rigA/agent`");
  });

  it("renders dependencies as a typed list", () => {
    const md = formatBeadDetailMarkdown(
      makeRecord({
        dependencies: [
          { issue_id: "a", depends_on_id: "cockpit-1ll.1", type: "blocks" },
          { issue_id: "a", depends_on_id: "cockpit-1ll.2", type: "parent-child" },
        ],
      }),
      NOW,
    );
    expect(md).toContain("blocks → `cockpit-1ll.1`");
    expect(md).toContain("parent-child → `cockpit-1ll.2`");
  });

  it("renders a metadata table sorted by key", () => {
    const md = formatBeadDetailMarkdown(
      makeRecord({ metadata: { target: "main", branch: "feat/x" } }),
      NOW,
    );
    const branchAt = md.indexOf("`branch`");
    const targetAt = md.indexOf("`target`");
    expect(branchAt).toBeGreaterThan(-1);
    expect(targetAt).toBeGreaterThan(branchAt);
  });

  it("handles empty description, deps, and metadata gracefully", () => {
    const md = formatBeadDetailMarkdown(makeRecord({ description: "", dependencies: [], metadata: {} }), NOW);
    expect(md).toContain("_No description._");
    expect(md).toContain("_No dependencies._");
    expect(md).not.toContain("## Metadata");
  });

  it("notes that comments/history are outside the /v0 contract", () => {
    const md = formatBeadDetailMarkdown(makeRecord(), NOW);
    expect(md).toContain("Comments and edit history are not exposed by the /v0 bead contract.");
  });
});
