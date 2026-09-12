import { Dirent, promises as fs } from 'node:fs'
import * as path from 'node:path'

import { ScanOptions, SessionVerifier, WorktreeScanner } from '../application/ports'
import {
  ClaudeSession,
  parseGitFile,
  parseHead,
  parseSessions,
  Repository,
  repositoryNameFor,
  Scan,
  SESSION_SIDECARS,
  Worktree
} from '../domain/model'

/**
 * Discovers worktrees by reading the filesystem — no `git` subprocess.
 *
 * A worktree is identified by `.git` being a FILE containing a `gitdir:` pointer
 * (a normal checkout has `.git` as a directory). Following that pointer to its
 * `HEAD` yields the branch, which is the only reliable source: folder names under
 * `.worktrees` do not always match the branch.
 *
 * Depends on `node:fs` only, so it runs under plain `node --test`.
 */
export class FsWorktreeScanner implements WorktreeScanner {
  /** Without a verifier every recorded session is reported, verified or not. */
  constructor(private readonly verifier?: SessionVerifier) {}

  async scan({ rootPath, maxDepth }: ScanOptions): Promise<Scan> {
    const watchPaths = new Set<string>([rootPath])
    const sessionWatchPaths = new Set<string>()
    const repositories: Repository[] = []

    for (const entry of await readDirectory(rootPath)) {
      if (!entry.isDirectory()) {
        continue
      }
      const name = repositoryNameFor(entry.name)
      if (!name) {
        continue
      }

      const worktreesPath = path.join(rootPath, entry.name)
      watchPaths.add(worktreesPath)

      const worktrees: Worktree[] = []
      const main = await this.readMainCheckout(path.join(rootPath, name), watchPaths)
      if (main) {
        worktrees.push(main)
      }
      await this.collect(worktreesPath, worktreesPath, 0, maxDepth, worktrees, watchPaths)

      for (const worktree of worktrees) {
        const directory = this.verifier?.transcriptDirectory(worktree.absolutePath)
        if (directory) {
          sessionWatchPaths.add(directory)
        }
      }

      repositories.push({ name, worktreesPath, worktrees })
    }

    return {
      repositories,
      watchPaths: [...watchPaths],
      sessionWatchPaths: [...sessionWatchPaths]
    }
  }

  /** Walks down until it finds a worktree, pruning nothing but dotfiles. */
  private async collect(
    directory: string,
    worktreesRoot: string,
    depth: number,
    maxDepth: number,
    found: Worktree[],
    watchPaths: Set<string>
  ): Promise<void> {
    if (depth > maxDepth) {
      return
    }

    const entries = await readDirectory(directory)
    const gitEntry = entries.find((entry) => entry.name === '.git')

    if (gitEntry?.isFile()) {
      const worktree = await this.readWorktree(directory, worktreesRoot, watchPaths)
      if (worktree) {
        found.push(worktree)
      }
      // Stop here: descending would walk the entire checked-out repository.
      return
    }

    watchPaths.add(directory)

    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        await this.collect(
          path.join(directory, entry.name),
          worktreesRoot,
          depth + 1,
          maxDepth,
          found,
          watchPaths
        )
      }
    }
  }

  private async readWorktree(
    directory: string,
    worktreesRoot: string,
    watchPaths: Set<string>
  ): Promise<Worktree | undefined> {
    const pointer = await readFile(path.join(directory, '.git'))
    const gitDir = pointer && parseGitFile(pointer)
    if (!gitDir) {
      return undefined
    }

    // Branch switches rewrite HEAD inside the main repo's admin directory, not
    // inside the worktree — so that is what has to be watched to see them.
    watchPaths.add(gitDir)

    const head = await readFile(path.join(gitDir, 'HEAD'))

    return {
      absolutePath: directory,
      folderPath: path.relative(worktreesRoot, directory),
      isMain: false,
      claudeSessions: await this.readSessions(gitDir),
      ...(head ? parseHead(head) : {})
    }
  }

  /** Reads the current sidecar, falling back to the legacy single-id filename. */
  private async readSessions(gitDir: string): Promise<ClaudeSession[]> {
    for (const filename of SESSION_SIDECARS) {
      const contents = await readFile(path.join(gitDir, filename))
      if (!contents) {
        continue
      }
      const sessions = parseSessions(contents)
      if (sessions.length === 0) {
        continue
      }
      const verified = this.verifier ? await this.verifier.resumable(sessions) : sessions
      return [...verified]
    }
    return []
  }

  private async readMainCheckout(
    repositoryPath: string,
    watchPaths: Set<string>
  ): Promise<Worktree | undefined> {
    const gitDir = path.join(repositoryPath, '.git')
    if (!(await isDirectory(gitDir))) {
      return undefined
    }
    watchPaths.add(gitDir)

    const head = await readFile(path.join(gitDir, 'HEAD'))
    return {
      absolutePath: repositoryPath,
      folderPath: path.basename(repositoryPath),
      isMain: true,
      claudeSessions: [],
      ...(head ? parseHead(head) : {})
    }
  }
}

/** Missing or unreadable directories are a normal state here, not an error. */
async function readDirectory(directory: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(directory, { withFileTypes: true })
  } catch {
    return []
  }
}

async function readFile(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, 'utf8')
  } catch {
    return undefined
  }
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isDirectory()
  } catch {
    return false
  }
}
