import { Disposable } from './ports'

/**
 * Minimal event emitter so the application layer does not depend on
 * `vscode.EventEmitter`. Same shape, so adapting it at the boundary is trivial.
 */
export class Emitter<T> {
  private readonly listeners = new Set<(value: T) => void>()

  on(listener: (value: T) => void): Disposable {
    this.listeners.add(listener)
    return { dispose: () => this.listeners.delete(listener) }
  }

  fire(value: T): void {
    for (const listener of [...this.listeners]) {
      listener(value)
    }
  }

  dispose(): void {
    this.listeners.clear()
  }
}
