/**
 * What a Claude session is doing, read from the last entry of its transcript.
 *
 * Pure and deliberately literal: it reports the last thing that happened and
 * nothing more. No inference about whether a session is stuck, stalled or
 * abandoned — the absence of activity is not evidence of anything, and guessing
 * at it would need a timer and would sometimes be wrong.
 *
 * `idle` is not an exception to that. It is not a judgement that a session has
 * been quiet for a while; it is the literal reading of a transcript whose last
 * entry is the assistant finishing its turn. `waiting for you` is reserved for
 * the one case where something is genuinely outstanding on your side.
 */

export interface Activity {
  /** Plain wording: `running Bash`, `thinking`, `idle`. */
  readonly label: string
  /** Epoch ms of the transcript's last write. */
  readonly at: number
}

/**
 * Tools that block on a person rather than do work.
 *
 * A tool call normally means the session is busy, which is why the default
 * wording is `running`. These are the exception: the call is outstanding
 * precisely because it is waiting for an answer, so reporting them as running
 * points at the machine when the thing to look at is you.
 */
const BLOCKING_TOOLS = new Set(['AskUserQuestion'])

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
      if (!tool) {
        // The turn ended with prose. Nothing is pending — the session is simply
        // finished until someone types again.
        return 'idle'
      }
      return BLOCKING_TOOLS.has(tool) ? `waiting for you · ${tool}` : `running ${tool}`
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
