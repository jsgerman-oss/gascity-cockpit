// The event time-travel webview's HTML document, built as a pure function so the
// scrubber + replay UI is unit-testable without a `vscode.Webview` (PRD Testing
// Decisions, Seam 2). The host (`../views/timeTravel.ts`) supplies the nonce and
// the webview's CSP source and posts the recorded rows in; everything here is
// static and string-only.
//
// Security: the document loads no remote resources, locks scripts to a per-load
// nonce, and the client script renders every server-provided field via
// `textContent` (never `innerHTML`), so event text can never inject markup.

export interface TimeTravelHtmlOptions {
  /** Per-load nonce; the only script allowed to run (CSP `script-src`). */
  nonce: string;
  /** `webview.cspSource` — the origin styles may load from. */
  cspSource: string;
  /** Document/header title (escaped). */
  title: string;
}

/** Escape the five HTML-significant characters for safe attribute/text interpolation. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Build the complete event time-travel webview HTML document. Pure. */
export function renderTimeTravelHtml(options: TimeTravelHtmlOptions): string {
  const { nonce, cspSource, title } = options;
  const csp = [
    "default-src 'none'",
    `style-src ${cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');

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
      padding: 8px 12px;
      border-bottom: 1px solid var(--vscode-panel-border);
      display: flex;
      align-items: baseline;
      gap: 8px;
      flex-wrap: wrap;
    }
    header .title { font-weight: 600; }
    header .meta { color: var(--vscode-descriptionForeground); font-size: 0.9em; }
    #status { margin-left: auto; font-size: 0.85em; color: var(--vscode-descriptionForeground); }
    .scrubber { padding: 8px 12px; border-bottom: 1px solid var(--vscode-panel-border); display: flex; flex-direction: column; gap: 8px; }
    .transport { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .transport .readout { font-variant-numeric: tabular-nums; }
    .transport .time { color: var(--vscode-descriptionForeground); font-size: 0.9em; font-variant-numeric: tabular-nums; }
    .transport .live {
      margin-left: 4px; padding: 1px 6px; border-radius: 8px; font-size: 0.78em;
      color: var(--vscode-charts-green, #89d185);
      border: 1px solid var(--vscode-charts-green, #89d185);
    }
    .transport .live[hidden] { display: none; }
    .transport .spacer { margin-left: auto; }
    input[type="range"] { width: 100%; accent-color: var(--vscode-focusBorder); cursor: pointer; }
    input[type="range"]:disabled { cursor: default; opacity: 0.5; }
    button, select {
      font-family: inherit;
      font-size: inherit;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      /* Keep a visible edge in high-contrast themes (contrastBorder), not the
         button background which would vanish against the fill. */
      border: 1px solid var(--vscode-button-border, var(--vscode-contrastBorder, transparent));
      border-radius: 4px;
      padding: 3px 9px;
      cursor: pointer;
    }
    button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
    button.secondary, select { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    button:disabled, select:disabled { opacity: 0.5; cursor: default; }
    label.speed { color: var(--vscode-descriptionForeground); font-size: 0.85em; display: flex; gap: 4px; align-items: center; }
    /* A theme-driven focus ring on every keyboard-focused control (a11y + high
       contrast): --vscode-focusBorder is defined across light/dark/HC themes. */
    :focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 1px; }
    #events { flex: 1; overflow-y: auto; margin: 0; padding: 4px 0; list-style: none; }
    #events .ev {
      display: grid;
      grid-template-columns: auto auto 1fr;
      gap: 4px 10px;
      align-items: baseline;
      padding: 4px 12px;
      border-left: 3px solid transparent;
    }
    #events .ev .seq { color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; font-size: 0.85em; }
    #events .ev .t { color: var(--vscode-descriptionForeground); font-size: 0.85em; font-variant-numeric: tabular-nums; }
    #events .ev .lbl { font-weight: 600; grid-column: 3; }
    #events .ev .dsc { color: var(--vscode-descriptionForeground); grid-column: 3; }
    #events .ev.kind-warn { border-left-color: var(--vscode-list-warningForeground, var(--vscode-charts-yellow, #cca700)); }
    #events .ev.kind-error { border-left-color: var(--vscode-list-errorForeground, var(--vscode-charts-red, #f14c4c)); }
    /* Events past the playhead are dimmed to a faint "not yet happened" ghost so
       the operator sees the future of the run without it competing for attention. */
    #events .ev.future { opacity: 0.32; }
    #events .ev.current { background: var(--vscode-list-activeSelectionBackground, var(--vscode-editor-selectionBackground)); }
    .empty { color: var(--vscode-descriptionForeground); font-style: italic; padding: 16px 12px; }
    .empty[hidden] { display: none; }
  </style>
</head>
<body>
  <header>
    <span class="title">${escapeHtml(title)}</span>
    <span class="meta" id="meta"></span>
    <span id="status" role="status" aria-live="polite">Waiting for events…</span>
  </header>
  <section class="scrubber" aria-label="Replay transport">
    <div class="transport">
      <button id="to-start" class="secondary" aria-label="Jump to start" title="Jump to start">⏮</button>
      <button id="step-back" class="secondary" aria-label="Step back one event" title="Step back">◀</button>
      <button id="play" aria-label="Play replay" title="Play / pause replay">Play</button>
      <button id="step-fwd" class="secondary" aria-label="Step forward one event" title="Step forward">▶</button>
      <button id="to-live" class="secondary" aria-label="Jump to live edge" title="Jump to the latest event">⏭</button>
      <label class="speed" for="speed">Speed
        <select id="speed" aria-label="Replay speed">
          <option value="0.5">0.5×</option>
          <option value="1" selected>1×</option>
          <option value="2">2×</option>
          <option value="4">4×</option>
        </select>
      </label>
      <span class="live" id="live" hidden>live</span>
      <span class="spacer"></span>
      <button id="copy" class="secondary" aria-label="Copy current event" title="Copy the current event to the clipboard">Copy event</button>
    </div>
    <input type="range" id="scrub" min="0" max="0" value="0" step="1" aria-label="Event timeline scrubber" disabled />
    <div class="transport">
      <span class="readout" id="readout" aria-live="polite">No events recorded</span>
      <span class="time" id="time"></span>
    </div>
  </section>
  <ol id="events" role="list" aria-label="Recorded events"></ol>
  <p class="empty" id="empty">No events recorded yet. The timeline fills as the supervisor emits events while the Cockpit is connected.</p>
  <script nonce="${nonce}">
    (function () {
      const vscode = acquireVsCodeApi();
      function byId(id) { return document.getElementById(id); }
      const els = {
        meta: byId('meta'), status: byId('status'),
        scrub: byId('scrub'), readout: byId('readout'), time: byId('time'),
        list: byId('events'), empty: byId('empty'),
        play: byId('play'), stepBack: byId('step-back'), stepFwd: byId('step-fwd'),
        toStart: byId('to-start'), toLive: byId('to-live'), speed: byId('speed'),
        copy: byId('copy'), live: byId('live'),
      };

      let rows = [];
      let playhead = 0;   // number of events revealed: 0..rows.length
      let playing = false;
      let timer = null;

      function count() { return rows.length; }
      function atLive() { return playhead >= count(); }
      function currentRow() { return playhead > 0 && playhead <= rows.length ? rows[playhead - 1] : null; }

      function makeLi(row, index) {
        const li = document.createElement('li');
        li.className = 'ev kind-' + row.kind;
        li.dataset.index = String(index);
        const seq = document.createElement('span'); seq.className = 'seq'; seq.textContent = '#' + row.seq;
        const t = document.createElement('span'); t.className = 't'; t.textContent = row.ts || '—';
        const lbl = document.createElement('span'); lbl.className = 'lbl'; lbl.textContent = row.label;
        const dsc = document.createElement('span'); dsc.className = 'dsc'; dsc.textContent = row.desc;
        li.appendChild(seq); li.appendChild(t); li.appendChild(lbl); li.appendChild(dsc);
        li.addEventListener('click', function () { stop(); setPlayhead(index + 1); });
        return li;
      }

      function buildList() {
        els.list.textContent = '';
        for (let i = 0; i < rows.length; i++) els.list.appendChild(makeLi(rows[i], i));
        els.empty.hidden = rows.length > 0;
      }

      function appendRow(row) {
        const i = rows.length;
        rows.push(row);
        els.list.appendChild(makeLi(row, i));
        els.empty.hidden = true;
      }

      function render() {
        const n = count();
        els.scrub.max = String(n);
        if (Number(els.scrub.value) !== playhead) els.scrub.value = String(playhead);
        els.scrub.disabled = n === 0;

        const items = els.list.children;
        for (let i = 0; i < items.length; i++) {
          const it = items[i];
          const idx = Number(it.dataset.index);
          it.classList.toggle('future', idx >= playhead);
          it.classList.toggle('current', idx === playhead - 1);
        }

        const cur = currentRow();
        els.readout.textContent = n === 0 ? 'No events recorded' : ('Event ' + playhead + ' of ' + n);
        els.time.textContent = cur ? (cur.ts || '') : '';
        els.scrub.setAttribute('aria-valuetext',
          n === 0 ? 'No events' : ('Event ' + playhead + ' of ' + n + (cur && cur.ts ? ', ' + cur.ts : '')));

        els.meta.textContent = n === 0 ? '' : (n + (n === 1 ? ' event' : ' events') + ' recorded');
        els.live.hidden = !(atLive() && n > 0);
        els.play.textContent = playing ? 'Pause' : 'Play';
        els.play.setAttribute('aria-label', playing ? 'Pause replay' : 'Play replay');
        els.play.disabled = n === 0;
        els.stepBack.disabled = playhead <= 0;
        els.stepFwd.disabled = playhead >= n;
        els.toStart.disabled = playhead <= 0;
        els.toLive.disabled = atLive();
        els.copy.disabled = !cur;
        els.status.textContent = playing ? 'Replaying…'
          : n === 0 ? 'Waiting for events…'
          : atLive() ? 'At live edge' : 'Scrubbing history';

        if (cur) {
          const el = els.list.querySelector('.current');
          if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
        }
      }

      function setPlayhead(p) {
        const n = count();
        playhead = Math.max(0, Math.min(n, p));
        render();
      }

      function tickMs() {
        const mult = Number(els.speed.value) || 1;
        return Math.max(60, Math.round(700 / mult));
      }

      function stop() {
        playing = false;
        if (timer) { clearInterval(timer); timer = null; }
        render();
      }

      function play() {
        const n = count();
        if (n === 0) return;
        if (playhead >= n) playhead = 0; // replay from the start when at the end
        playing = true;
        if (timer) clearInterval(timer);
        timer = setInterval(function () {
          if (playhead >= count()) { stop(); return; }
          playhead += 1;
          render();
        }, tickMs());
        render();
      }

      function togglePlay() { if (playing) stop(); else play(); }

      function formatEvent(r) {
        const lines = ['seq ' + r.seq + (r.ts ? '  ' + r.ts : ''), r.type];
        if (r.city) lines.push('city: ' + r.city);
        if (r.actor) lines.push('actor: ' + r.actor);
        if (r.subject) lines.push('subject: ' + r.subject);
        if (r.message) lines.push('message: ' + r.message);
        return lines.join('\\n');
      }

      els.play.addEventListener('click', togglePlay);
      els.stepBack.addEventListener('click', function () { stop(); setPlayhead(playhead - 1); });
      els.stepFwd.addEventListener('click', function () { stop(); setPlayhead(playhead + 1); });
      els.toStart.addEventListener('click', function () { stop(); setPlayhead(0); });
      els.toLive.addEventListener('click', function () { stop(); setPlayhead(count()); });
      els.scrub.addEventListener('input', function () { stop(); setPlayhead(Number(els.scrub.value)); });
      els.speed.addEventListener('change', function () { if (playing) play(); });
      els.copy.addEventListener('click', function () {
        const cur = currentRow();
        if (cur) vscode.postMessage({ type: 'copy', text: formatEvent(cur) });
      });

      window.addEventListener('message', function (event) {
        const msg = event.data;
        if (!msg) return;
        if (msg.type === 'timeline') {
          rows = Array.isArray(msg.rows) ? msg.rows.slice() : [];
          buildList();
          playhead = rows.length; // open at the live edge
          stop();                 // also renders
        } else if (msg.type === 'append' && msg.row) {
          const wasLive = atLive();
          appendRow(msg.row);
          if (wasLive || playing) playhead = rows.length; // keep following if at the edge
          render();
        }
      });

      vscode.postMessage({ type: 'ready' });
    })();
  </script>
</body>
</html>`;
}
