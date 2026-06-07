// Guards the per-feature contributes manifests against package.json.
//
// The manifests (`src/features/*.contributes.json`) are the source of truth;
// `scripts/sync-contributes.mjs` merges them into package.json's `contributes`.
// This test re-derives the merge independently (so a bug in the script can't
// hide drift) and asserts package.json is exactly the union of the manifests,
// that command declarations are unique and that every menu reference resolves.
// It runs under `npm run check`, so a stale package.json fails the pre-push gate.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const featuresDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(featuresDir, "..", "..");

const SUFFIX = ".contributes.json";

interface Manifest {
  id: string;
  contributes: Record<string, unknown>;
}

function loadManifests(): Manifest[] {
  return readdirSync(featuresDir)
    .filter((f) => f.endsWith(SUFFIX))
    .sort()
    .map((file) => ({
      id: file.slice(0, -SUFFIX.length),
      contributes: JSON.parse(readFileSync(resolve(featuresDir, file), "utf8")),
    }));
}

const manifests = loadManifests();
const pkg = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));
const contributes = pkg.contributes as Record<string, unknown>;

/** A multiset of objects compared independent of order. */
function bag(entries: unknown[]): string[] {
  return entries.map((e) => JSON.stringify(e)).sort();
}

/** Collect every manifest's entries for an object-of-arrays key (views, menus, …). */
function collectGrouped(key: string): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const { contributes: c } of manifests) {
    const group = c[key] as Record<string, unknown[]> | undefined;
    if (!group) continue;
    for (const [sub, entries] of Object.entries(group)) {
      (out[sub] ??= []).push(...entries);
    }
  }
  return out;
}

/** Collect every manifest's entries for a top-level array key (commands). */
function collectArray(key: string): unknown[] {
  return manifests.flatMap(({ contributes: c }) => (c[key] as unknown[] | undefined) ?? []);
}

describe("contributes manifests", () => {
  it("declares every command exactly once across manifests", () => {
    const seen = new Map<string, string>();
    for (const { id, contributes: c } of manifests) {
      for (const cmd of (c.commands as { command: string }[] | undefined) ?? []) {
        const prior = seen.get(cmd.command);
        expect(prior, `${cmd.command} declared by both ${prior} and ${id}`).toBeUndefined();
        seen.set(cmd.command, id);
      }
    }
  });

  it("merges to exactly package.json commands", () => {
    expect(bag(collectArray("commands"))).toEqual(bag(contributes.commands as unknown[]));
  });

  it("merges to exactly package.json chatParticipants", () => {
    expect(bag(collectArray("chatParticipants"))).toEqual(
      bag((contributes.chatParticipants as unknown[] | undefined) ?? []),
    );
  });

  it("declares every chat participant id exactly once", () => {
    const seen = new Map<string, string>();
    for (const { id, contributes: c } of manifests) {
      for (const p of (c.chatParticipants as { id: string }[] | undefined) ?? []) {
        const prior = seen.get(p.id);
        expect(prior, `${p.id} declared by both ${prior} and ${id}`).toBeUndefined();
        seen.set(p.id, id);
      }
    }
  });

  it("merges to exactly package.json views, viewsContainers and menus", () => {
    for (const key of ["views", "viewsContainers", "menus"] as const) {
      const merged = collectGrouped(key);
      const actual = (contributes[key] as Record<string, unknown[]>) ?? {};
      expect(Object.keys(merged).sort()).toEqual(Object.keys(actual).sort());
      for (const sub of Object.keys(merged)) {
        expect(bag(merged[sub]), `${key}.${sub}`).toEqual(bag(actual[sub]));
      }
    }
  });

  it("merges to exactly package.json configuration properties", () => {
    const merged: Record<string, unknown> = {};
    for (const { contributes: c } of manifests) {
      const config = c.configuration as { properties?: Record<string, unknown> } | undefined;
      Object.assign(merged, config?.properties ?? {});
    }
    const actual = (contributes.configuration as { properties: Record<string, unknown> }).properties;
    expect(bag(Object.entries(merged))).toEqual(bag(Object.entries(actual)));
  });

  it("only references commands that are declared", () => {
    const declared = new Set((contributes.commands as { command: string }[]).map((c) => c.command));
    const menus = contributes.menus as Record<string, { command: string }[]>;
    for (const [menu, entries] of Object.entries(menus)) {
      for (const entry of entries) {
        expect(declared.has(entry.command), `${menu} references unknown ${entry.command}`).toBe(true);
      }
    }
  });

  it("preserves the activity-bar view order", () => {
    const ids = (contributes.views as Record<string, { id: string }[]>).gascityCockpit.map((v) => v.id);
    expect(ids).toEqual([
      "gascityCockpit.chatView",
      "gascityCockpit.fleet",
      "gascityCockpit.events",
      "gascityCockpit.beads",
      "gascityCockpit.telemetry",
      "gascityCockpit.metrics",
      "gascityCockpit.mergeQueue",
    ]);
  });

  it("pairs each non-core manifest with a feature module", () => {
    for (const { id } of manifests) {
      if (id === "_core") continue;
      expect(existsSync(resolve(featuresDir, `${id}.feature.ts`)), `${id}.feature.ts missing`).toBe(true);
    }
  });
});
