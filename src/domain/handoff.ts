/**
 * Rules for handing a session request to another VS Code window.
 *
 * A session belongs to a folder, so opening one may mean opening a window first.
 * The request is parked until a window lands on the matching folder and claims
 * it. Pure, so the matching is testable without a VS Code host.
 */

/** A handoff older than this is stale — the user has moved on. */
export const PENDING_TTL_MS = 2 * 60_000

/**
 * A request parked for another window.
 *
 * Exactly one of `sessionId` and `prompt` is set: resume a conversation that
 * exists, or start one that does not. A new conversation cannot be identified by
 * id because it has none yet, which is why the two cases cannot share a field.
 */
export interface PendingSession {
  readonly sessionId?: string
  /** Seed text for a conversation that does not exist yet. */
  readonly prompt?: string
  readonly worktreePath: string
  readonly requestedAt: number
}

/** True when the request names something to act on. */
export function isActionable(pending: Partial<PendingSession>): boolean {
  return typeof pending.sessionId === 'string' || typeof pending.prompt === 'string'
}

/**
 * True when the target is one of the open folders, or sits inside one.
 *
 * The separator in the prefix check matters: without it
 * `…/chore/thing` would match a sibling `…/chore/thing-two`.
 */
export function isFolderOpen(target: string, folders: readonly string[]): boolean {
  return folders.some(
    (folder) =>
      folder === target || target.startsWith(`${folder}/`) || target.startsWith(`${folder}\\`)
  )
}

/** A pending request belongs to this window if the folder matches and it is fresh. */
export function claimsPending(
  pending: PendingSession,
  folders: readonly string[],
  now: number
): boolean {
  if (now - pending.requestedAt > PENDING_TTL_MS) {
    return false
  }
  return isFolderOpen(pending.worktreePath, folders)
}
