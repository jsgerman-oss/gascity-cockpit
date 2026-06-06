// Merge logic for the per-feature `contributes` manifests.
//
// Each feature owns a `src/features/<id>.contributes.json` manifest declaring
// only the VS Code `contributes` slice it adds (commands, menus, views,
// configuration). This module loads them and merges them into the single
// `contributes` block that lives in `package.json`. `scripts/sync-contributes.mjs`
// writes the result; that is what makes features parallel-mergeable on
// `package.json` (cockpit-1ll.15): a feature edits its own manifest, never the
// shared file, and the merged result is regenerated.
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const MANIFEST_SUFFIX = '.contributes.json';

/**
 * The order features' contributions are concatenated in. Only matters where VS
 * Code honours array order rather than an explicit `group@order` — i.e. the
 * order tree **views** appear in the activity-bar container. `_core` (the shared
 * view container + base commands/config) is always first; any manifest not
 * listed here is appended alphabetically, which is fine for command/menu
 * contributions (those sort by `group@order`, not array position). Add a feature
 * here only when its view ordering matters.
 */
export const FEATURE_ORDER = [
  '_core',
  'chatView',
  'status',
  'beads',
  'telemetry',
  'codeNav',
  'formulaFlows',
  'chat',
  'dashboard',
  'extmsg',
  'mergeQueue',
];

/** Read every `*.contributes.json` under `featuresDir`, in merge order. */
export function loadManifests(featuresDir) {
  const files = readdirSync(featuresDir).filter((f) => f.endsWith(MANIFEST_SUFFIX));
  const manifests = files.map((file) => ({
    id: file.slice(0, -MANIFEST_SUFFIX.length),
    file,
    contributes: JSON.parse(readFileSync(resolve(featuresDir, file), 'utf8')),
  }));
  return orderManifests(manifests);
}

/** Sort manifests by {@link FEATURE_ORDER}; unlisted ones trail alphabetically. */
export function orderManifests(manifests) {
  const rank = (id) => {
    const i = FEATURE_ORDER.indexOf(id);
    return i === -1 ? FEATURE_ORDER.length : i;
  };
  return [...manifests].sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
}

/**
 * Merge ordered manifests into one `contributes` object. Object-of-array keys
 * (`viewsContainers`, `views`, `menus`) merge per sub-key; `commands` and
 * `chatParticipants` concatenate; `configuration` takes the first declared
 * `title` and unions `properties`. Keys are emitted in VS Code's conventional order.
 */
export function mergeContributes(manifests) {
  const viewsContainers = {};
  const views = {};
  const commands = [];
  const menus = {};
  const chatParticipants = [];
  let configTitle;
  const configProperties = {};
  let hasViewsContainers = false;
  let hasViews = false;
  let hasMenus = false;
  let hasConfiguration = false;

  for (const { contributes } of manifests) {
    if (contributes.viewsContainers) {
      hasViewsContainers = true;
      for (const [location, entries] of Object.entries(contributes.viewsContainers)) {
        (viewsContainers[location] ??= []).push(...entries);
      }
    }
    if (contributes.views) {
      hasViews = true;
      for (const [container, entries] of Object.entries(contributes.views)) {
        (views[container] ??= []).push(...entries);
      }
    }
    if (contributes.commands) commands.push(...contributes.commands);
    if (contributes.menus) {
      hasMenus = true;
      for (const [menu, entries] of Object.entries(contributes.menus)) {
        (menus[menu] ??= []).push(...entries);
      }
    }
    // `chatParticipants` is a flat array like `commands`: each entry is a
    // self-contained participant declaration, so concatenation is the whole merge.
    if (contributes.chatParticipants) chatParticipants.push(...contributes.chatParticipants);
    if (contributes.configuration) {
      hasConfiguration = true;
      if (configTitle === undefined && contributes.configuration.title) {
        configTitle = contributes.configuration.title;
      }
      Object.assign(configProperties, contributes.configuration.properties ?? {});
    }
  }

  const merged = {};
  if (hasViewsContainers) merged.viewsContainers = viewsContainers;
  if (hasViews) merged.views = views;
  if (commands.length) merged.commands = commands;
  if (hasMenus) merged.menus = menus;
  if (hasConfiguration) merged.configuration = { title: configTitle, properties: configProperties };
  // Appended last so adding it does not reorder the existing contributes keys.
  if (chatParticipants.length) merged.chatParticipants = chatParticipants;
  return merged;
}
