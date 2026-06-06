/**
 * An in-memory fake of the `vscode` API surface the cockpit touches.
 *
 * The host-abstracted features (the 11 under `src/features/` that depend on the
 * `host` interface rather than `vscode`) delegate their editor wiring to the
 * `register*` glue in `src/views/`, which DOES `import * as vscode from 'vscode'`.
 * There is no `vscode` runtime in `node_modules` — only `@types/vscode` — so a
 * plain-Node test cannot import a feature without one. This module supplies the
 * stand-in: `vitest.config.ts` aliases `vscode` to this file, so importing a
 * feature transitively loads this fake and every `register*` call lands here
 * where a test can inspect and drive it.
 *
 * It is a recorder, not a simulator: `registerCommand`, `createTreeView`,
 * `registerTextDocumentContentProvider`, status-bar items, configuration reads,
 * messages, quick-picks and the rest are captured into module-level state that
 * {@link fakeVscodeState} exposes and {@link resetFakeVscode} clears. User-driven
 * surfaces (`showInformationMessage`, `showQuickPick`, `showInputBox`) return
 * whatever a test queues, so a command handler can be run to completion and its
 * effects asserted. Read it through the {@link file://./fake-host.ts} testbed,
 * which resets this state and builds a `FeatureHost` over it.
 *
 * The type annotations here are the fake's own — they are NOT checked against
 * `@types/vscode` (tsc resolves `vscode` to the real types; only vitest aliases
 * to this file at runtime). Keeping the shapes loose (`unknown`) is deliberate:
 * the views are compiled against the real types, and the fake only needs to be
 * structurally callable at runtime.
 */

// --- Recorded state ---------------------------------------------------------

export type AnyFn = (...args: unknown[]) => unknown;
export interface FakeDisposable {
  dispose(): void;
}

/** A registered tree view: the provider plus the (mutable) view handle. */
export interface RegisteredTreeView {
  viewId: string;
  provider: TreeDataProviderLike;
  view: FakeTreeView;
}

/** The shape the views rely on from a `TreeDataProvider`, kept intentionally loose. */
export interface TreeDataProviderLike {
  onDidChangeTreeData?: FakeEvent<unknown>;
  getTreeItem(element: unknown): unknown;
  getChildren(element?: unknown): unknown;
  getParent?(element: unknown): unknown;
  resolveTreeItem?(...args: unknown[]): unknown;
}

/** A message shown via `window.show{Information,Warning,Error}Message`. */
export interface ShownMessage {
  message: string;
  items: string[];
}

/** A `window.showQuickPick` invocation (items resolved to an array). */
export interface QuickPickCall {
  items: unknown[];
  options: unknown;
}

export type LogOutputLine = { level: string; message: string };

export interface FakeVscodeState {
  /** id → handler, as registered via `commands.registerCommand`. */
  commands: Map<string, AnyFn>;
  /** Every `commands.executeCommand` call, in order. */
  executedCommands: Array<{ command: string; args: unknown[] }>;
  /** viewId → registered tree view (`createTreeView` or `registerTreeDataProvider`). */
  treeViews: Map<string, RegisteredTreeView>;
  /** viewId → webview view provider. */
  webviewViewProviders: Map<string, unknown>;
  /** scheme → text-document content provider. */
  contentProviders: Map<string, TextDocumentContentProviderLike>;
  /** Registered file-decoration providers (no key in the API). */
  fileDecorationProviders: unknown[];
  /** Registered code-lens providers, with their selector. */
  codeLensProviders: Array<{ selector: unknown; provider: unknown }>;
  statusBarItems: FakeStatusBarItem[];
  outputChannels: FakeOutputChannel[];
  webviewPanels: FakeWebviewPanel[];
  quickPicks: FakeQuickPick[];
  infoMessages: ShownMessage[];
  warnMessages: ShownMessage[];
  errorMessages: ShownMessage[];
  /** Options passed to each `showInputBox`, in order. */
  inputBoxes: unknown[];
  quickPickCalls: QuickPickCall[];
  openedDocuments: FakeTextDocument[];
  shownDocuments: Array<{ document: FakeTextDocument; options: unknown }>;
  openedExternal: string[];
  clipboard: { text: string };
  /** Flat configuration store, keyed by fully-dotted path (`section.key`). */
  configuration: Map<string, unknown>;
  workspaceFolders: WorkspaceFolderLike[] | undefined;
  activeTextEditor: FakeTextEditor | undefined;
  configChangeListeners: AnyFn[];
  workspaceFoldersChangeListeners: AnyFn[];
  closeDocumentListeners: AnyFn[];
  colorThemeListeners: AnyFn[];
  /** FIFO responses a test queues for the interactive surfaces. */
  responses: {
    messages: unknown[];
    quickPicks: unknown[];
    inputs: Array<string | undefined>;
  };
}

