// Pure presentation for the web companion: a plain state snapshot → an HTML
// string. No `document`, no `window`, no I/O — app.ts drives the shared
// FleetStatusStore over `/v0` and hands the typed state here, so every builder
// stays decoupled and unit-testable with plain fixtures (render.test.ts), the
// same render/app/main split the CLI and web targets use (docs/core-boundary.md).
//
// The whole point of the companion epic is reuse (docs/companion-surfaces.md): the
// model is the extension's own `core.status.FleetStatusStore` (city health +
// event feed over SSE — NOT a copy), the per-row copy comes from the same `core`
// status formatters the editor panes use, and the loading / empty / error rows
// come from the shared cross-pane vocabulary (`src/ui`, docs/cross-pane-states.md)
// so a companion pane and an editor pane read in the same key.
import * as core from "../../src/core/index.ts";
import {
  type StateNotice,
  emptyNotice,
  errorNotice,
  loadingNotice,
} from "../../src/ui/index.ts";

/** The read-only surfaces the companion renders. */
export type PaneId = "health" | "agents" | "sessions" | "events";

/** Escape the five HTML-significant characters; every dynamic string passes through here. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

/** A short glyph per tone — the browser analogue of the editor's codicon, kept aria-hidden. */
function toneGlyph(tone: StateNotice["tone"]): string {
  switch (tone) {
    case "loading":
      return "◐";
    case "error":
      return "!";
    case "empty":
    default:
      return "·";
  }
}

/**
 * Render one cross-pane {@link StateNotice} (loading / empty / error). The tone
 * drives the CSS class so two panes in the same state look identical, and the
 * label/detail copy is whatever the shared `view-state` factories baked.
 */
export function noticeHtml(notice: StateNotice): string {
  const detail = notice.detail
    ? `<p class="notice__detail">${escapeHtml(notice.detail)}</p>`
    : "";
  return (
    `<div class="notice notice--${notice.tone}" role="status">` +
    `<span class="notice__glyph" aria-hidden="true">${toneGlyph(notice.tone)}</span>` +
    `<div class="notice__body"><p class="notice__label">${escapeHtml(notice.label)}</p>${detail}</div>` +
    `</div>`
  );
}

/** A small status dot whose colour comes from the shared `StatusKind` ladder. */
function dot(kind: core.status.StatusKind): string {
  return `<span class="dot dot--${kind}" aria-hidden="true"></span>`;
}

// ---- city health -----------------------------------------------------------

function agentRowHtml(agent: core.status.AgentResponse): string {
  return (
    `<li class="row">${dot(core.status.agentStatusKind(agent))}` +
    `<span class="row__label">${escapeHtml(core.status.agentLabel(agent))}</span>` +
    `<span class="row__detail">${escapeHtml(core.status.agentDescription(agent))}</span></li>`
  );
}

function sessionRowHtml(session: core.status.SessionResponse): string {
  return (
    `<li class="row">${dot(core.status.sessionStatusKind(session))}` +
    `<span class="row__label">${escapeHtml(core.status.sessionLabel(session))}</span>` +
    `<span class="row__detail">${escapeHtml(core.status.sessionDescription(session))}</span></li>`
  );
}

function cityBlockHtml(
  city: core.status.CityInfo,
  agents: core.status.AgentResponse[],
  sessions: core.status.SessionResponse[],
): string {
  const head =
    `<div class="city__head">${dot(core.status.cityStatusKind(city))}` +
    `<span class="city__name">${escapeHtml(core.status.cityLabel(city))}</span>` +
    `<span class="city__detail">${escapeHtml(core.status.cityDescription(city))}</span></div>`;

  if (!city.running) {
    return `<section class="city">${head}<p class="city__note">stopped</p></section>`;
  }

  const agentList = agents.length
    ? `<ul class="rows">${agents.map(agentRowHtml).join("")}</ul>`
    : `<p class="city__note">no agents</p>`;
  const sessionList = sessions.length
    ? `<ul class="rows rows--sessions">${sessions.map(sessionRowHtml).join("")}</ul>`
    : "";

  return `<section class="city">${head}${agentList}${sessionList}</section>`;
}

/**
 * The City Health pane body: supervisor health, then every city's agents and
 * sessions. Reads the snapshot-derived slice of the live store state, mapping
 * the store's loading / error / empty conditions onto the shared notices so the
 * pane reads the same as the editor's Fleet tree (cockpit-1ll.16: a dead
 * supervisor surfaces as an honest error, never a misleading "no cities").
 */
