// Tests for the web companion's pure render layer. Like the CLI target's tests,
// these do double duty: exercise the data → HTML builders with plain fixtures,
// and assert the **core boundary contract** — that this browser target reaches
// the `core` symbols (and the shared cross-pane vocabulary) it renders from.
import { describe, expect, it } from "vitest";
import * as core from "../../src/core/index.ts";
import { makeRecord } from "../../src/beads/fixtures.ts";
import { errorNotice, loadingNotice } from "../../src/ui/index.ts";
import {
  type PaneView,
  escapeHtml,
  noticeHtml,
  renderBeadsPane,
  renderFleetPane,
  renderTelemetryPane,
} from "./render.ts";

// --- minimal typed fixtures (cast past generated-schema required fields) ---

function agent(o: Partial<core.status.AgentResponse>): core.status.AgentResponse {
  return { name: "ag", state: "running", running: true, available: true, ...o } as core.status.AgentResponse;
}
function session(o: Partial<core.status.SessionResponse>): core.status.SessionResponse {
  return { id: "s1", state: "running", running: true, ...o } as core.status.SessionResponse;
}
function city(o: Partial<core.status.CityInfo>): core.status.CityInfo {
  return { name: "alpha", running: true, ...o } as core.status.CityInfo;
}
function health(o: Partial<core.status.SupervisorHealth> = {}): core.status.SupervisorHealth {
  return {
    status: "ok",
    version: "dev",
    cities_total: 1,
    cities_running: 1,
    uptime_sec: 60,
    ...o,
  } as core.status.SupervisorHealth;
}
function fleet(o: Partial<core.status.FleetSnapshot>): core.status.FleetSnapshot {
  return { health: health(), cities: [], agentsByCity: {}, sessionsByCity: {}, partialErrors: [], ...o };
}

describe("core boundary is consumable from the web target", () => {
  it("reaches the status / beads / telemetry surfaces it renders", () => {
    expect(typeof core.status.fetchFleetSnapshot).toBe("function");
    expect(typeof core.status.supervisorLabel).toBe("function");
    expect(typeof core.beads.BeadsRepository).toBe("function");
    expect(typeof core.beads.deriveDisplayStatus).toBe("function");
    expect(typeof core.telemetry.TelemetryStore).toBe("function");
    expect(typeof core.telemetry.totalsSummary).toBe("function");
  });
});

describe("escapeHtml", () => {
  it("escapes all five HTML-significant characters", () => {
    expect(escapeHtml(`<a href="x" id='y'>&</a>`)).toBe(
      "&lt;a href=&quot;x&quot; id=&#39;y&#39;&gt;&amp;&lt;/a&gt;",
    );
  });
});

describe("noticeHtml", () => {
  it("renders the tone class and the shared factory's copy, escaped", () => {
    const html = noticeHtml(errorNotice("the fleet", "<boom>"));
    expect(html).toContain("notice--error");
    expect(html).toContain("Couldn&#39;t load the fleet.");
    expect(html).toContain("&lt;boom&gt;");
  });

  it("carries the loading tone and connecting copy", () => {
    const html = noticeHtml(loadingNotice());
    expect(html).toContain("notice--loading");
    expect(html).toContain("Connecting to supervisor…");
  });
});

