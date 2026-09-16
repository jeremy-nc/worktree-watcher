import * as os from 'node:os'
import * as path from 'node:path'
import * as vscode from 'vscode'

import { DEFAULT_STALE_DAYS } from '../domain/cleanUp'
import { DEFAULT_REVIEW_SCOPE, ReviewScope } from '../domain/reviewRequests'
import { DEFAULT_DEPLOY_ENVIRONMENT, DEFAULT_DEPLOY_PREFERENCE } from '../domain/deploy'
import {
  ActivitySettings,
  Disposable,
  GitHubSettings,
  Settings,
  TeamCitySettings
} from '../application/ports'

export const SECTION = 'worktreeWatcher'

export class VscodeGitHubSettings implements GitHubSettings {
  get enabled(): boolean {
    return read<boolean>('github.enabled', true)
  }

  get organisation(): string {
    return read<string>('github.organisation', '').trim()
  }

  get pollMinutes(): number {
    return Math.max(1, read<number>('github.pollMinutes', 5))
  }

  onDidChange(listener: () => void): Disposable {
    return vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(`${SECTION}.github`)) {
        listener()
      }
    })
  }
}

export class VscodeActivitySettings implements ActivitySettings {
  get enabled(): boolean {
    return read<boolean>('activity.enabled', true)
  }

  onDidChange(listener: () => void): Disposable {
    return vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(`${SECTION}.activity`)) {
        listener()
      }
    })
  }
}

export class VscodeTeamCitySettings implements TeamCitySettings {
  get enabled(): boolean {
    return read<boolean>('teamCity.enabled', false)
  }

  get url(): string {
    return read<string>('teamCity.url', '').trim()
  }

  get iapClientId(): string {
    return read<string>('teamCity.iapClientId', '').trim()
  }

  /**
   * A desktop OAuth client's "secret" is not confidential (RFC 8252 §8.5), so it
   * lives in settings; the refresh token and TeamCity token do not.
   */
  get iapClientSecret(): string {
    return read<string>('teamCity.iapClientSecret', '').trim()
  }

  get iapAudience(): string {
    return read<string>('teamCity.iapAudience', '').trim()
  }

  get deployBuildTypeNames(): readonly string[] {
    const names = read<string[]>('teamCity.deployBuildTypeNames', [])
    return names.length ? names : DEFAULT_DEPLOY_PREFERENCE
  }

  get deployEnvironment(): string {
    return read<string>('teamCity.deployEnvironment', DEFAULT_DEPLOY_ENVIRONMENT)
  }

  get pollMinutes(): number {
    return Math.max(1, read<number>('teamCity.pollMinutes', 5))
  }

  onDidChange(listener: () => void): Disposable {
    return vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(`${SECTION}.teamCity`)) {
        listener()
      }
    })
  }
}

export class VscodeSettings implements Settings {
  get rootPath(): string {
    return expandPath(this.read<string>('rootPath', '~/Code'))
  }

  get maxDepth(): number {
    return Math.max(1, this.read<number>('maxDepth', 4))
  }

  get showEmptyRepositories(): boolean {
    return this.read<boolean>('showEmptyRepositories', false)
  }

  get staleDays(): number {
    return Math.max(1, this.read<number>('cleanUp.staleDays', DEFAULT_STALE_DAYS))
  }

  get reviewScope(): ReviewScope {
    return this.read<string>('reviewRequests.scope', DEFAULT_REVIEW_SCOPE) === 'team'
      ? 'team'
      : 'personal'
  }

  get excludeDraftReviews(): boolean {
    return this.read<boolean>('reviewRequests.excludeDrafts', true)
  }

  get excludeReviewedByMe(): boolean {
    return this.read<boolean>('reviewRequests.excludeReviewed', true)
  }

  /** Scratch directory for working on dependency-bump pull requests. */
  get botWorkspace(): string {
    return expandPath(this.read<string>('reviewRequests.botWorkspace', '~/Code/dependabot'))
  }

  onDidChange(listener: () => void): Disposable {
    return vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(SECTION)) {
        listener()
      }
    })
  }

  private read<T>(key: string, fallback: T): T {
    return read(key, fallback)
  }
}

function read<T>(key: string, fallback: T): T {
  return vscode.workspace.getConfiguration(SECTION).get<T>(key, fallback)
}

/**
 * VS Code does not expand variables inside extension setting values, so `~` and
 * `${workspaceFolder}` have to be resolved here or the path is taken literally.
 */
export function expandPath(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    return ''
  }

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? ''
  const substituted = trimmed
    .replace(/^~(?=$|\/)/, os.homedir())
    .replace(/\$\{userHome\}/g, os.homedir())
    .replace(/\$\{workspaceFolder\}/g, workspaceFolder)

  return path.normalize(substituted)
}
