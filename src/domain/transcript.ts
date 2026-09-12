/**
 * Pure reading of Claude Code transcript metadata.
 *
 * Transcripts are JSONL. The tab title a session shows in VS Code is its most
 * recent `ai-title` entry — matching that label is how an already-open session is
 * found, since the VS Code tab API exposes a tab's label but not which session it
 * holds.
 */

/**
 * The title Claude Code shows for a session, matching how its own sidebar
 * resolves one: a user-set `customTitle` wins over the generated `aiTitle`.
 *
 * Matching only `aiTitle` would go stale the moment a session is renamed — and
 * since the editor tab is labelled from the same resolution, a stale match means
 * a duplicate tab.
 *
 * Claude falls back further (lastPrompt, summaryHint, firstPrompt) for sessions
 * with no title at all; undefined here simply means "do not try to match".
 */
export function sessionTitle(transcript: string): string | undefined {
  let aiTitle: string | undefined
  let customTitle: string | undefined

  for (const line of transcript.split('\n')) {
    if (!line.includes('itle')) {
      continue
    }
    try {
      const entry = JSON.parse(line) as { type?: string; aiTitle?: unknown; customTitle?: unknown }
      if (typeof entry.customTitle === 'string' && entry.customTitle) {
        customTitle = entry.customTitle
      }
      if (entry.type === 'ai-title' && typeof entry.aiTitle === 'string' && entry.aiTitle) {
        aiTitle = entry.aiTitle
      }
    } catch {
      // A partially written final line is normal while a session is live.
    }
  }

  return customTitle ?? aiTitle
}

/** First `cwd` recorded in the transcript — the directory the session ran in. */
export function transcriptCwd(transcript: string): string | undefined {
  for (const line of transcript.split('\n')) {
    if (!line.includes('"cwd"')) {
      continue
    }
    try {
      const entry = JSON.parse(line) as { cwd?: unknown }
      if (typeof entry.cwd === 'string' && entry.cwd) {
        return entry.cwd
      }
    } catch {
      continue
    }
  }
  return undefined
}