export interface WorkspaceFolderLike {
  uri: Uri;
  name: string;
  index: number;
}

export interface TextDocumentContentProviderLike {
  provideTextDocumentContent(uri: Uri, ...rest: unknown[]): string | Promise<string> | null | undefined;
  onDidChange?: FakeEvent<Uri>;
}

function freshState(): FakeVscodeState {
  return {
    commands: new Map(),
    executedCommands: [],
    treeViews: new Map(),
    webviewViewProviders: new Map(),
    contentProviders: new Map(),
    fileDecorationProviders: [],
    codeLensProviders: [],
    statusBarItems: [],
    outputChannels: [],
    webviewPanels: [],
    quickPicks: [],
    infoMessages: [],
    warnMessages: [],
    errorMessages: [],
    inputBoxes: [],
    quickPickCalls: [],
    openedDocuments: [],
    shownDocuments: [],
    openedExternal: [],
    clipboard: { text: "" },
    configuration: new Map(),
    workspaceFolders: undefined,
    activeTextEditor: undefined,
    configChangeListeners: [],
    workspaceFoldersChangeListeners: [],
    closeDocumentListeners: [],
    colorThemeListeners: [],
    responses: { messages: [], quickPicks: [], inputs: [] },
  };
}

let state: FakeVscodeState = freshState();

/** The live recorder. Reassigned wholesale by {@link resetFakeVscode}. */
export function fakeVscodeState(): FakeVscodeState {
  return state;
}

/** Clear all recorded state and queued responses (call between tests). */
export function resetFakeVscode(): void {
  state = freshState();
}

/** Queue the next return value for a `window.show*Message` call. */
export function queueMessageResponse(...values: unknown[]): void {
  state.responses.messages.push(...values);
}

/** Queue the next return value for a `window.showQuickPick` call. */
export function queueQuickPick(...values: unknown[]): void {
  state.responses.quickPicks.push(...values);
}

/** Queue the next return value for a `window.showInputBox` call. */
export function queueInputBox(...values: Array<string | undefined>): void {
  state.responses.inputs.push(...values);
}

// --- Value classes ----------------------------------------------------------

export class Disposable {
  static from(...items: Array<{ dispose(): unknown }>): Disposable {
    return new Disposable(() => {
      for (const item of items) item.dispose();
    });
  }
  constructor(private readonly callOnDispose: () => unknown = () => undefined) {}
  dispose(): void {
    this.callOnDispose();
  }
}

export type FakeEvent<T> = (listener: (e: T) => unknown, thisArgs?: unknown) => Disposable;

export class EventEmitter<T> {
  private readonly listeners = new Set<(e: T) => unknown>();
  readonly event: FakeEvent<T> = (listener, thisArgs) => {
    const bound = thisArgs ? listener.bind(thisArgs) : listener;
    this.listeners.add(bound);
    return new Disposable(() => this.listeners.delete(bound));
  };
  fire(data: T): void {
    for (const listener of [...this.listeners]) listener(data);
  }
  dispose(): void {
    this.listeners.clear();
  }
}

export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 } as const;
export const StatusBarAlignment = { Left: 1, Right: 2 } as const;
export const ViewColumn = { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3 } as const;
export const ColorThemeKind = { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 } as const;
export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 } as const;

