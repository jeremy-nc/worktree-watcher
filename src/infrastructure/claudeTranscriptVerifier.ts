import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { SessionVerifier } from '../application/ports'
import { ClaudeSession } from '../domain/model'
import { sessionTitle, transcriptCwd } from '../domain/transcript'
import { TranscriptIndex } from './transcriptIndex'

/**
 * Confirms a session is resumable by looking for its transcript.
 *
 * Claude Code stores transcripts at:
 *
 *   ~/.claude/projects/<cwd with / and . replaced by ->/<session-id>.jsonl
 *
 * That layout is an internal convention rather than a documented contract, which
 * is why it is isolated here behind `SessionVerifier` — if it moves, this is the
 * only file to change.
 *
 * Lookup is by session **id**, across every project directory — a session
 * recorded against a worktree has not necessarily run there, and deriving the
 * directory from the worktree would miss it.
 *
 * Conservative by design: when the index is empty the projects directory is
 * missing or unreadable, so nothing is filtered — an unverifiable session is
 * shown rather than silently hidden.
 */
export class ClaudeTranscriptVerifier implements SessionVerifier {
  constructor(
    private readonly projectsRoot = path.join(os.homedir(), '.claude', 'projects'),
    private readonly index = new TranscriptIndex(projectsRoot)
  ) {}

  async resumable(sessions: readonly ClaudeSession[]): Promise<readonly ClaudeSession[]> {
    if (sessions.length === 0) {
      return sessions
    }

    // An empty index means the projects directory is missing or unreadable, so
    // nothing can be verified — show everything rather than hiding it all.
    if ((await this.index.size()) === 0) {
      return sessions
    }

    const resumable = await Promise.all(
      sessions.map(async (session) => ((await this.index.has(session.id)) ? session : undefined))
    )
    return resumable.filter((session): session is ClaudeSession => session !== undefined)
  }

  /**
   * The title Claude Code shows for this session — also its editor tab label.
   * Undefined if the transcript is unreadable or the session has no title yet.
   */
  async title(sessionId: string): Promise<string | undefined> {
    const file = await this.index.locate(sessionId)
    if (!file) {
      return undefined
    }
    try {
      return sessionTitle(await fs.readFile(file, 'utf8'))
    } catch {
      return undefined
    }
  }

  /**
   * The directory a session actually ran in.
   *
   * Not the worktree it is listed against: a session recorded by the `/worktree`
   * skill, or by the SessionStart hook from a parent checkout, can have run
   * somewhere else entirely. Opening the wrong directory silently gives you a
   * window on the wrong code.
   */
  async workingDirectory(sessionId: string): Promise<string | undefined> {
    const file = await this.index.locate(sessionId)
    if (!file) {
      return undefined
    }
    try {
      return transcriptCwd(await fs.readFile(file, 'utf8'))
    } catch {
      return undefined
    }
  }

  /**
   * Sessions that have run in a directory, newest first.
   *
   * The worktree flow reads these from a sidecar in `.git/worktrees/<name>/`,
   * which a plain directory has nowhere to keep. Claude Code's own layout
   * already answers the question — every transcript for a directory lives in
   * that directory's project folder — so this reads it from there rather than
   * inventing a second place to record the same fact.
   *
   * Ordered by last write, so the session you were most recently in comes first.
   */
  async sessionsIn(directory: string): Promise<ClaudeSession[]> {
    const projectDirectory = this.transcriptDirectory(directory)
    let entries: string[]
    try {
      entries = await fs.readdir(projectDirectory)
    } catch {
      return []
    }

    const found = await Promise.all(
      entries
        .filter((entry) => entry.endsWith('.jsonl'))
        .map(async (entry): Promise<ClaudeSession | undefined> => {
          try {
            const { mtimeMs } = await fs.stat(path.join(projectDirectory, entry))
            return { id: entry.slice(0, -'.jsonl'.length), at: new Date(mtimeMs).toISOString() }
          } catch {
            return undefined
          }
        })
    )

    return found
      .filter((session): session is ClaudeSession => session !== undefined)
      .sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''))
  }

  /**
   * Groups a directory's sessions by which of `needles` their transcript
   * mentions, newest first.
   *
   * Only the **head** of each transcript is read. A session started for a
   * particular pull request is seeded with its URL, so the marker is in the
   * opening message — reading further would cost megabytes to learn nothing.
   *
   * Each transcript is read once and checked against every needle, rather than
   * once per needle, so the cost is the number of sessions and not the product.
   */
  async sessionsByMention(
    directory: string,
    needles: readonly string[]
  ): Promise<Map<string, ClaudeSession[]>> {
    const grouped = new Map<string, ClaudeSession[]>()
    if (needles.length === 0) {
      return grouped
    }

    const projectDirectory = this.transcriptDirectory(directory)
    for (const session of await this.sessionsIn(directory)) {
      const head = await readHead(path.join(projectDirectory, `${session.id}.jsonl`))
      if (!head) {
        continue
      }
      for (const needle of needles) {
        if (head.includes(needle)) {
          grouped.set(needle, [...(grouped.get(needle) ?? []), session])
        }
      }
    }

    return grouped
  }

  /** Titles for several sessions at once, keyed by session id. */
  async titles(sessionIds: readonly string[]): Promise<Map<string, string>> {
    const resolved = await Promise.all(
      sessionIds.map(async (id) => [id, await this.title(id)] as const)
    )
    return new Map(
      resolved.filter((entry): entry is readonly [string, string] => entry[1] !== undefined)
    )
  }

  /**
   * Directory holding this worktree's transcripts. Watching it surfaces sessions
   * being created or deleted from Claude Code's own sidebar.
   */
  transcriptDirectory(worktreePath: string): string {
    return path.join(this.projectsRoot, projectSlug(worktreePath))
  }
}

/** The opening exchange is all that carries a seeded marker. */
const HEAD_BYTES = 64 * 1024

async function readHead(file: string): Promise<string | undefined> {
  let handle
  try {
    handle = await fs.open(file, 'r')
    const buffer = Buffer.alloc(HEAD_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } catch {
    return undefined
  } finally {
    await handle?.close()
  }
}

/** `/Users/x/Code/repo.worktrees/a/b` → `-Users-x-Code-repo-worktrees-a-b` */
export function projectSlug(absolutePath: string): string {
  return absolutePath.replace(/[/.]/g, '-')
}

