import { promises as fs } from 'node:fs'
import * as path from 'node:path'

import { PullRequestSidecarWriter } from '../application/ports'
import {
  PULL_REQUEST_SIDECAR,
  PullRequestSidecar,
  parseSidecar,
  sameSidecar
} from '../domain/pullRequestSidecar'

/**
 * Keeps `pull-request.json` in each worktree's metadata directory.
 *
 * Writes are atomic (temporary file, then rename) so the watch script never
 * reads half a file, and skipped when nothing but the timestamp changed, so the
 * file's modification time means the pull request moved.
 */
export class FsPullRequestSidecarWriter implements PullRequestSidecarWriter {
  async write(metadataPath: string, sidecar: PullRequestSidecar): Promise<void> {
    const file = path.join(metadataPath, PULL_REQUEST_SIDECAR)
    const existing = await readExisting(file)
    if (existing && sameSidecar(existing, sidecar)) {
      return
    }
    await fs.mkdir(path.dirname(file), { recursive: true })
    const temporary = `${file}.${process.pid}.tmp`
    await fs.writeFile(temporary, `${JSON.stringify(sidecar, null, 2)}\n`, 'utf8')
    await fs.rename(temporary, file)
  }

  async remove(metadataPath: string): Promise<void> {
    await fs.rm(path.join(metadataPath, PULL_REQUEST_SIDECAR), { force: true })
  }
}

async function readExisting(file: string): Promise<PullRequestSidecar | undefined> {
  try {
    return parseSidecar(await fs.readFile(file, 'utf8'))
  } catch {
    return undefined
  }
}
