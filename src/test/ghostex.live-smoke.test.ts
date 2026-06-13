/**
 * Live end-to-end smoke for the Ghostex foundation against a *running* gxserver.
 *
 * Skipped by default so `vitest run` (and CI) stay hermetic — there is no daemon
 * there, and these talk to a real one. Run it against a live gxserver with:
 *
 *   GHOSTEX_LIVE_SMOKE=1 npx vitest run src/test/ghostex.live-smoke.test.ts
 *
 * It drives the *real* foundation cores end-to-end — `discoverGhostex` (the
 * gxserver discovery handshake) and both `GxClient` transports (RPC over
 * 127.0.0.1:58744 and the `gx` CLI) — with no fakes, proving the Cockpit can
 * actually find and talk to Ghostex. This is the zmux-52e8d65a bring-up smoke
 * made repeatable: the one-command "is the live test target good?" check.
 *
 * Optional overrides: GASCITY_GXSERVER_URL points at a non-default daemon. The
 * bearer token is read from ~/.ghostex/gxserver/auth/token, mirroring the
 * extension's own discovery default.
 *
 * Note: `GxClient.cli().listProjects()` is deliberately not exercised — the `gx`
 * CLI has no `projects` subcommand (the project list rides on `gx sessions
 * --json`), so that one CLI mapping currently fails. listProjects is smoked over
 * RPC, which is the transport the Ghostex view drives.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_GXSERVER_BASE_URL,
  GXSERVER_PROTOCOL_VERSION,
  GxClient,
  discoverGhostex,
  type GhostexProject,
  type GhostexSession,
} from "../ghostex/index.ts";

const LIVE = process.env.GHOSTEX_LIVE_SMOKE === "1";
const baseUrl = (process.env.GASCITY_GXSERVER_URL ?? "").trim() || DEFAULT_GXSERVER_BASE_URL;
const tokenPath = join(homedir(), ".ghostex", "gxserver", "auth", "token");

/** Live calls hit a real daemon (and shell out to `gx`); give them headroom. */
const LIVE_TIMEOUT = 30_000;

async function readToken(): Promise<string> {
  return (await readFile(tokenPath, "utf8")).trim();
}

/** Every projected session must carry the identity fields the Cockpit keys on. */
function expectIdentified(session: GhostexSession): void {
  expect(session.sessionId).toBeTruthy();
  expect(session.projectId).toBeTruthy();
}

describe.skipIf(!LIVE)("ghostex live smoke (against a running gxserver)", () => {
  it(
    "discovery handshake resolves a connected gxserver on the pinned protocol",
    async () => {
      const discovery = await discoverGhostex({
        settingsUrl: baseUrl,
        tokenPath,
        readTokenFile: (p) => readFile(p, "utf8"),
      });
      expect(discovery.state).toBe("connected");
      if (discovery.state !== "connected") return; // narrow for the type-checker
      expect(discovery.health.product).toBe("gxserver");
      expect(discovery.health.protocolVersion).toBe(GXSERVER_PROTOCOL_VERSION);
      expect(discovery.endpoint.baseUrl).toBeTruthy();
    },
    LIVE_TIMEOUT,
  );

  it(
    "RPC transport: listSessions + listProjects project onto domain types",
    async () => {
      const client = GxClient.rpc({ baseUrl, token: await readToken() });

      const sessions = await client.listSessions();
      expect(Array.isArray(sessions)).toBe(true);
      sessions.forEach(expectIdentified);

      const projects = await client.listProjects();
      expect(Array.isArray(projects)).toBe(true);
      projects.forEach((p: GhostexProject) => expect(p.projectId).toBeTruthy());
    },
    LIVE_TIMEOUT,
  );

  it(
    "CLI transport: `gx sessions --json` projects onto domain sessions",
    async () => {
      const client = GxClient.cli();
      const sessions = await client.listSessions();
      expect(Array.isArray(sessions)).toBe(true);
      sessions.forEach(expectIdentified);
    },
    LIVE_TIMEOUT,
  );
});
