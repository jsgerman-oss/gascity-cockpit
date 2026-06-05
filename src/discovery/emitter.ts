/**
 * A minimal typed event emitter with a `vscode.Event`-compatible shape
 * (`(listener) => disposable`), so the VS Code glue can adapt it trivially
 * while the core stays free of any `vscode` import.
 */

export interface Disposable {
  dispose(): void;
}

export type Listener<T> = (event: T) => void;

export class Emitter<T> {
  private listeners = new Set<Listener<T>>();

  /** Subscribe. Returns a disposable that removes the listener. */
  readonly event = (listener: Listener<T>): Disposable => {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  };

  /** Emit to all current listeners. A throwing listener never affects others. */
  fire(value: T): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(value);
      } catch {
        // A misbehaving subscriber must not break the emit loop or the
        // connection state machine driving it.
      }
    }
  }

  dispose(): void {
    this.listeners.clear();
  }
}