export function renderHealthPane(state: core.status.FleetStatusState): string {
  if (state.loading) return noticeHtml(loadingNotice());
  if (state.lastError) return noticeHtml(errorNotice("the fleet", state.lastError));

  if (state.cities.length === 0) {
    // `fetchFleetSnapshot` never throws — a dead supervisor surfaces as zero
    // cities plus the failed calls in `partialErrors`. Treat that as an error
    // (not a misleading "no cities") so an unreachable supervisor reads honestly.
    return state.partialErrors.length
      ? noticeHtml(errorNotice("the fleet", state.partialErrors.join(" · ")))
      : noticeHtml(emptyNotice("No cities registered"));
  }

  const header =
    `<div class="supervisor">${dot(core.status.supervisorStatusKind(state.health))}` +
    `<span class="supervisor__label">${escapeHtml(core.status.supervisorLabel(state.health))}</span>` +
    `<span class="supervisor__detail">${escapeHtml(core.status.supervisorDescription(state.health))}</span></div>`;

  const cities = state.cities
    .map((city) =>
      cityBlockHtml(
        city,
        state.agentsByCity[city.name] ?? [],
        state.sessionsByCity[city.name] ?? [],
      ),
    )
    .join("");

  const partial = partialBannerHtml(state.partialErrors);

  return `${header}${partial}<div class="cities">${cities}</div>`;
}

// ---- agents & sessions (fleet-wide read surfaces) --------------------------

/** The shared "some calls failed but others loaded" banner; "" when there are none. */
function partialBannerHtml(partialErrors: string[]): string {
  if (!partialErrors.length) return "";
  return (
    `<div class="partial" role="status"><span class="partial__glyph" aria-hidden="true">!</span>` +
    `<ul class="partial__list">${partialErrors.map((e) => `<li>${escapeHtml(e)}</li>`).join("")}</ul></div>`
  );
}

/**
 * Flatten a city-keyed map (agentsByCity / sessionsByCity) into a single
 * fleet-wide list in city order, tagging each item with the city it came from.
 * The dedicated Agents / Sessions panes are the entity-centric counterpart to
 * the city-centric Health pane: one scannable column across the whole fleet
 * instead of rows nested two levels deep under each city.
 */
function flattenByCity<T>(
  cities: core.status.CityInfo[],
  byCity: Record<string, T[]>,
): Array<{ city: string; item: T }> {
  const rows: Array<{ city: string; item: T }> = [];
  for (const city of cities) {
    for (const item of byCity[city.name] ?? []) rows.push({ city: city.name, item });
  }
  return rows;
}

/** A right-aligned city tag for a fleet-wide row; only shown when the fleet has more than one city. */
function cityTagHtml(city: string, show: boolean): string {
  return show ? `<span class="row__city">${escapeHtml(city)}</span>` : "";
}

function agentFlatRowHtml(city: string, agent: core.status.AgentResponse, showCity: boolean): string {
  return (
    `<li class="row">${dot(core.status.agentStatusKind(agent))}` +
    `<span class="row__label">${escapeHtml(core.status.agentLabel(agent))}</span>` +
    `<span class="row__detail">${escapeHtml(core.status.agentDescription(agent))}</span>` +
    `${cityTagHtml(city, showCity)}</li>`
  );
}

function sessionFlatRowHtml(city: string, session: core.status.SessionResponse, showCity: boolean): string {
  return (
    `<li class="row">${dot(core.status.sessionStatusKind(session))}` +
    `<span class="row__label">${escapeHtml(core.status.sessionLabel(session))}</span>` +
    `<span class="row__detail">${escapeHtml(core.status.sessionDescription(session))}</span>` +
    `${cityTagHtml(city, showCity)}</li>`
  );
}

/**
 * The loading / error / empty ladder the snapshot-backed panes share, mapped
 * onto the cross-pane notice vocabulary exactly as renderHealthPane does: a
 * first load in flight is the shared connecting row; a fatal error is the shared
 * "Couldn't load <resource>" row; and once the snapshot has landed, no rows
 * means either a genuinely empty fleet (the empty row) or — when the supervisor
 * was unreachable and every call failed — an error carrying the partial-failure
 * detail (cockpit-1ll.16: never a misleading "nothing here" for a dead API).
 *
 * Returns the notice HTML to render *instead of* content, or null when the pane
 * has rows to show. The companion drives this off `loading`/`lastError`, not
 * `connectivity`: LiveStatus — unlike the editor's ConnectionManager — does not
 * project connectivity into the store, so the canonical resolvePaneState machine
 * cannot be used here; this mirrors the scaffold's health ladder instead.
 */
