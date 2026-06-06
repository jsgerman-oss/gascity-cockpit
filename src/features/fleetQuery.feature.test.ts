/**
 * Coverage suite for the fleetQuery feature (cockpit-g5l.2).
 *
 * fleetQuery is stateless with respect to the connection: `activate()` wires a
 * single command that opens the natural-language fleet palette, loading a fresh
 * multi-city snapshot through the shared repository on demand. These tests drive
 * `register()` through the fake host and exercise the command's load path — the
 * empty/error branch (no client) and the happy "palette opened" branch.
 */
import { describe, expect, it } from "vitest";
import fleetQueryFeature from "./fleetQuery.feature.ts";
import { BeadsRepository } from "../beads/index.ts";
import { createTestbed } from "../test/fake-host.ts";

const CMD_OPEN = "gascityCockpit.fleetQuery.open";

describe("fleetQuery feature", () => {
  it("registers the open-palette command and nothing else", () => {
    const tb = createTestbed();
    tb.activate(fleetQueryFeature);

    expect(tb.hasCommand(CMD_OPEN)).toBe(true);
    expect(tb.subscriptions().length).toBe(1);
  });

  it("opens the palette and reports a load error when not connected", async () => {
    // No client → loadExplorer throws "API unavailable"; the palette closes and
    // surfaces the failure rather than hanging on a spinner.
    const tb = createTestbed();
    tb.activate(fleetQueryFeature);

    await tb.invokeCommand(CMD_OPEN);
    await tb.flush();

    // A QuickPick was created (and then hidden on the error).
    expect(tb.state.quickPicks.length).toBe(1);
    const errs = tb.errorMessages().map((m) => String(m.message));
    expect(errs.some((m) => m.includes("Fleet query — could not load beads"))).toBe(true);
  });

  it("renders rows when the repository returns beads", async () => {
    // Inject a repository whose loadExplorer resolves, so the palette reaches its
    // render path: busy clears and the result rows populate the QuickPick.
    const repository = {
      loadExplorer: () =>
        Promise.resolve({
          cities: [
            {
              city: "alpha",
              running: true,
              partial: false,
              records: [
                { city: "alpha", ready: true, bead: { id: "cockpit-1", title: "First", status: "open", issue_type: "task", created_at: "2026-06-01T00:00:00Z" } },
              ],
            },
          ],
        }),
    } as unknown as BeadsRepository;
    const tb = createTestbed({ repository });
    tb.activate(fleetQueryFeature);

    await tb.invokeCommand(CMD_OPEN);
    await tb.flush();

    const qp = tb.state.quickPicks[0];
    expect(qp).toBeDefined();
    expect(qp.busy).toBe(false);
    // The whole-fleet query (empty value) surfaces the one open bead.
    expect(qp.items.some((i) => (i as { label?: string }).label === "cockpit-1")).toBe(true);
  });
});
