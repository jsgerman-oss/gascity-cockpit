/**
 * Coverage for the worktree code-lens feature (cockpit-g5l.3, batch B).
 *
 * The feature registers the lens glue and refreshes its index whenever the
 * supervisor connection (re)connects or restarts. We stub the repository's
 * `loadExplorer` (the lens's one data source) so a refresh is a counted, no-op
 * resolve — no real git, no sockets — and assert the connection-reaction logic:
 * a fresh connect refreshes, a steady reconnect-poll does not, and a detected
 * restart does. `disposeAll` tears down the controller's refresh interval.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import worktreeLensFeature from "./worktreeLens.feature.ts";
import { BeadsRepository } from "../beads/index.ts";
import { createTestbed, type Testbed } from "../test/fake-host.ts";

const SHOW = "gascityCockpit.worktreeLens.show";
const REFRESH = "gascityCockpit.worktreeLens.refresh";

afterEach(() => vi.restoreAllMocks());

/**
 * Stub `loadExplorer` (a refresh resolves to an empty fleet: counted, but no git
 * or network), activate the feature, and let the controller's initial refresh
 * settle. Returns the testbed and the load spy.
 */
async function activated(): Promise<{
  tb: Testbed;
  loadExplorer: ReturnType<typeof spyLoad>;
}> {
  const loadExplorer = spyLoad();
  const tb = createTestbed();
  tb.activate(worktreeLensFeature);
  await tb.flush();
  return { tb, loadExplorer };
}

function spyLoad() {
  return vi.spyOn(BeadsRepository.prototype, "loadExplorer").mockResolvedValue({ cities: [] });
}

describe("worktreeLens feature", () => {
  it("registers its commands and the lens/decoration providers", async () => {
    const { tb, loadExplorer } = await activated();

    expect(tb.hasCommand(SHOW)).toBe(true);
    expect(tb.hasCommand(REFRESH)).toBe(true);
    expect(tb.state.codeLensProviders).toHaveLength(1);
    expect(tb.state.fileDecorationProviders).toHaveLength(1);
    // Activation kicks one immediate refresh.
    expect(loadExplorer).toHaveBeenCalled();

    tb.disposeAll();
    expect(tb.hasCommand(SHOW)).toBe(false);
    expect(tb.hasCommand(REFRESH)).toBe(false);
  });

  it("refreshes the index on a fresh supervisor connection", async () => {
    const { tb, loadExplorer } = await activated();
    const before = loadExplorer.mock.calls.length;

    tb.emitStatus("connected"); // prevState null → justConnected
    await tb.flush();

    expect(loadExplorer.mock.calls.length).toBeGreaterThan(before);
    tb.disposeAll();
  });

  it("does not refresh while an already-connected supervisor stays connected", async () => {
    const { tb, loadExplorer } = await activated();
    tb.emitStatus("connected");
    await tb.flush();
    const settled = loadExplorer.mock.calls.length;

    tb.emitStatus("connected"); // prevState connected, not restarted → no refresh
    await tb.flush();

    expect(loadExplorer.mock.calls.length).toBe(settled);
    tb.disposeAll();
  });

  it("refreshes again when the supervisor restarts", async () => {
    const { tb, loadExplorer } = await activated();
    tb.emitStatus("connected");
    await tb.flush();
    const settled = loadExplorer.mock.calls.length;

    tb.emitStatus("connected", { restarted: true }); // restart → refresh despite staying connected
    await tb.flush();

    expect(loadExplorer.mock.calls.length).toBeGreaterThan(settled);
    tb.disposeAll();
  });

  it("ignores connection transitions that are neither a connect nor a restart", async () => {
    const { tb, loadExplorer } = await activated();
    const before = loadExplorer.mock.calls.length;

    tb.emitStatus("connecting");
    tb.emitStatus("unavailable");
    await tb.flush();

    expect(loadExplorer.mock.calls.length).toBe(before);
    tb.disposeAll();
  });

  it("refreshes on demand via the refresh command", async () => {
    const { tb, loadExplorer } = await activated();
    const before = loadExplorer.mock.calls.length;

    await tb.invokeCommand(REFRESH);
    await tb.flush();

    expect(loadExplorer.mock.calls.length).toBeGreaterThan(before);
    tb.disposeAll();
  });

  it("reports when no other worktree is editing a file (show command)", async () => {
    const { tb } = await activated();

    await tb.invokeCommand(SHOW, "src/answer.ts");

    expect(tb.infoMessages().map((m) => m.message)).toContain(
      "No other worktree is editing src/answer.ts right now.",
    );
    tb.disposeAll();
  });
});
