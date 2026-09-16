import * as vscode from 'vscode'

import { ReviewRequestStore } from '../application/reviewRequestStore'
import { describeReviewQueue } from '../domain/reviewRequests'

/** Left of most things on the right-hand side, near the source-control items. */
const PRIORITY = 100

/**
 * Shows how many pull requests are waiting on your review, in the status bar.
 *
 * It carries the same command as the title-bar button, so clicking either opens
 * the same list.
 *
 * Hidden at zero. An empty review queue is the normal state and does not need a
 * permanent square of chrome saying so.
 *
 * **Known limitation.** The store behind this only polls while the Worktrees
 * panel is visible, so with the panel closed the number is the last one seen
 * rather than the current one. That is deliberate for now — polling whenever the
 * window is open would be a behaviour change beyond showing a number — and is
 * noted as future work in the README. Clicking always re-reads, so acting on a
 * stale number cannot act on stale data.
 */
export class ReviewRequestStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem
  private readonly subscription: vscode.Disposable

  constructor(
    private readonly store: ReviewRequestStore,
    command: string
  ) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, PRIORITY)
    this.item.command = command
    this.subscription = this.store.onDidChange(() => this.render())
    this.render()
  }

  private render(): void {
    const summary = describeReviewQueue(this.store.count)
    if (!summary) {
      this.item.hide()
      return
    }

    this.item.text = `$(git-pull-request) ${summary}`
    this.item.tooltip = `${summary} — click to check one out as a worktree`
    this.item.show()
  }

  dispose(): void {
    this.subscription.dispose()
    this.item.dispose()
  }
}
