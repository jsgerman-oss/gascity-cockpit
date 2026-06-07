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

/** The two read-only surfaces this first companion slice renders. */
export type PaneId = "health" | "events";

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

  const partial = state.partialErrors.length
    ? `<div class="partial" role="status"><span class="partial__glyph" aria-hidden="true">!</span>` +
      `<ul class="partial__list">${state.partialErrors.map((e) => `<li>${escapeHtml(e)}</li>`).join("")}</ul></div>`
    : "";

  return `${header}${partial}<div class="cities">${cities}</div>`;
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