describe("renderFleetPane", () => {
  it("shows the shared connecting copy while loading", () => {
    const html = renderFleetPane({ status: "loading" });
    expect(html).toContain("notice--loading");
    expect(html).toContain("Connecting to supervisor…");
  });

  it("shows a consistent error notice on failure", () => {
    const html = renderFleetPane({ status: "error", detail: "network down" });
    expect(html).toContain("notice--error");
    expect(html).toContain("Couldn&#39;t load the fleet.");
    expect(html).toContain("network down");
  });

  it("treats empty-cities-with-partial-errors as an error, not 'no cities'", () => {
    const html = renderFleetPane({
      status: "ready",
      data: fleet({ cities: [], partialErrors: ["cities: unreachable"] }),
    });
    expect(html).toContain("notice--error");
    expect(html).toContain("unreachable");
    expect(html).not.toContain("No cities registered");
  });

  it("shows the empty state when there are genuinely no cities", () => {
    const html = renderFleetPane({ status: "ready", data: fleet({ cities: [], partialErrors: [] }) });
    expect(html).toContain("notice--empty");
    expect(html).toContain("No cities registered");
  });

  it("renders supervisor, cities, agents and sessions", () => {
    const html = renderFleetPane({
      status: "ready",
      data: fleet({
        health: health({ status: "ok" }),
        cities: [city({ name: "alpha", running: true })],
        agentsByCity: { alpha: [agent({ name: "furiosa", state: "running" })] },
        sessionsByCity: { alpha: [session({ id: "sx", title: "build" })] },
      }),
    });
    expect(html).toContain("Supervisor");
    expect(html).toContain("alpha");
    expect(html).toContain("furiosa");
    expect(html).toContain("build");
  });

  it("surfaces partial errors alongside a populated fleet", () => {
    const html = renderFleetPane({
      status: "ready",
      data: fleet({ cities: [city({ name: "alpha" })], partialErrors: ["agents[beta]: timeout"] }),
    });
    expect(html).toContain("partial");
    expect(html).toContain("agents[beta]: timeout");
  });

  it("escapes city and agent names", () => {
    const html = renderFleetPane({
      status: "ready",
      data: fleet({
        cities: [city({ name: "<x>" })],
        agentsByCity: { "<x>": [agent({ name: "<script>", state: "idle", running: false })] },
      }),
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("marks a stopped city instead of listing agents", () => {
    const html = renderFleetPane({
      status: "ready",
      data: fleet({ cities: [city({ name: "beta", running: false })] }),
    });
    expect(html).toContain("beta");
    expect(html).toContain("stopped");
  });
});

describe("renderBeadsPane", () => {
  const explorer = (cities: core.beads.CityRecords[]): PaneView<core.beads.ExplorerData> => ({
    status: "ready",
    data: { cities },
  });

  it("loading and error use the shared vocabulary", () => {
    expect(renderBeadsPane({ status: "loading" })).toContain("Connecting to supervisor…");
    const err = renderBeadsPane({ status: "error", detail: "kaput" });
    expect(err).toContain("Couldn&#39;t load beads.");
    expect(err).toContain("kaput");
  });

  it("lists a city's beads and counts them", () => {
    const html = renderBeadsPane(
      explorer([
        {
          city: "alpha",
          running: true,
          partial: false,
          records: [makeRecord({ id: "b-7", title: "Wire the thing", priority: 1 }, true)],
        },
      ]),
    );
    expect(html).toContain("alpha");
    expect(html).toContain("b-7");
    expect(html).toContain("Wire the thing");
    expect(html).toContain("1 bead");
  });

  it("hides operational wisps and closed beads by default (mirrors the explorer)", () => {
    const html = renderBeadsPane(
      explorer([
        {
          city: "alpha",
          running: true,
          partial: false,
          records: [
            makeRecord({ id: "real-1", title: "Real work" }),
            makeRecord({ id: "gastown-wisp-abc", title: "nudge: wake up" }),
            makeRecord({ id: "done-1", title: "Done", status: "closed" }),
          ],
        },
      ]),
    );
    expect(html).toContain("real-1");
    expect(html).not.toContain("gastown-wisp-abc");
    expect(html).not.toContain("done-1");
    expect(html).toContain("1 bead");
  });

  it("shows the empty state when a running city has no visible beads", () => {
    const html = renderBeadsPane(
      explorer([{ city: "alpha", running: true, partial: false, records: [] }]),
    );
    expect(html).toContain("No open beads");
  });

  it("renders a per-city error notice", () => {
    const html = renderBeadsPane(
      explorer([{ city: "alpha", running: true, partial: false, records: [], error: "boom" }]),
    );
    expect(html).toContain("notice--error");
    expect(html).toContain("boom");
  });

  it("marks a stopped city", () => {
    const html = renderBeadsPane(
      explorer([{ city: "beta", running: false, partial: false, records: [] }]),
    );
    expect(html).toContain("stopped");
  });
});

describe("renderTelemetryPane", () => {
  function stateWith(ops: Array<Partial<core.telemetry.WorkerOperation>>): core.telemetry.TelemetryState {
    const store = new core.telemetry.TelemetryStore();
    ops.forEach((op, i) =>
      store.addOperation({
        seq: i + 1,
        ts: "",
        city: "alpha",
        agent: "furiosa",
        bead: "b-1",
        model: "opus",
        provider: "claude",
        operation: "session.submit",
        result: "ok",
        ok: true,
        durationMs: 1000,
        opId: `o${i}`,
        ...op,
      }),
    );
    return store.state;
  }

  it("loading and error use the shared vocabulary", () => {
    expect(renderTelemetryPane({ status: "loading" })).toContain("Connecting to supervisor…");
    expect(renderTelemetryPane({ status: "error", detail: "x" })).toContain("Couldn&#39;t load telemetry.");
  });

  it("shows the awaiting-events empty state before any operation lands", () => {
    const html = renderTelemetryPane({ status: "ready", data: stateWith([]) });
    expect(html).toContain("No operations observed yet");
  });

  it("renders rollups and the not-yet-measured advisory honestly", () => {
    const html = renderTelemetryPane({ status: "ready", data: stateWith([{}, {}]) });
    expect(html).toContain("furiosa"); // agent rollup
    expect(html).toContain("b-1"); // bead rollup
    expect(html).toContain("Token"); // advisory about absent token/cost data
    expect(html).toContain("By agent");
    expect(html).toContain("By bead");
  });

  it("drops the advisory once cost is measured", () => {
    const html = renderTelemetryPane({
      status: "ready",
      data: stateWith([{ promptTokens: 100, completionTokens: 50, costUsd: 0.01 }]),
    });
    expect(html).not.toContain("not yet reported");
  });

  // A synthetic state lets us drive the empty-scope and eviction branches the
  // store wouldn't naturally produce from a couple of operations.
  function syntheticState(over: Partial<core.telemetry.TelemetryState>): core.telemetry.TelemetryState {
    const tokens = { promptIn: 0, completionOut: 0, cacheCreation: 0, cacheRead: 0, measuredOps: 0 };
    return {
      agents: [],
      beads: [],
      totals: { operations: 1, succeeded: 1, failed: 0, durationMs: 0, tokens, costUsd: null, costMeasuredOps: 0, agents: 0, beads: 0 },
      stream: null,
      evicted: false,
      anyCostMeasured: false,
      connectivity: "live",
      ...over,
    };
  }

  it("shows a 'none yet' note when a scope list is empty despite operations", () => {
    const html = renderTelemetryPane({ status: "ready", data: syntheticState({}) });
    expect(html).toContain("none yet"); // both By agent and By bead lists are empty
  });

  it("notes evicted scopes once the cap is reached", () => {
    const html = renderTelemetryPane({
      status: "ready",
      data: syntheticState({ evicted: true, anyCostMeasured: true }),
    });
    expect(html).toContain("Older scopes dropped");
  });
});
