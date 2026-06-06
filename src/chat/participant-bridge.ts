// The vscode-free core of the native `@mayor` chat participant (cockpit-dc8.2).
//
// VS Code's own chat window is markdown-oriented: a participant answers a request
// by streaming `markdown` / `progress` parts into a response. This module turns
// one such request into a turn against a Mayor session, reusing the same
// `ConversationStore` the rich webview chat is built on — it forwards the prompt
// to `POST /session/{id}/submit` and projects the live per-session stream
// (`turn` snapshots + `activity`) back as append-only markdown deltas.
//
// Like the rest of the chat core it imports no `vscode` (PRD Seam 1): the editor
// glue in `src/features/chatParticipant.feature.ts` is the thin layer that maps
// the {@link ParticipantSink} onto a `ChatResponseStream` and renders a
// {@link TurnOutcome}. Everything worth testing — the assistant-text projection
// and the turn lifecycle — lives here and is unit-tested against a fake store.
import {
  awaitSubmitOutcome as defaultAwaitSubmitOutcome,
  type ApiResult,
  type AsyncAccepted,
  type ConversationTurn,
  type PendingInteraction,
  type StreamEndpoint,
  type SubmitIntent,
} from "../api/index.ts";
import type { Disposable } from "../discovery/index.ts";
import type { ConversationState } from "./conversation-store.ts";

/** Where the bridge pushes a turn's output. Mapped onto a `ChatResponseStream`. */
export interface ParticipantSink {
  /** Append assistant markdown (the streamed reply). */
  markdown(text: string): void;
  /** A transient progress note (e.g. "The Mayor is working…"). */
  progress(text: string): void;
}

/** The slice of {@link ConversationStore} the bridge drives. */
export interface ParticipantStore {
  readonly state: ConversationState;
  onDidChange(listener: (state: ConversationState) => void): Disposable;
  /** Load a snapshot then open the live stream. */
  start(): Promise<void>;
  /** Submit the prompt to the live loop. */
  submit(message: string, intent?: SubmitIntent): Promise<ApiResult<AsyncAccepted>>;
}

/** How a participant turn ended. */
export type TurnOutcome =
  | { status: "completed" }
  /** The agent is awaiting an approval/input the markdown UI can't host — hand off to the panel. */
  | { status: "pending"; pending: PendingInteraction }
  | { status: "error"; message: string }
  | { status: "cancelled" };

/**
 * Concatenate the text of every non-`user` turn from `baseline` onward. Pure.
 * The user's own prompt echoes back as a `user` turn in the live snapshot; it is
 * filtered out so the participant never re-prints what the operator just typed.
 */
export function assistantTextSince(turns: readonly ConversationTurn[], baseline: number): string {
  return turns
    .slice(Math.max(0, baseline))
    .filter((turn) => turn.role !== "user")
    .map((turn) => turn.text)
    .filter((text) => text.length > 0)
    .join("\n\n");
}

/**
 * Append-only projector over the growing conversation. `next` is called with each
 * full `turns` snapshot and returns only the assistant text not yet emitted, so
 * the participant streams deltas rather than re-printing the whole reply.
 *
 * The per-session `turn` events carry monotonically-growing snapshots, so the
 * common case is a clean append (the new text extends what we showed). A
 * non-append update (a rare mid-turn rewrite, or a shrink) re-syncs silently
 * rather than duplicating already-shown text.
 */
export class AssistantDelta {
  private emitted = "";

  constructor(private readonly baseline: number) {}

  next(turns: readonly ConversationTurn[]): string {
    const full = assistantTextSince(turns, this.baseline);
    if (full.length > this.emitted.length && full.startsWith(this.emitted)) {
      const delta = full.slice(this.emitted.length);
      this.emitted = full;
      return delta;
    }
    // Diverged or shrank — re-sync without re-emitting text the operator has seen.
    if (full.length > this.emitted.length) {
      this.emitted = full;
    }
    return "";
  }
}

/**
 * Render a pending interaction as markdown for the chat surface. The native chat
 * window can't host the rich approval webview, so the feature pairs this with a
 * command button that deep-links into the full {@link ChatPanel}.
 */
