import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { claimsPending, PendingSession } from '../domain/handoff'

/**
 * Parks a session request on disk while the window that should handle it starts.
 *
 * Deliberately a file rather than `ExtensionContext.globalState`: a Memento is
 * cached per window and its cross-window visibility is not a documented
 * guarantee, so a brand-new window reading a just-written value is a gamble. A
 * file is immediately visible, survives the writing window closing, and can be
 * inspected when something goes wrong.
 *
 * Imports no `vscode`, so the claim logic is testable under plain `node --test`.
 */
export class PendingSessionStore {
  constructor(private readonly file: string = defaultPath()) {}

  async write(pending: PendingSession): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    await fs.writeFile(this.file, JSON.stringify(pending), 'utf8')
  }

  /**
   * Takes ownership of a pending request aimed at these folders, or returns
   * undefined. The claim renames the file first, so two windows opening the same
   * folder cannot both act on it.
   */
  async claim(folders: readonly string[], now: number): Promise<PendingSession | undefined> {
    const pending = await this.read()
    if (!pending || !claimsPending(pending, folders, now)) {
      return undefined
    }

    const claimed = `${this.file}.claimed-${process.pid}`
    try {
      await fs.rename(this.file, claimed)
    } catch {
      return undefined // Another window claimed it first.
    }

    await fs.rm(claimed, { force: true })
    return pending
  }

  /** Discards a request without claiming it — used when it can't be honoured. */
  async clear(): Promise<void> {
    await fs.rm(this.file, { force: true })
  }

  private async read(): Promise<PendingSession | undefined> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8')) as Partial<PendingSession>
      if (
        typeof parsed.sessionId === 'string' &&
        typeof parsed.worktreePath === 'string' &&
        typeof parsed.requestedAt === 'number'
      ) {
        return parsed as PendingSession
      }
    } catch {
      // Missing or malformed: there is simply nothing pending.
    }
    return undefined
  }
}

function defaultPath(): string {
  const stateHome =
    process.env.XDG_STATE_HOME ?? path.join(os.homedir(), '.local', 'state')
  return path.join(stateHome, 'worktree-watcher', 'pending-session.json')
}
