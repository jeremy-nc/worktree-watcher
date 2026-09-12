import { BranchBuilds, Build, rollUp } from '../domain/build'
import { BranchRef, pullRequestKey } from '../domain/pullRequest'
import { Emitter } from './emitter'
import { BuildSource, Disposable, Logger, TeamCitySettings } from './ports'

const MAX_BACKOFF_MS = 30 * 60_000

export interface BuildState {
  readonly status: 'idle' | 'disabled' | 'unavailable' | 'loading' | 'ready' | 'error'
  readonly byBranch: ReadonlyMap<string, BranchBuilds>
  readonly error?: string
}

/**
 * Polls TeamCity for each worktree branch.
 *
 * Separate from the GitHub store on purpose: TeamCity needs its own credentials
 * and its own sign-in, and is the more likely of the two to be unconfigured. When
 * it is, it reports `unavailable` and nothing else in the panel changes.
 *
 * One request per branch rather than one per poll — unlike GitHub's search there
 * is no way to ask about many branches at once — so the branch set is kept small
 * by only asking about worktrees that exist.
 */
export class BuildStore implements Disposable {
  private readonly changed = new Emitter<BuildState>()
  readonly onDidChange = this.changed.on.bind(this.changed)

  private state: BuildState = { status: 'idle', byBranch: new Map() }
  private refs: readonly BranchRef[] = []
  private timer?: ReturnType<typeof setTimeout>
  private settingsListener?: Disposable
  private consumers = 0
  private inFlight = false

  constructor(
    private readonly source: BuildSource,
    private readonly settings: TeamCitySettings,
    private readonly logger: Logger
  ) {}

  get current(): BuildState {
    return this.state
  }

  find(repository: string, branch: string | undefined): BranchBuilds | undefined {
    return branch ? this.state.byBranch.get(pullRequestKey(repository, branch)) : undefined
  }

  activate(): Disposable {
    if (++this.consumers === 1) {
      this.settingsListener = this.settings.onDidChange(() => this.refresh())
      void this.poll()
    }
    return {
      dispose: () => {
        if (--this.consumers === 0) {
          this.stop()
        }
      }
    }
  }

  setBranches(refs: readonly BranchRef[]): void {
    const next = [...refs].sort((a, b) =>
      `${a.repository}#${a.branch}`.localeCompare(`${b.repository}#${b.branch}`)
    )
    const same =
      next.length === this.refs.length &&
      next.every((ref, i) => ref.repository === this.refs[i].repository && ref.branch === this.refs[i].branch)
    if (same) {
      return
    }
    this.refs = next
    if (this.consumers > 0) {
      void this.poll()
    }
  }

  refresh(): void {
    if (this.consumers > 0) {
      void this.poll()
    }
  }

  dispose(): void {
    this.stop()
    this.changed.dispose()
  }

  private async poll(): Promise<void> {
    if (this.inFlight) {
      return
    }
    if (!this.settings.enabled) {
      this.publish({ status: 'disabled', byBranch: new Map() })
      return
    }
    if (this.refs.length === 0) {
      return
    }

    this.inFlight = true
    this.publish({ ...this.state, status: 'loading' })

    try {
      if (!(await this.source.available())) {
        // Not configured or not signed in — a normal state, not a failure.
        this.publish({ status: 'unavailable', byBranch: new Map() })
        this.schedule(this.intervalMs)
        return
      }

      const byBranch = new Map<string, BranchBuilds>()
      // Sequential: a branch fan-out is already ~100 builds, and hammering a
      // CI server from an editor panel is a poor trade for a second of latency.
      for (const ref of this.refs) {
        try {
          const builds: readonly Build[] = await this.source.buildsForBranch(ref.branch)
          const rolled = rollUp(ref.repository, ref.branch, builds)
          if (rolled) {
            byBranch.set(pullRequestKey(ref.repository, ref.branch), rolled)
          }
        } catch (error) {
          this.logger.error(`TeamCity: ${ref.repository}#${ref.branch}`, error)
        }
      }

      this.logger.info(`TeamCity: ${byBranch.size} of ${this.refs.length} branches have builds`)
      this.publish({ status: 'ready', byBranch })
      this.schedule(this.intervalMs)
    } catch (error) {
      this.logger.error('TeamCity poll failed', error)
      this.publish({ ...this.state, status: 'error', error: describe(error) })
      this.schedule(Math.min(this.intervalMs * 4, MAX_BACKOFF_MS))
    } finally {
      this.inFlight = false
    }
  }

  private get intervalMs(): number {
    return Math.max(1, this.settings.pollMinutes) * 60_000
  }

  private schedule(delayMs: number): void {
    clearTimeout(this.timer)
    this.timer = this.consumers > 0 ? setTimeout(() => void this.poll(), delayMs) : undefined
  }

  private publish(state: BuildState): void {
    this.state = state
    this.changed.fire(state)
  }

  private stop(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    this.settingsListener?.dispose()
    this.settingsListener = undefined
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
