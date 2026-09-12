import * as vscode from 'vscode'

import { Logger } from '../application/ports'

export class OutputLogger implements Logger {
  private readonly channel = vscode.window.createOutputChannel('Worktree Watcher', { log: true })

  info(message: string): void {
    this.channel.info(message)
  }

  error(message: string, error?: unknown): void {
    this.channel.error(error instanceof Error ? `${message}: ${error.message}` : message)
  }

  dispose(): void {
    this.channel.dispose()
  }
}
