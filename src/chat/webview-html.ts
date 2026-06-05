// The chat webview's HTML document, built as a pure function so it can be unit
// tested without a `vscode.Webview` (PRD Testing Decisions, Seam 2 — keep UI
// logic behind a testable seam). The host (`chat-panel.ts`) supplies the nonce
// and the webview's CSP source; everything here is static and string-only.
//
// Security: the document loads no remote resources, locks scripts to a per-load
// nonce, and the client script renders all server-provided text via `textContent`
// (never `innerHTML`), so transcript/pending content can never inject markup.

export interface ChatHtmlOptions {
  /** Per-load nonce; the only script allowed to run (CSP `script-src`). */
  nonce: string;
  /** `webview.cspSource` — the origin styles may load from. */
  cspSource: string;
  /** Initial document title (escaped). */
  title: string;
}

/** Escape the five HTML-significant characters for safe attribute/text interpolation. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Build the complete chat webview HTML document. Pure. */
export function getChatHtml(options: ChatHtmlOptions): string {
  const { nonce, cspSource, title } = options;
  const csp = [
    "default-src 'none'",
    `style-src ${cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
  ].join("; ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light dark; }
    body {
      margin: 0;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      display: flex;
      flex-direction: column;
      height: 100vh;
    }
    header {
      padding: 6px 12px;
      border-bottom: 1px solid var(--vscode-panel-border);
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    header .title { font-weight: 600; }
    header .meta { color: var(--vscode-descriptionForeground); font-size: 0.9em; }
    #status { margin-left: auto; font-size: 0.85em; color: var(--vscode-descriptionForeground); }
    #status.error { color: var(--vscode-errorForeground); }
    #log { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
    .turn { display: flex; flex-direction: column; gap: 2px; }
    .turn .role { font-size: 0.8em; text-transform: uppercase; letter-spacing: 0.04em; color: var(--vscode-descriptionForeground); }
    .turn .text { white-space: pre-wrap; word-break: break-word; }
    .turn.role-user .text { color: var(--vscode-foreground); }
    .turn.role-assistant .text, .turn.role-mayor .text { color: var(--vscode-foreground); }
    .empty { color: var(--vscode-descriptionForeground); font-style: italic; }
    #pending {
      margin: 0 12px;
      padding: 8px 10px;
      border: 1px solid var(--vscode-inputValidation-warningBorder, var(--vscode-panel-border));
      background: var(--vscode-inputValidation-warningBackground, transparent);
      border-radius: 4px;
    }
    #pending[hidden] { display: none; }
    #pending .kind { font-size: 0.8em; text-transform: uppercase; color: var(--vscode-descriptionForeground); }
    #pending .prompt { white-space: pre-wrap; margin: 4px 0; }
    #pending .actions { display: flex; gap: 6px; flex-wrap: wrap; }
    footer { border-top: 1px solid var(--vscode-panel-border); padding: 8px 12px; display: flex; flex-direction: column; gap: 6px; }
    .controls { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    textarea#input {
      width: 100%;
      box-sizing: border-box;
      resize: vertical;
      min-height: 44px;
      font-family: inherit;
      font-size: inherit;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      border-radius: 4px;
      padding: 6px;
    }
    button, select {
      font-family: inherit;
      font-size: inherit;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 4px;
      padding: 4px 10px;
      cursor: pointer;
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    button:disabled { opacity: 0.5; cursor: default; }
    select { color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background); }
    label.intent { color: var(--vscode-descriptionForeground); font-size: 0.85em; display: flex; gap: 4px; align-items: center; }
    /* A theme-driven focus ring on every keyboard-focused control (a11y + high
       contrast): --vscode-focusBorder is defined across light/dark/HC themes. */
    :focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 1px; }
  </style>
</head>
<body>
  <header>
    <span class="title" id="header-title">${escapeHtml(title)}</span>
    <span class="meta" id="header-meta"></span>
    <span id="status" role="status" aria-live="polite">connecting…</span>
  </header>
  <div id="log" role="log" aria-live="polite" aria-label="Conversation"><div class="empty" id="empty">No messages yet.</div></div>
  <section id="pending" role="region" aria-label="Pending approval" aria-live="polite" hidden>
    <div class="kind" id="pending-kind"></div>
    <div class="prompt" id="pending-prompt"></div>
    <div class="actions" id="pending-actions"></div>
  </section>
  <footer>
    <textarea id="input" aria-label="Message to the agent" placeholder="Message the agent…  (Enter to send, Shift+Enter for newline)"></textarea>
    <div class="controls">
      <label class="intent" for="intent">Intent
        <select id="intent" aria-label="Submit intent" title="How the submit is delivered to the agent's loop">
          <option value="default">default</option>
          <option value="follow_up">follow-up</option>
          <option value="interrupt_now">interrupt now</option>
        </select>
      </label>
      <button id="send">Send</button>
      <button id="reconnect" class="secondary" title="Reconnect the live stream">Reconnect</button>
    </div>
  </footer>
  <script nonce="${nonce}">
    (function () {
      const vscode = acquireVsCodeApi();
      const els = {
        log: document.getElementById('log'),
        empty: document.getElementById('empty'),
        title: document.getElementById('header-title'),
        meta: document.getElementById('header-meta'),
        status: document.getElementById('status'),
        input: document.getElementById('input'),
        intent: document.getElementById('intent'),
        send: document.getElementById('send'),
        reconnect: document.getElementById('reconnect'),
        pending: document.getElementById('pending'),
        pendingKind: document.getElementById('pending-kind'),
        pendingPrompt: document.getElementById('pending-prompt'),
        pendingActions: document.getElementById('pending-actions'),
      };

      function renderTurns(turns) {
        els.log.innerHTML = '';
        if (!turns || turns.length === 0) {
          const empty = document.createElement('div');
          empty.className = 'empty';
          empty.textContent = 'No messages yet.';
          els.log.appendChild(empty);
          return;
        }
        for (const turn of turns) {
          const wrap = document.createElement('div');
          wrap.className = 'turn role-' + String(turn.role || 'unknown').toLowerCase();
          const role = document.createElement('div');
          role.className = 'role';
          role.textContent = turn.role || 'unknown';
          const text = document.createElement('div');
          text.className = 'text';
          text.textContent = turn.text || '';
          wrap.appendChild(role);
          wrap.appendChild(text);
          els.log.appendChild(wrap);
        }
        els.log.scrollTop = els.log.scrollHeight;
      }

      function renderPending(pending) {
        els.pendingActions.innerHTML = '';
        if (!pending) {
          els.pending.hidden = true;
          return;
        }
        els.pending.hidden = false;
        els.pendingKind.textContent = pending.kind || 'pending';
        els.pendingPrompt.textContent = pending.prompt || '';
        const actions = (pending.options && pending.options.length)
          ? pending.options
          : ['allow', 'deny'];
        for (const action of actions) {
          const btn = document.createElement('button');
          btn.textContent = action;
          btn.setAttribute('aria-label', 'Respond: ' + action);
          btn.addEventListener('click', function () {
            vscode.postMessage({ type: 'respond', action: action });
          });
          els.pendingActions.appendChild(btn);
        }
      }

      function render(state) {
        els.title.textContent = state.title || state.sessionId;
        const bits = [];
        if (state.provider) bits.push(state.provider);
        if (state.permissionMode) bits.push('mode: ' + state.permissionMode);
        bits.push(state.cityName);
        els.meta.textContent = bits.join(' · ');

        const statusText = state.activity === 'in-turn'
          ? 'working…'
          : state.connection;
        els.status.textContent = state.error ? state.error : statusText;
        els.status.className = state.error ? 'error' : '';

        renderTurns(state.turns);
        renderPending(state.pending);

        const followUp = state.capabilities && state.capabilities.followUp;
        const interruptNow = state.capabilities && state.capabilities.interruptNow;
        els.intent.options[1].disabled = !followUp;
        els.intent.options[2].disabled = !interruptNow;
        els.send.disabled = !!state.sending;
      }

      function submit() {
        const message = els.input.value.trim();
        if (!message) return;
        vscode.postMessage({ type: 'submit', message: message, intent: els.intent.value });
        els.input.value = '';
      }

      els.send.addEventListener('click', submit);
      els.reconnect.addEventListener('click', function () {
        vscode.postMessage({ type: 'reconnect' });
      });
      els.input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          submit();
        }
      });
      window.addEventListener('message', function (event) {
        const msg = event.data;
        if (msg && msg.type === 'state') render(msg.state);
      });

      // Land keyboard focus in the message box when the panel opens so a
      // keyboard/screen-reader user can type immediately (a11y, Phase 3).
      els.input.focus();
      vscode.postMessage({ type: 'ready' });
    })();
  </script>
</body>
</html>`;
}