export class TreeItem {
  label: unknown;
  collapsibleState: number;
  id?: string;
  description?: string | boolean;
  tooltip?: unknown;
  iconPath?: unknown;
  contextValue?: string;
  command?: unknown;
  resourceUri?: Uri;
  accessibilityInformation?: unknown;
  constructor(label: unknown, collapsibleState: number = TreeItemCollapsibleState.None) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

export class ThemeIcon {
  static readonly File = new ThemeIcon("file");
  static readonly Folder = new ThemeIcon("folder");
  constructor(
    public readonly id: string,
    public readonly color?: ThemeColor,
  ) {}
}

export class ThemeColor {
  constructor(public readonly id: string) {}
}

export class MarkdownString {
  isTrusted?: boolean;
  supportThemeIcons?: boolean;
  constructor(
    public value: string = "",
    supportThemeIcons = false,
  ) {
    this.supportThemeIcons = supportThemeIcons;
  }
  appendText(value: string): MarkdownString {
    this.value += value;
    return this;
  }
  appendMarkdown(value: string): MarkdownString {
    this.value += value;
    return this;
  }
  appendCodeblock(value: string, _language?: string): MarkdownString {
    this.value += value;
    return this;
  }
}

export class Position {
  constructor(
    public readonly line: number,
    public readonly character: number,
  ) {}
}

export class Range {
  readonly start: Position;
  readonly end: Position;
  constructor(
    startLine: number | Position,
    startChar: number | Position,
    endLine?: number,
    endChar?: number,
  ) {
    if (startLine instanceof Position && startChar instanceof Position) {
      this.start = startLine;
      this.end = startChar;
    } else {
      this.start = new Position(startLine as number, startChar as number);
      this.end = new Position(endLine ?? 0, endChar ?? 0);
    }
  }
}

export class CodeLens {
  isResolved = false;
  constructor(
    public readonly range: Range,
    public command?: unknown,
  ) {}
}

export class FileDecoration {
  propagate?: boolean;
  constructor(
    public badge?: string,
    public tooltip?: string,
    public color?: ThemeColor,
  ) {}
}

/** Minimal but real URI: enough that `new URLSearchParams(uri.query)` works. */
export class Uri {
  private constructor(
    public readonly scheme: string,
    public readonly authority: string,
    public readonly path: string,
    public readonly query: string,
    public readonly fragment: string,
  ) {}
  get fsPath(): string {
    return this.path;
  }
  with(change: {
    scheme?: string;
    authority?: string;
    path?: string;
    query?: string;
    fragment?: string;
  }): Uri {
    return new Uri(
      change.scheme ?? this.scheme,
      change.authority ?? this.authority,
      change.path ?? this.path,
      change.query ?? this.query,
      change.fragment ?? this.fragment,
    );
  }
  toString(): string {
    const q = this.query ? `?${this.query}` : "";
    const f = this.fragment ? `#${this.fragment}` : "";
    const auth = this.authority ? `//${this.authority}` : "";
    return `${this.scheme}:${auth}${this.path}${q}${f}`;
  }
  static file(path: string): Uri {
    return new Uri("file", "", path, "", "");
  }
  static parse(value: string): Uri {
    try {
      const u = new URL(value);
      return new Uri(
        u.protocol.replace(/:$/, ""),
        u.host,
        u.pathname,
        u.search.replace(/^\?/, ""),
        u.hash.replace(/^#/, ""),
      );
    } catch {
      return new Uri("file", "", value, "", "");
    }
  }
  static from(components: {
    scheme: string;
    authority?: string;
    path?: string;
    query?: string;
    fragment?: string;
  }): Uri {
    return new Uri(
      components.scheme,
      components.authority ?? "",
      components.path ?? "",
      components.query ?? "",
      components.fragment ?? "",
    );
  }
  static joinPath(base: Uri, ...segments: string[]): Uri {
    const joined = [base.path.replace(/\/$/, ""), ...segments].join("/");
    return base.with({ path: joined });
  }
}

// --- Stateful handles -------------------------------------------------------

export interface FakeStatusBarItem {
  alignment?: number;
  priority?: number;
  text: string;
  tooltip?: unknown;
  command?: unknown;
  color?: unknown;
  backgroundColor?: unknown;
  name?: string;
  shown: boolean;
  show(): void;
  hide(): void;
  dispose(): void;
}

export interface FakeTreeView {
  visible: boolean;
  selection: unknown[];
  message?: string;
  title?: string;
  description?: string;
  badge?: unknown;
  readonly onDidChangeSelection: FakeEvent<unknown>;
  readonly onDidChangeVisibility: FakeEvent<unknown>;
  readonly onDidExpandElement: FakeEvent<unknown>;
  readonly onDidCollapseElement: FakeEvent<unknown>;
  reveal(...args: unknown[]): Promise<void>;
  dispose(): void;
}

export interface FakeOutputChannel {
  readonly name: string;
  readonly lines: LogOutputLine[];
  append(value: string): void;
  appendLine(value: string): void;
  replace(value: string): void;
  clear(): void;
  trace(message: string): void;
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  show(..._args: unknown[]): void;
  hide(): void;
  dispose(): void;
}

export interface FakeWebview {
  html: string;
  options: unknown;
  cspSource: string;
  readonly onDidReceiveMessage: FakeEvent<unknown>;
  postMessage(message: unknown): Promise<boolean>;
  posted: unknown[];
  asWebviewUri(uri: Uri): Uri;
}

export interface FakeWebviewPanel {
  readonly viewType: string;
  title: string;
  readonly webview: FakeWebview;
  visible: boolean;
  active: boolean;
  readonly onDidDispose: FakeEvent<void>;
  readonly onDidChangeViewState: FakeEvent<unknown>;
  reveal(...args: unknown[]): void;
  dispose(): void;
  fireDispose(): void;
}

export interface FakeQuickPick<T = unknown> {
  items: T[];
  value: string;
  placeholder?: string;
  title?: string;
  busy: boolean;
  selectedItems: T[];
  activeItems: T[];
  matchOnDescription: boolean;
  matchOnDetail: boolean;
  readonly onDidChangeValue: FakeEvent<string>;
  readonly onDidAccept: FakeEvent<void>;
  readonly onDidHide: FakeEvent<void>;
  readonly onDidChangeSelection: FakeEvent<T[]>;
  show(): void;
  hide(): void;
  dispose(): void;
}

export interface FakeTextDocument {
  readonly uri: Uri;
  languageId: string;
  getText(): string;
}

export interface FakeTextEditor {
  readonly document: FakeTextDocument;
  selection: unknown;
  selections: unknown[];
}

function makeStatusBarItem(alignment?: number, priority?: number): FakeStatusBarItem {
  const item: FakeStatusBarItem = {
    alignment,
    priority,
    text: "",
    shown: false,
    show() {
      item.shown = true;
    },
    hide() {
      item.shown = false;
    },
    dispose() {
      const i = state.statusBarItems.indexOf(item);
      if (i >= 0) state.statusBarItems.splice(i, 1);
    },
  };
  return item;
}

function makeTreeView(): FakeTreeView {
  return {
    visible: true,
    selection: [],
    onDidChangeSelection: new EventEmitter<unknown>().event,
    onDidChangeVisibility: new EventEmitter<unknown>().event,
    onDidExpandElement: new EventEmitter<unknown>().event,
    onDidCollapseElement: new EventEmitter<unknown>().event,
    reveal: () => Promise.resolve(),
    dispose: () => undefined,
  };
}

function makeOutputChannel(name: string): FakeOutputChannel {
  const lines: LogOutputLine[] = [];
  const log = (level: string) => (message: string) => void lines.push({ level, message });
  return {
    name,
    lines,
    append: (value) => void lines.push({ level: "append", message: value }),
    appendLine: (value) => void lines.push({ level: "appendLine", message: value }),
    replace: (value) => void lines.push({ level: "replace", message: value }),
    clear: () => void (lines.length = 0),
    trace: log("trace"),
    debug: log("debug"),
    info: log("info"),
    warn: log("warn"),
    error: log("error"),
    show: () => undefined,
    hide: () => undefined,
    dispose: () => undefined,
  };
}

function makeWebview(): FakeWebview {
  const emitter = new EventEmitter<unknown>();
  const posted: unknown[] = [];
  return {
    html: "",
    options: {},
    cspSource: "vscode-fake-resource:",
    onDidReceiveMessage: emitter.event,
    posted,
    postMessage: (message) => {
      posted.push(message);
      return Promise.resolve(true);
    },
    asWebviewUri: (uri) => uri,
  };
}

function makeWebviewPanel(viewType: string, title: string): FakeWebviewPanel {
  const disposeEmitter = new EventEmitter<void>();
  const panel: FakeWebviewPanel = {
    viewType,
    title,
    webview: makeWebview(),
    visible: true,
    active: true,
    onDidDispose: disposeEmitter.event,
    onDidChangeViewState: new EventEmitter<unknown>().event,
    reveal: () => undefined,
    dispose: () => panel.fireDispose(),
    fireDispose: () => disposeEmitter.fire(),
  };
  return panel;
}

function makeQuickPick<T>(): FakeQuickPick<T> {
  return {
    items: [],
    value: "",
    busy: false,
    selectedItems: [],
    activeItems: [],
    matchOnDescription: false,
    matchOnDetail: false,
    onDidChangeValue: new EventEmitter<string>().event,
    onDidAccept: new EventEmitter<void>().event,
    onDidHide: new EventEmitter<void>().event,
    onDidChangeSelection: new EventEmitter<T[]>().event,
    show: () => undefined,
    hide: () => undefined,
    dispose: () => undefined,
  };
}

// --- API namespaces ---------------------------------------------------------

/**
 * Reduce the args after the message to their string labels. A leading
 * `MessageOptions` object (`{ modal?, detail? }`) is skipped; a `MessageItem`
 * (`{ title, ... }`) is kept and rendered by its `title`.
 */
function messageItems(rest: unknown[]): string[] {
  const leadingIsOptions =
    rest.length > 0 && typeof rest[0] === "object" && rest[0] !== null && !("title" in rest[0]);
  const choices = leadingIsOptions ? rest.slice(1) : rest;
  return choices.map((c) =>
    typeof c === "string"
      ? c
      : c && typeof c === "object" && "title" in c
        ? String((c as { title: unknown }).title)
        : String(c),
  );
}

function recordMessage(bucket: ShownMessage[], message: unknown, rest: unknown[]): Promise<unknown> {
  bucket.push({ message: String(message), items: messageItems(rest) });
  return Promise.resolve(state.responses.messages.length ? state.responses.messages.shift() : undefined);
}

export const commands = {
  registerCommand(command: string, callback: AnyFn, thisArg?: unknown): Disposable {
    const handler = thisArg ? (callback.bind(thisArg) as AnyFn) : callback;
    state.commands.set(command, handler);
    return new Disposable(() => {
      if (state.commands.get(command) === handler) state.commands.delete(command);
    });
  },
  registerTextEditorCommand(command: string, callback: AnyFn, thisArg?: unknown): Disposable {
    return commands.registerCommand(command, callback, thisArg);
  },
  executeCommand(command: string, ...args: unknown[]): Promise<unknown> {
    state.executedCommands.push({ command, args });
    const handler = state.commands.get(command);
    if (handler) return Promise.resolve(handler(...args));
    return Promise.resolve(undefined);
  },
  getCommands(_filterInternal?: boolean): Promise<string[]> {
    return Promise.resolve([...state.commands.keys()]);
  },
};

export const window = {
  createTreeView(viewId: string, options: { treeDataProvider: TreeDataProviderLike }): FakeTreeView {
    const view = makeTreeView();
    state.treeViews.set(viewId, { viewId, provider: options.treeDataProvider, view });
    return view;
  },
  registerTreeDataProvider(viewId: string, provider: TreeDataProviderLike): Disposable {
    state.treeViews.set(viewId, { viewId, provider, view: makeTreeView() });
    return new Disposable(() => state.treeViews.delete(viewId));
  },
  createStatusBarItem(alignment?: number, priority?: number): FakeStatusBarItem {
    // VS Code also supports (id, alignment, priority); detect the id overload.
    if (typeof alignment === "string") {
      const item = makeStatusBarItem(priority, undefined);
      item.name = alignment;
      state.statusBarItems.push(item);
      return item;
    }
    const item = makeStatusBarItem(alignment, priority);
    state.statusBarItems.push(item);
    return item;
  },
  createOutputChannel(name: string, _options?: unknown): FakeOutputChannel {
    const channel = makeOutputChannel(name);
    state.outputChannels.push(channel);
    return channel;
  },
  registerWebviewViewProvider(viewId: string, provider: unknown): Disposable {
    state.webviewViewProviders.set(viewId, provider);
    return new Disposable(() => state.webviewViewProviders.delete(viewId));
  },
  registerFileDecorationProvider(provider: unknown): Disposable {
    state.fileDecorationProviders.push(provider);
    return new Disposable(() => {
      const i = state.fileDecorationProviders.indexOf(provider);
      if (i >= 0) state.fileDecorationProviders.splice(i, 1);
    });
  },
  createWebviewPanel(viewType: string, title: string, ..._rest: unknown[]): FakeWebviewPanel {
    const panel = makeWebviewPanel(viewType, title);
    state.webviewPanels.push(panel);
    return panel;
  },
  createQuickPick<T = unknown>(): FakeQuickPick<T> {
    const qp = makeQuickPick<T>();
    state.quickPicks.push(qp as FakeQuickPick);
    return qp;
  },
  showInformationMessage(message: unknown, ...rest: unknown[]): Promise<unknown> {
    return recordMessage(state.infoMessages, message, rest);
  },
  showWarningMessage(message: unknown, ...rest: unknown[]): Promise<unknown> {
    return recordMessage(state.warnMessages, message, rest);
  },
  showErrorMessage(message: unknown, ...rest: unknown[]): Promise<unknown> {
    return recordMessage(state.errorMessages, message, rest);
  },
  async showQuickPick(items: unknown, options?: unknown): Promise<unknown> {
    const resolved = await Promise.resolve(items);
    state.quickPickCalls.push({ items: Array.isArray(resolved) ? resolved : [], options });
    return state.responses.quickPicks.length ? state.responses.quickPicks.shift() : undefined;
  },
  showInputBox(options?: unknown): Promise<string | undefined> {
    state.inputBoxes.push(options ?? null);
    return Promise.resolve(state.responses.inputs.length ? state.responses.inputs.shift() : undefined);
  },
  showTextDocument(document: FakeTextDocument, options?: unknown): Promise<FakeTextEditor> {
    state.shownDocuments.push({ document, options });
    return Promise.resolve({ document, selection: undefined, selections: [] });
  },
  onDidChangeActiveColorTheme(listener: AnyFn): Disposable {
    state.colorThemeListeners.push(listener);
    return new Disposable(() => {
      const i = state.colorThemeListeners.indexOf(listener);
      if (i >= 0) state.colorThemeListeners.splice(i, 1);
    });
  },
  get activeTextEditor(): FakeTextEditor | undefined {
    return state.activeTextEditor;
  },
  get activeColorTheme(): { kind: number } {
    return { kind: ColorThemeKind.Dark };
  },
};

function configAccessor(section: string | undefined) {
  const full = (key: string) => (section ? `${section}.${key}` : key);
  return {
    get<T>(key: string, defaultValue?: T): T | undefined {
      const k = full(key);
      return state.configuration.has(k) ? (state.configuration.get(k) as T) : defaultValue;
    },
    has(key: string): boolean {
      return state.configuration.has(full(key));
    },
    update(key: string, value: unknown, _target?: unknown): Promise<void> {
      state.configuration.set(full(key), value);
      return Promise.resolve();
    },
    inspect(key: string): { key: string; globalValue: unknown; defaultValue: undefined } {
      return { key: full(key), globalValue: state.configuration.get(full(key)), defaultValue: undefined };
    },
  };
}

export const workspace = {
  getConfiguration(section?: string): ReturnType<typeof configAccessor> {
    return configAccessor(section);
  },
  registerTextDocumentContentProvider(scheme: string, provider: TextDocumentContentProviderLike): Disposable {
    state.contentProviders.set(scheme, provider);
    return new Disposable(() => state.contentProviders.delete(scheme));
  },
  async openTextDocument(uriOrOptions: unknown): Promise<FakeTextDocument> {
    const uri = uriOrOptions instanceof Uri ? uriOrOptions : Uri.parse(String(uriOrOptions));
    const provider = state.contentProviders.get(uri.scheme);
    const text = provider ? (await Promise.resolve(provider.provideTextDocumentContent(uri))) ?? "" : "";
    const doc: FakeTextDocument = { uri, languageId: "plaintext", getText: () => text };
    state.openedDocuments.push(doc);
    return doc;
  },
  onDidChangeConfiguration(listener: AnyFn): Disposable {
    state.configChangeListeners.push(listener);
    return new Disposable(() => {
      const i = state.configChangeListeners.indexOf(listener);
      if (i >= 0) state.configChangeListeners.splice(i, 1);
    });
  },
  onDidChangeWorkspaceFolders(listener: AnyFn): Disposable {
    state.workspaceFoldersChangeListeners.push(listener);
    return new Disposable(() => {
      const i = state.workspaceFoldersChangeListeners.indexOf(listener);
      if (i >= 0) state.workspaceFoldersChangeListeners.splice(i, 1);
    });
  },
  onDidCloseTextDocument(listener: AnyFn): Disposable {
    state.closeDocumentListeners.push(listener);
    return new Disposable(() => {
      const i = state.closeDocumentListeners.indexOf(listener);
      if (i >= 0) state.closeDocumentListeners.splice(i, 1);
    });
  },
  asRelativePath(pathOrUri: unknown, _includeWorkspaceFolder?: boolean): string {
    const p = pathOrUri instanceof Uri ? pathOrUri.fsPath : String(pathOrUri);
    for (const folder of state.workspaceFolders ?? []) {
      const base = folder.uri.fsPath.replace(/\/$/, "");
      if (p === base) return "";
      if (p.startsWith(`${base}/`)) return p.slice(base.length + 1);
    }
    return p;
  },
  get workspaceFolders(): WorkspaceFolderLike[] | undefined {
    return state.workspaceFolders;
  },
};

export const languages = {
  setTextDocumentLanguage(document: FakeTextDocument, languageId: string): Promise<FakeTextDocument> {
    document.languageId = languageId;
    return Promise.resolve(document);
  },
  registerCodeLensProvider(selector: unknown, provider: unknown): Disposable {
    const entry = { selector, provider };
    state.codeLensProviders.push(entry);
    return new Disposable(() => {
      const i = state.codeLensProviders.indexOf(entry);
      if (i >= 0) state.codeLensProviders.splice(i, 1);
    });
  },
};

export const env = {
  clipboard: {
    writeText(value: string): Promise<void> {
      state.clipboard.text = value;
      return Promise.resolve();
    },
    readText(): Promise<string> {
      return Promise.resolve(state.clipboard.text);
    },
  },
  openExternal(target: unknown): Promise<boolean> {
    state.openedExternal.push(target instanceof Uri ? target.toString() : String(target));
    return Promise.resolve(true);
  },
};

export const chat = {
  createChatParticipant(id: string, _handler: unknown): { id: string; iconPath?: unknown; dispose(): void; onDidReceiveFeedback: FakeEvent<unknown> } {
    return {
      id,
      iconPath: undefined,
      dispose: () => undefined,
      onDidReceiveFeedback: new EventEmitter<unknown>().event,
    };
  },
};