export function describePending(pending: PendingInteraction): string {
  const kind = pending.kind ? pending.kind.replace(/[-_]/g, " ") : "input";
  const lines = [`**The Mayor needs your input** — ${kind}.`];
  if (pending.prompt && pending.prompt.trim()) {
    lines.push("", pending.prompt.trim());
  }
  if (pending.options && pending.options.length > 0) {
    lines.push("", `Options: ${pending.options.map((option) => `\`${option}\``).join(", ")}`);
  }
  return lines.join("\n");
}

export interface DriveTurnOptions {
  store: ParticipantStore;
  /** Endpoint for the city-event correlation that backstops turn completion. */
  endpoint: StreamEndpoint;
  prompt: string;
  intent?: SubmitIntent;
  /** Aborts the turn (the chat request's cancellation token). */
  signal: AbortSignal;
  sink: ParticipantSink;
  /** Injectable city-event correlation; defaults to the real one. */
  awaitSubmitOutcome?: typeof defaultAwaitSubmitOutcome;
}

/**
 * Drive one participant turn to completion: start the store, submit the prompt,
 * stream assistant deltas into the sink, and resolve with how the turn ended.
 *
 * Completion is detected from the per-session stream the store already applies —
 * an `in-turn → idle` activity transition means the reply is finished, and
 * because turns and activity arrive over the same ordered SSE stream the final
 * `turn` snapshot is already applied by then. The city-event outcome correlation
 * backstops providers that don't emit activity and surfaces server-side failures.
 * A `pending` interaction stops the turn so the operator can answer in the rich
 * panel. All completion signals are event-driven — no timers — so the turn never
 * hangs past the request's cancellation token.
 */
export async function driveTurn(options: DriveTurnOptions): Promise<TurnOutcome> {
  const { store, endpoint, prompt, sink, signal } = options;
  const intent = options.intent ?? "default";
  const awaitOutcome = options.awaitSubmitOutcome ?? defaultAwaitSubmitOutcome;

  if (signal.aborted) {
    return { status: "cancelled" };
  }

  sink.progress("Connecting to the Mayor…");
  await store.start();
  if (signal.aborted) {
    return { status: "cancelled" };
  }

  const baseline = store.state.turns.length;
  const delta = new AssistantDelta(baseline);

  const accepted = await store.submit(prompt, intent);
  if (!accepted.ok) {
    return { status: "error", message: accepted.error.detail ?? accepted.error.title };
  }

  return await new Promise<TurnOutcome>((resolve) => {
    let settled = false;
    let sawInTurn = false;
    let progressed = false;

    const emitDelta = (): void => {
      const text = delta.next(store.state.turns);
      if (text) {
        sink.markdown(text);
      }
    };

    const finish = (outcome: TurnOutcome): void => {
      if (settled) {
        return;
      }
      settled = true;
      emitDelta(); // flush any final assistant text before resolving
      cleanup();
      resolve(outcome);
    };

    const onState = (state: ConversationState): void => {
      emitDelta();

      if (state.activity === "in-turn") {
        sawInTurn = true;
        if (!progressed) {
          sink.progress("The Mayor is working…");
          progressed = true;
        }
      }

      // A tool-approval / prompt-for-input can't be answered in the markdown UI.
      if (state.pending) {
        finish({ status: "pending", pending: state.pending });
        return;
      }
      if (state.connection === "error" && state.lastError) {
        finish({ status: "error", message: state.lastError });
        return;
      }
      // Reply finished: the agent worked, then settled back to idle.
      if (sawInTurn && state.activity === "idle") {
        finish({ status: "completed" });
        return;
      }
      // The per-session stream closed (server ended it).
      if (state.connection === "closed") {
        finish({ status: "completed" });
        return;
      }
    };

    const subscription = store.onDidChange(onState);
    onState(store.state); // apply the current state (covers a finish before we subscribed)

    const onAbort = (): void => finish({ status: "cancelled" });
    signal.addEventListener("abort", onAbort);

    // Backstop completion: watch the city event stream for this request's terminal
    // outcome. Covers providers that never emit activity, and turns failures the
    // per-session stream doesn't surface into a clear error.
    const outcomeController = new AbortController();
    void awaitOutcome(
      endpoint,
      {
        cityName: store.state.cityName,
        requestId: accepted.data.request_id,
        ...(accepted.data.event_cursor ? { eventCursor: accepted.data.event_cursor } : {}),
      },
      { signal: outcomeController.signal },
    )
      .then((outcome) => {
        if (outcome.kind === "failed") {
          finish({ status: "error", message: outcome.errorMessage });
        } else {
          finish({ status: "completed" });
        }
      })
      .catch(() => {
        // Best-effort: the activity / connection signals still resolve the turn.
      });

    function cleanup(): void {
      subscription.dispose();
      signal.removeEventListener("abort", onAbort);
      outcomeController.abort();
    }
  });
}
