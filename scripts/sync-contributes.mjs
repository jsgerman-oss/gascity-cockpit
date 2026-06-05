#!/usr/bin/env node
// Regenerates `package.json`'s `contributes` block from the per-feature
// `src/features/*.contributes.json` manifests.
//
//   node scripts/sync-contributes.mjs          # rewrite package.json contributes
//   node scripts/sync-contributes.mjs --check   # fail if package.json is stale
//
// The manifests are the source of truth; this script is the mechanical merge.
// Features therefore never hand-edit the shared `contributes` block — they own a
// manifest and run this — which is what lets them merge in parallel (cockpit-1ll.15).
// `--check` is the CI/pre-push guard; `src/features/contributes.test.ts` enforces
// the same invariant under `npm run check`.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadManifests, mergeContributes } from './lib/contributes.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const featuresDir = resolve(root, 'src/features');
const packageJsonPath = resolve(root, 'package.json');

const check = process.argv.includes('--check');

const manifests = loadManifests(featuresDir);
const merged = mergeContributes(manifests);

const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
const current = JSON.stringify(pkg.contributes ?? null);
const next = JSON.stringify(merged);

if (check) {
  if (current === next) {
    console.log(`[contributes] in sync — ${manifests.length} manifest(s), ${merged.commands?.length ?? 0} command(s)`);
    process.exit(0);
  }
  console.error('[contributes] package.json is OUT OF SYNC with src/features/*.contributes.json');
  console.error('[contributes] run: npm run sync:contributes');
  process.exit(1);
}

if (current === next) {
  console.log('[contributes] already up to date — nothing to write');
  process.exit(0);
}

pkg.contributes = merged;
writeFileSync(packageJsonPath, JSON.stringify(pkg, null, 2) + '\n');
console.log(`[contributes] wrote package.json contributes from ${manifests.length} manifest(s)`);
