import * as vscode from 'vscode'

import { Disposable, DirectoryWatcher } from '../application/ports'

/**
 * Watches a set of directories for direct-child changes.
 *
 * Deliberately **non-recursive**: a `RelativePattern` whose pattern contains no
 * `**` watches only the immediate children of the base Uri. A recursive watch on
 * `~/Code` would mean watching every file in every checked-out repository —
 * thousands of handles and constant churn — and watchers outside the workspace do
 * not honour `files.watcherExclude`, so there would be no way to trim it back.
 *
 * Instead the scanner reports the handful of container directories that actually
 * define the structure (`~/Code`, each `*.worktrees`, each prefix directory, and
 * each repo's git admin dir) and only those are watched.
 */
export class VscodeDirectoryWatcher implements DirectoryWatcher {
  watch(paths: readonly string[], onChange: () => void): Disposable {
    return this.create(paths, onChange, false)
  }

  watchStructure(paths: readonly string[], onChange: () => void): Disposable {
    return this.create(paths, onChange, true)
  }

  private create(
    paths: readonly string[],
    onChange: () => void,
    ignoreChanges: boolean
  ): Disposable {
    const watchers = paths.map((directory) => {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(directory), '*'),
        false,
        ignoreChanges,
        false
      )
      watcher.onDidCreate(onChange)
      watcher.onDidDelete(onChange)
      if (!ignoreChanges) {
        watcher.onDidChange(onChange)
      }
      return watcher
    })

    return { dispose: () => watchers.forEach((watcher) => watcher.dispose()) }
  }
}
