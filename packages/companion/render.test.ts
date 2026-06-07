// Presentation tests for the companion. render.ts is pure (state → HTML), so
// these drive it with hand-built FleetStatusState fixtures and assert the markup
// for every loading / empty / error / ready / reconnecting branch of both panes —
// no DOM, no network, no store.
import { describe, expect, it } from "vitest";
import * as core from "../../src/core/index.ts";
import {
  escapeHtml,
  formatClock,
  noticeHtml,
  renderEventsPane,
  renderHealthPane,
} from "./render.ts";

function state(overrides: Partial<core.status.FleetStatusState> = {}): core.status.FleetStatusState {
  return {
    health: null,
    cities: [],
    agentsByCity: {},
    sessionsByCity: {},
    events: [],
    partialErrors: [],
    eventStream: null,
    lastError: null,
    loading: false,
    connectivity: "live",
    ...overrides,
  };
}

const HEALTH = {
  status: "ok",
  version: "1.2.3",
  cities_running: 1,
  cities_total: 1,
  uptime_sec: 42,
} as core.status.SupervisorHealth;

const ALPHA = { name: "alpha", running: true } as core.status.CityInfo;
const BETA = { name: "beta", running: false } as core.status.CityInfo;
const AGENT = { name: "furiosa", state: "idle", running: false, available: true } as core.status.AgentResponse;
const SESSION = { id: "s1", state: "running", running: true } as core.status.SessionResponse;

function event(overrides: Partial<core.status.FleetEvent> = {}): core.status.FleetEvent {
  return { seq: 1, type: "session.updated", ts: "2026-06-06T19:00:00Z", actor: "furiosa", city: "alpha", ...overrides };
}

describe("escapeHtml", () => {
  it("escapes the five HTML-significant characters", () => {
    expect(escapeHtml(`<a href="x" & 'y'>`)).toBe("&lt;a href=&quot;x&quot; &amp; &#39;y&#39;&gt;");
  });
});

describe("noticeHtml", () => {
  it("renders the loading glyph and omits the detail line when absent", () => {
    const html = noticeHtml({ tone: "loading", label: "Connecting…", icon: "loading~spin" });
    expect(html).toContain("notice--loading");
    expect(html).toContain("◐");
    expect(html).toContain("Connecting…");
    expect(html).not.toContain("notice__detail");
  });

  it("renders the error glyph and the detail line when present", () => {
    const html = noticeHtml({ tone: "error", label: "Couldn't load.", detail: "why", icon: "error" });
    expect(html).toContain("notice--error");
    expect(html).toContain(">!<");
    expect(html).toContain("notice__detail");
    expect(html).toContain("why");
  });

  it("renders the neutral glyph for the empty tone", () => {
    const html = noticeHtml({ tone: "empty", label: "Nothing here", icon: "info" });
    expect(html).toContain("notice--empty");
    expect(html).toContain("·");
  });
});

describe("renderHealthPane", () => {
  it("shows the shared connecting row while loading", () => {
    const html = renderHealthPane(state({ loading: true }));
    expect(html).toContain("notice--loading");
    expect(html).toContain("Connecting to supervisor…");
  });

  it("shows a consistent error notice when a fatal error is set", () => {
    const html = renderHealthPane(state({ lastError: "boom" }));
    expect(html).toContain("notice--error");
    expect(html).toContain("Couldn&#39;t load the fleet.");
    expect(html).toContain("boom");
  });

  it("treats zero cities with partial errors as an error, not 'no cities'", () => {
    const html = renderHealthPane(state({ partialErrors: ["health: Network error", "cities: Network error"] }));
    expect(html).toContain("notice--error");
    expect(html).toContain("health: Network error · cities: Network error");
  });

  it("shows the empty notice when there are genuinely no cities", () => {
    const html = renderHealthPane(state());
    expect(html).toContain("notice--empty");
    expect(html).toContain("No cities registered");
  });

  it("renders supervisor health and a running city's agents and sessions", () => {
    const html = renderHealthPane(
      state({
        health: HEALTH,
        cities: [ALPHA],
        agentsByCity: { alpha: [AGENT] },
        sessionsByCity: { alpha: [SESSION] },
      }),
    );
    expect(html).toContain("supervisor");
    expect(html).toContain("Supervisor — ok");
    expect(html).toContain("alpha");
    expect(html).toContain("furiosa");
    expect(html).toContain("rows--sessions");
    expect(html).not.toContain("no agents");
  });

  it("notes a running city with no agents, and a stopped city", () => {
    const html = renderHealthPane(state({ cities: [ALPHA, BETA] }));
    expect(html).toContain("no agents");
    expect(html).toContain("stopped");
  });

  it("surfaces partial errors alongside the cities that did load", () => {
    const html = renderHealthPane(state({ cities: [ALPHA], partialErrors: ["agents[alpha]: timeout"] }));
    expect(html).toContain("partial");
    expect(html).toContain("agents[alpha]: timeout");
  });
});

describe("formatClock", () => {
  it("is blank for an absent timestamp", () => {
    expect(formatClock("")).toBe("");
  });
  it("returns the raw value when unparseable", () => {
    expect(formatClock("not-a-date")).toBe("not-a-date");
  });
  it("formats an RFC 3339 timestamp as HH:MM:SS", () => {
    expect(formatClock("2026-06-06T19:00:05Z")).toBe("19:00:05");
  });
});

describe("renderEventsPane", () => {
  it("shows the connecting row before the stream is up", () => {
    const html = renderEventsPane(state());
    expect(html).toContain("notice--loading");
    expect(html).toContain("Connecting to the event stream…");
  });

  it("shows the empty row when the stream is open but nothing has arrived", () => {
    const html = renderEventsPane(state({ eventStream: { state: "open", detail: "connected", attempt: 0 } }));
    expect(html).toContain("notice--empty");
    expect(html).toContain("No events yet");
    expect(html).toContain("Event stream — open");
  });

  it("renders the stream header in a reconnecting state with events retained", () => {
    const html = renderEventsPane(
      state({
        eventStream: { state: "reconnecting", detail: "retrying in 1200ms (attempt 3)", attempt: 3 },
        events: [event()],
      }),
    );
    expect(html).toContain("Event stream — reconnecting");
    expect(html).toContain("retrying in 1200ms (attempt 3)");
    expect(html).toContain("session.updated");
  });

  it("renders events newest-first with severity dots and a wall clock", () => {
    const html = renderEventsPane(
      state({
        eventStream: { state: "open", detail: "connected", attempt: 0 },
        events: [
          event({ seq: 3, type: "agent.crashed", message: "OOM" }),
          event({ seq: 2, type: "city.suspended" }),
          event({ seq: 1, type: "session.updated", ts: "" }),
        ],
      }),
    );
    expect(html).toContain("dot--error"); // agent.crashed
    expect(html).toContain("dot--warn"); // city.suspended
    expect(html).toContain("dot--ok"); // session.updated
    expect(html).toContain("19:00:00"); // formatted ts on the crashed/suspended events
    expect(html).toContain("OOM");
    // The third event has no ts → no <time> element rendered for it.
    expect((html.match(/event__time/g) ?? []).length).toBe(2);
  });
});
