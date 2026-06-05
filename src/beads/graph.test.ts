import { describe, expect, it } from "vitest";
import { buildDependencyGraph, layerGraph, renderGraphMermaid, renderGraphSvg } from "./graph";
import { makeBead, makeGraph } from "./fixtures";

describe("buildDependencyGraph", () => {
  it("de-duplicates nodes, keeps root first, and maps edges", () => {
    const root = makeBead({ id: "root" });
    const a = makeBead({ id: "a" });
    const graph = buildDependencyGraph(
      makeGraph({
        root,
        beads: [root, a, a],
        deps: [{ from: "root", to: "a", kind: "blocks" }],
      }),
    );
    expect(graph.order).toEqual(["root", "a"]);
    expect(graph.rootId).toBe("root");
    expect(graph.edges).toEqual([{ from: "root", to: "a", kind: "blocks" }]);
  });

  it("defaults a missing edge kind to empty string", () => {
    const graph = buildDependencyGraph(
      makeGraph({ beads: [makeBead({ id: "root" }), makeBead({ id: "a" })], deps: [{ from: "root", to: "a" }] }),
    );
    expect(graph.edges[0].kind).toBe("");
  });
});

describe("layerGraph", () => {
  function chain() {
    const ids = ["root", "b", "c"];
    return makeGraph({
      root: makeBead({ id: "root" }),
      beads: ids.map((id) => makeBead({ id })),
      deps: [
        { from: "root", to: "b", kind: "blocks" },
        { from: "b", to: "c", kind: "blocks" },
      ],
    });
  }

  it("assigns longest-path levels along a chain", () => {
    const layout = layerGraph(buildDependencyGraph(chain()));
    expect(layout.position.get("root")!.level).toBe(0);
    expect(layout.position.get("b")!.level).toBe(1);
    expect(layout.position.get("c")!.level).toBe(2);
    expect(layout.levels).toHaveLength(3);
  });

  it("places a diamond's join one level past both branches", () => {
    const layout = layerGraph(
      buildDependencyGraph(
        makeGraph({
          root: makeBead({ id: "root" }),
          beads: ["root", "b", "c", "d"].map((id) => makeBead({ id })),
          deps: [
            { from: "root", to: "b" },
            { from: "root", to: "c" },
            { from: "b", to: "d" },
            { from: "c", to: "d" },
          ],
        }),
      ),
    );
    expect(layout.position.get("d")!.level).toBe(2);
  });

  it("does not loop forever on a cycle", () => {
    const layout = layerGraph(
      buildDependencyGraph(
        makeGraph({
          root: makeBead({ id: "a" }),
          beads: [makeBead({ id: "a" }), makeBead({ id: "b" })],
          deps: [
            { from: "a", to: "b" },
            { from: "b", to: "a" },
          ],
        }),
      ),
    );
    expect(layout.levels.flat().sort()).toEqual(["a", "b"]);
  });

  it("handles a single isolated node", () => {
    const layout = layerGraph(buildDependencyGraph(makeGraph({ root: makeBead({ id: "solo" }), beads: [makeBead({ id: "solo" })] })));
    expect(layout.levels).toEqual([["solo"]]);
  });
});

describe("renderGraphMermaid", () => {
  it("emits a flowchart with sanitized node keys and labelled edges", () => {
    const mermaid = renderGraphMermaid(
      buildDependencyGraph(
        makeGraph({
          root: makeBead({ id: "cockpit-1ll.5", title: "Explorer", status: "open" }),
          beads: [makeBead({ id: "cockpit-1ll.5" }), makeBead({ id: "dep.1" })],
          deps: [{ from: "dep.1", to: "cockpit-1ll.5", kind: "blocks" }],
        }),
      ),
    );
    expect(mermaid).toContain("flowchart LR");
    expect(mermaid).toContain("n_cockpit_1ll_5[");
    expect(mermaid).toContain("n_dep_1 -->|blocks| n_cockpit_1ll_5");
  });
});

describe("renderGraphSvg", () => {
  it("produces an SVG with one node group per bead and one path per edge", () => {
    const graph = buildDependencyGraph(
      makeGraph({
        root: makeBead({ id: "root", title: "Root" }),
        beads: [makeBead({ id: "root" }), makeBead({ id: "a" }), makeBead({ id: "b" })],
        deps: [
          { from: "root", to: "a", kind: "blocks" },
          { from: "root", to: "b" },
        ],
      }),
    );
    const svg = renderGraphSvg(graph);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain(">root<");
    expect((svg.match(/class="gc-edge"/g) ?? []).length).toBe(2);
    expect(svg).toContain("gc-root");
  });

  it("escapes XML-significant characters in ids and titles", () => {
    const graph = buildDependencyGraph(
      makeGraph({ root: makeBead({ id: "a&b", title: "<x>" }), beads: [makeBead({ id: "a&b", title: "<x>" })] }),
    );
    const svg = renderGraphSvg(graph);
    expect(svg).toContain("a&amp;b");
    expect(svg).toContain("&lt;x&gt;");
  });

  it("skips edges whose endpoints are not in the node set", () => {
    const graph = buildDependencyGraph(
      makeGraph({ root: makeBead({ id: "root" }), beads: [makeBead({ id: "root" })], deps: [{ from: "root", to: "ghost" }] }),
    );
    const svg = renderGraphSvg(graph);
    expect((svg.match(/class="gc-edge"/g) ?? []).length).toBe(0);
  });
});
