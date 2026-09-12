import { promises as fs } from 'node:fs'
import * as path from 'node:path'

import { ActivityReader, ActivitySnapshot } from '../application/ports'
import { parseActivity } from '../domain/activity'
import { TranscriptIndex } from './transcriptIndex'

/**
 * Only the end of a transcript matters, and they reach several megabytes — so
 * read a fixed tail rather than the file. A 7MB transcript then costs the same
 * as a 100KB one.
 */
const TAIL_BYTES = 64 * 1024

export class TranscriptActivityReader implements ActivityReader {
  constructor(private readonly index: TranscriptIndex) {}

  async read(sessionId: string): Promise<ActivitySnapshot> {
    const file = await this.index.locate(sessionId)
    if (!file) {
      return {}
    }

    let handle
    try {
      handle = await fs.open(file, 'r')
      const { size, mtimeMs } = await handle.stat()
      const start = Math.max(0, size - TAIL_BYTES)
      const buffer = Buffer.alloc(Math.min(size, TAIL_BYTES))
      await handle.read(buffer, 0, buffer.length, start)

      const label = parseActivity(buffer.toString('utf8'))
      return {
        directory: path.dirname(file),
        activity: label ? { label, at: mtimeMs } : undefined
      }
    } catch {
      return { directory: path.dirname(file) }
    } finally {
      await handle?.close()
    }
  }
}
