/**
 * `vscode`-free core for the Ghostex session-driving commands (the
 * `gascityCockpit.ghostex.*` "drive" surface). The thin editor glue in
 * `src/views/ghostexCommands.ts` gathers input (quickpicks, input boxes,
 * context-menu nodes), builds a {@link GxClient}, and delegates every actual
 * operation to the {@link SessionDriver} here — so all the orchestration,
 * validation, and the two-phase agent-rename logic is unit-testable in plain
 * Node against a fake client, with no editor runtime (PRD "Seam 1").
 *
 * Why a driver and not raw `GxClient` calls in the glue:
 *   - gxserver scopes every session operation by `(projectId, sessionId)`, so the
 *     driver requires both up front and fails fast with a actionable message
 *     rather than letting a half-specified call reach the daemon.
 *   - Creating an *agent* session is a two-phase flow: gxserver hands the new
 *     session an auto-generated first-prompt title, so a caller-chosen title is
 *     applied by a follow-up `requestSessionRename`. That "rename where required"
 *     belongs in one tested place, not duplicated across command handlers.
 */
import type {
  GhostexSession,
  GhostexSessionLifecycleResult,
} from './types.ts';

/**
 * The slice of {@link GxClient} the driver depends on. Declaring it structurally
 * (rather than importing the concrete class) keeps the driver decoupled and lets
 * tests pass a tiny recording fake; `GxClient` satisfies it by construction.
 */
export interface GxSessionApi {
  createSession(params: { projectId: string; title?: string; cwd?: string }): Promise<GhostexSession>;
  createAgentSession(params: {
    projectId: string;
    agentId: string;
    title?: string;
    cwd?: string;
  }): Promise<GhostexSession>;
  renameSession(params: { projectId: string; sessionId: string; title: string }): Promise<void>;
  readSessionText(params: { sessionId: string; projectId?: string }): Promise<string>;
  sendSessionText(params: { sessionId: string; projectId?: string; text: string }): Promise<void>;
  sendSessionMessage(params: {
    sessionId: string;
    projectId?: string;
    text: string;
    submit?: boolean;
  }): Promise<void>;
  sleepSession(params: { sessionId: string; projectId?: string }): Promise<GhostexSessionLifecycleResult>;
  wakeSession(params: { sessionId: string; projectId?: string }): Promise<GhostexSessionLifecycleResult>;
  killSession(params: { sessionId: string; projectId?: string }): Promise<GhostexSessionLifecycleResult>;
  focusSession(params: { sessionId: string; projectId?: string }): Promise<GhostexSessionLifecycleResult>;
}

/** The `(project, session)` pair gxserver needs to address any session operation. */
export interface GhostexSessionTarget {
  readonly sessionId: string;
  readonly projectId: string;
}

/** Input for creating a terminal session. */
export interface CreateTerminalSessionInput {
  readonly projectId: string;
  readonly title?: string;
  readonly cwd?: string;
}

/** Input for creating an agent session (the two-phase create + rename flow). */
export interface CreateAgentSessionInput {
  readonly projectId: string;
  readonly agentId: string;
  readonly title?: string;
  readonly cwd?: string;
}

/**
 * Raised for caller/input errors detected *before* any transport call — an empty
 * id, a blank message, a context-menu node that carries no session. Distinct from
 * `GxClientError` (a transport/daemon failure) so the glue can tell "you gave me
 * nothing to act on" apart from "the daemon refused".
 */
export class GhostexDriveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GhostexDriveError';
  }
}

/** Require a non-blank string id/title; returns it trimmed. */
function required(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new GhostexDriveError(`${label} is required`);
  }
  return value.trim();
}

/**
 * Require a non-blank message/text body, but return it *verbatim* — leading and
 * trailing whitespace can be meaningful in what the operator types at an agent
 * (indented snippets, deliberate newlines), so only the blank check trims.
 */
function requiredBody(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new GhostexDriveError(`${label} is required`);
  }
  return value;
}