function snapshotNotice(
  state: core.status.FleetStatusState,
  resource: string,
  hasRows: boolean,
  empty: { label: string; detail?: string },
): string | null {
  if (state.loading) return noticeHtml(loadingNotice());
  if (state.lastError) return noticeHtml(errorNotice(resource, state.lastError));
  if (hasRows) return null;
  return state.partialErrors.length
    ? noticeHtml(errorNotice(resource, state.partialErrors.join(" · ")))
    : noticeHtml(emptyNotice(empty.label, empty.detail));
}

/**
 * The Agents pane body: every agent across the fleet as one flat list, in city
 * order, each row carrying the shared status dot + the same agent
 * label/description formatters the editor's Fleet tree uses. Loading / error /
 * empty come from {@link snapshotNotice}; a city tag distinguishes agents when
 * more than one city is registered.
 */
export function renderAgentsPane(state: core.status.FleetStatusState): string {
  const rows = flattenByCity(state.cities, state.agentsByCity);
  const notice = snapshotNotice(state, "agents", rows.length > 0, {
    label: "No agents",
    detail: "Agents appear here as the fleet registers them.",
  });
  if (notice) return notice;

  const showCity = state.cities.length > 1;
  const list = `<ul class="rows">${rows.map(({ city, item }) => agentFlatRowHtml(city, item, showCity)).join("")}</ul>`;
  return `${partialBannerHtml(state.partialErrors)}${list}`;
}

/**
 * The Sessions pane body: every live session across the fleet as one flat list,
 * the session-centric counterpart to the Agents pane. Same shared formatters,
 * dots, and loading / error / empty vocabulary; sessions are not dimmed here (in
 * the Health pane they sit secondary under each city's agents).
 */
export function renderSessionsPane(state: core.status.FleetStatusState): string {
  const rows = flattenByCity(state.cities, state.sessionsByCity);
  const notice = snapshotNotice(state, "sessions", rows.length > 0, {
    label: "No sessions",
    detail: "Live sessions appear here as agents start work.",
  });
  if (notice) return notice;

  const showCity = state.cities.length > 1;
  const list = `<ul class="rows">${rows.map(({ city, item }) => sessionFlatRowHtml(city, item, showCity)).join("")}</ul>`;
  return `${partialBannerHtml(state.partialErrors)}${list}`;
}

// ---- event feed ------------------------------------------------------------

/** A wall-clock `HH:MM:SS` from an RFC 3339 timestamp; the raw value if unparseable, blank if absent. */
export function formatClock(ts: string): string {
  if (!ts) return "";
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? ts : new Date(ms).toISOString().slice(11, 19);
}

function eventRowHtml(event: core.status.FleetEvent): string {
  const clock = formatClock(event.ts);
  const time = clock ? `<time class="event__time">${escapeHtml(clock)}</time>` : "";
  return (
    `<li class="event">${dot(core.status.eventStatusKind(event.type))}${time}` +
    `<span class="event__type">${escapeHtml(core.status.eventLabel(event))}</span>` +
    `<span class="event__detail">${escapeHtml(core.status.eventDescription(event))}</span></li>`
  );
}

/**
 * The Event Feed pane body: the live SSE subscription's status, then the recent
 * events (newest first), straight from the store's event ring buffer. The feed
 * is event-sourced and independent of the snapshot poll, so its states key off
 * the stream status, not the snapshot's `loading` flag: no stream yet (or
 * connecting / reconnecting) shows the shared connecting row; an open stream with
 * nothing yet shows the empty row; once events land they replace it.
 */
export function renderEventsPane(state: core.status.FleetStatusState): string {
  const stream = state.eventStream;
  const header = stream
    ? `<div class="supervisor">${dot(core.status.eventStreamStatusKind(stream))}` +
      `<span class="supervisor__label">Event stream — ${escapeHtml(stream.state)}</span>` +
      `<span class="supervisor__detail">${escapeHtml(stream.detail)}</span></div>`
    : "";

  let body: string;
  if (state.events.length) {
    body = `<ul class="events">${state.events.map(eventRowHtml).join("")}</ul>`;
  } else if (stream && stream.state === "open") {
    body = noticeHtml(emptyNotice("No events yet", "Events appear here as the fleet emits them."));
  } else {
    body = noticeHtml(loadingNotice("Connecting to the event stream…"));
  }

  return `${header}${body}`;
}
