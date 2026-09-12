/**
 * What a Claude session is doing, read from the last entry of its transcript.
 *
 * Pure and deliberately literal: it reports the last thing that happened and
 * nothing more. No inference about whether a session is stuck, stalled or
 * abandoned — the absence of activity is not evidence of anything, and guessing
 * at it would need a timer and would sometimes be wrong.
 */

export interface Activity {
  /** Plain wording: `running Bash`, `thinking`, `waiting for you`. */
  readonly label: string
  /** Epoch ms of the transcript's last write. */
  readonly at: number
}

/**
 * Reads the final meaningful entry from a transcript tail.
 *
 * The tail may begin mid-line, and a live session's final line may be half
 * written, so unparseable lines are skipped rather than treated as an error.
 */
export function parseActivity(transcriptTail: string): string | undefined {
  const lines = transcriptTail.split('\n').filter((line) => line.trim().length > 0)

  for (let index = lines.length - 1; index >= 0; index--) {
    let entry: TranscriptEntry
    try {
      entry = JSON.parse(lines[index]) as TranscriptEntry
    } catch {
      continue
    }

    const content = entry.message?.content
    if (entry.type === 'assistant' && Array.isArray(content)) {
      const tool = content.find((part) => part?.type === 'tool_use' && part.name)?.name
      return tool ? `running ${tool}` : 'waiting for you'
    }
    if (entry.type === 'user') {
      // A tool result coming back means the model is about to carry on.
      const isToolResult =
        Array.isArray(content) && content.some((part) => part?.type === 'tool_result')
      return isToolResult ? 'working' : 'thinking'
    }
  }

  return undefined
}

interface TranscriptEntry {
  type?: string
  message?: { content?: Array<{ type?: string; name?: string }> }
}