/** Normalize an optional free-text field: trimmed, or `undefined` when blank. */
function optional(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function hasStringProp(rec: Record<string, unknown>, key: string): boolean {
  return typeof rec[key] === 'string' && (rec[key] as string).trim() !== '';
}

/**
 * Resolve a {@link GhostexSessionTarget} from a context-menu argument of unknown
 * shape. Tree items in the Sessions explorer may expose the ids directly
 * (`{ sessionId, projectId }`) or wrap a `GhostexSession`/`GhostexPresentationSession`
 * under a `.session` property; both are accepted. Returns `null` when the
 * argument carries no addressable session (e.g. the command was invoked from the
 * palette with no selection), which the glue treats as "prompt the operator".
 */
export function resolveSessionTarget(arg: unknown): GhostexSessionTarget | null {
  if (typeof arg !== 'object' || arg === null) return null;
  const rec = arg as Record<string, unknown>;
  if (hasStringProp(rec, 'sessionId') && hasStringProp(rec, 'projectId')) {
    return { sessionId: (rec['sessionId'] as string).trim(), projectId: (rec['projectId'] as string).trim() };
  }
  const nested = rec['session'];
  if (typeof nested === 'object' && nested !== null) {
    const s = nested as Record<string, unknown>;
    if (hasStringProp(s, 'sessionId') && hasStringProp(s, 'projectId')) {
      return { sessionId: (s['sessionId'] as string).trim(), projectId: (s['projectId'] as string).trim() };
    }
  }
  return null;
}

/**
 * Higher-level operations over a {@link GxSessionApi}: create / drive / inspect a
 * Ghostex session. Every method validates its inputs and surfaces a
 * {@link GhostexDriveError} on bad input, or lets the client's `GxClientError`
 * propagate on a transport failure.
 */
export class SessionDriver {
  constructor(private readonly gx: GxSessionApi) {}

  /** Create a plain terminal session — single phase; gxserver honors the title at spawn. */
  async createTerminalSession(input: CreateTerminalSessionInput): Promise<GhostexSession> {
    const projectId = required(input.projectId, 'project id');
    return this.gx.createSession({ projectId, title: optional(input.title), cwd: optional(input.cwd) });
  }

  /**
   * Create an agent session, then apply the chosen title via a second
   * `requestSessionRename` — the "two-phase rename where required". gxserver hands
   * a fresh agent session an auto-generated first-prompt title, so we let the
   * create own `cwd`/`agentId` and the rename own the operator's title. When no
   * title is requested the second phase is skipped (single phase).
   */
  async createAgentSession(input: CreateAgentSessionInput): Promise<GhostexSession> {
    const projectId = required(input.projectId, 'project id');
    const agentId = required(input.agentId, 'agent id');
    const title = optional(input.title);
    const session = await this.gx.createAgentSession({ projectId, agentId, cwd: optional(input.cwd) });
    if (title && title !== session.title) {
      await this.gx.renameSession({ projectId: session.projectId, sessionId: session.sessionId, title });
      return { ...session, title };
    }
    return session;
  }

  /** Rename an existing session (the rename phase, exposed as a standalone op). */
  async rename(target: GhostexSessionTarget, title: string): Promise<void> {
    const t = this.requireTarget(target);
    await this.gx.renameSession({ projectId: t.projectId, sessionId: t.sessionId, title: required(title, 'title') });
  }

  /** Reveal/focus the session in Ghostex (gxserver dispatches the renderer focus). */
  async focus(target: GhostexSessionTarget): Promise<GhostexSession> {
    return this.lifecycle(target, (t) => this.gx.focusSession(t));
  }

  /** Sleep the session (pause its runtime; keeps it resumable). */
  async sleep(target: GhostexSessionTarget): Promise<GhostexSession> {
    return this.lifecycle(target, (t) => this.gx.sleepSession(t));
  }

  /** Wake a sleeping session. */
  async wake(target: GhostexSessionTarget): Promise<GhostexSession> {
    return this.lifecycle(target, (t) => this.gx.wakeSession(t));
  }

  /** Kill the session (terminate its runtime). Destructive — the glue confirms first. */
  async kill(target: GhostexSessionTarget): Promise<GhostexSession> {
    return this.lifecycle(target, (t) => this.gx.killSession(t));
  }

  /** Stage text into the session without submitting (no trailing Enter). */
  async sendText(target: GhostexSessionTarget, text: string): Promise<void> {
    const t = this.requireTarget(target);
    await this.gx.sendSessionText({ sessionId: t.sessionId, projectId: t.projectId, text: requiredBody(text, 'text') });
  }

  /** Send a message and submit it (trailing Enter) so the agent acts on it. */
  async sendMessage(target: GhostexSessionTarget, text: string): Promise<void> {
    const t = this.requireTarget(target);
    await this.gx.sendSessionMessage({
      sessionId: t.sessionId,
      projectId: t.projectId,
      text: requiredBody(text, 'message'),
      submit: true,
    });
  }

  /** Read the session's current terminal/agent text. */
  async readText(target: GhostexSessionTarget): Promise<string> {
    const t = this.requireTarget(target);
    return this.gx.readSessionText({ sessionId: t.sessionId, projectId: t.projectId });
  }

  /** Run a lifecycle call against a validated target and unwrap the session. */
  private async lifecycle(
    target: GhostexSessionTarget,
    call: (t: GhostexSessionTarget) => Promise<GhostexSessionLifecycleResult>,
  ): Promise<GhostexSession> {
    const result = await call(this.requireTarget(target));
    return result.session;
  }

  /** Validate a target's ids up front; gxserver rejects a half-specified address. */
  private requireTarget(target: GhostexSessionTarget): GhostexSessionTarget {
    return {
      sessionId: required(target?.sessionId, 'session id'),
      projectId: required(target?.projectId, 'project id'),
    };
  }
}
