import * as os from 'node:os'
import * as path from 'node:path'
import * as vscode from 'vscode'

import { ActivityStore } from './application/activityStore'
import { PullRequestStore } from './application/pullRequestStore'
import { WorktreeStore } from './application/worktreeStore'
import { ClaudeSession } from './domain/model'
import { BranchRef, PullRequest } from './domain/pullRequest'
import { GhPullRequestSource } from './infrastructure/ghPullRequestSource'
import { BuildStore } from './application/buildStore'
import { GoogleIapAuthProvider, IAP_AUTH_PROVIDER_ID } from './infrastructure/iapAuthProvider'
import { TeamCityBuildSource } from './infrastructure/teamCityBuildSource'
import { TranscriptActivityReader } from './infrastructure/transcriptActivityReader'
import { TranscriptIndex } from './infrastructure/transcriptIndex'
import {
  BranchNotMergedError,
  GitWorktreeRemover,
  WorktreeDirtyError
} from './infrastructure/gitWorktreeRemover'
import { planRemoval } from './domain/removal'
import { chooseDeployTargets, deployProjectOf, describeDeploy, DeployTarget } from './domain/deploy'
import { ClaudeCodeLauncher, resumeInTerminal } from './infrastructure/claudeCodeLauncher'
import { ClaudeTranscriptVerifier } from './infrastructure/claudeTranscriptVerifier'
import { PendingSessionStore } from './infrastructure/pendingSessionStore'
import { FsWorktreeScanner } from './infrastructure/fsWorktreeScanner'
import { OutputLogger } from './infrastructure/outputLogger'
import { worktreeLabel } from './domain/display'
import { buildBelongsTo } from './domain/build'
import {
  SECTION,
  VscodeActivitySettings,
  VscodeGitHubSettings,
  VscodeTeamCitySettings,
  VscodeSettings
} from './infrastructure/vscodeSettings'
import { VscodeDirectoryWatcher } from './infrastructure/vscodeDirectoryWatcher'
import { Node, WorktreeTreeProvider } from './presentation/worktreeTreeProvider'

const VIEW_ID = 'worktreeWatcher.tree'

/**
 * Composition root. The only place that knows about every layer: it constructs
 * the adapters, injects them into the store, and wires the tree to VS Code.
 */
export function activate(context: vscode.ExtensionContext): void {
  const logger = new OutputLogger()
  // One index shared by everything that resolves a session id to its transcript.
  const transcriptIndex = new TranscriptIndex(path.join(os.homedir(), '.claude', 'projects'))
  const transcripts = new ClaudeTranscriptVerifier(undefined, transcriptIndex)
  const store = new WorktreeStore(
    new FsWorktreeScanner(transcripts),
    new VscodeDirectoryWatcher(),
    new VscodeSettings(),
    logger
  )

  const launcher = new ClaudeCodeLauncher(transcripts, new PendingSessionStore(), logger)
  // A cross-window request may have been aimed at this window before it existed.
  void launcher.consumePending()

  const gitHubSettings = new VscodeGitHubSettings()
  const pullRequests = new PullRequestStore(
    new GhPullRequestSource(gitHubSettings.organisation),
    gitHubSettings,
    logger
  )

  const remover = new GitWorktreeRemover()
  const activities = new ActivityStore(
    new TranscriptActivityReader(transcriptIndex),
    new VscodeDirectoryWatcher(),
    new VscodeActivitySettings(),
    logger
  )

  // TeamCity sits behind Google IAP, so it needs its own sign-in. Registered as
  // an authentication provider so that lives in VS Code's Accounts menu.
  const teamCitySettings = new VscodeTeamCitySettings()
  const iap = new GoogleIapAuthProvider(context.secrets, () => ({
    clientId: teamCitySettings.iapClientId,
    clientSecret: teamCitySettings.iapClientSecret,
    audience: teamCitySettings.iapAudience || undefined
  }))
  const buildSource = new TeamCityBuildSource(
      teamCitySettings,
      async () => {
        const token = await iap.idToken()
        logger.info(`TeamCity: signed in as ${(await iap.account()) ?? '<unknown>'}`)
        return token
      },
      async () => context.secrets.get(TEAMCITY_TOKEN_KEY)
  )
  const builds = new BuildStore(buildSource, teamCitySettings, logger)

  const provider = new WorktreeTreeProvider(store, transcripts, pullRequests, activities, builds)

  // The poller follows the scan: whatever branches exist are what it asks about.
  store.onDidChange((state) => pullRequests.setBranches(branchRefs(state.repositories)))
  // Redraw when statuses land; the tree reads them synchronously.
  pullRequests.onDidChange(() => provider.refresh())
  store.onDidChange((state) => activities.setSessions(sessionRefs(state.repositories)))
  store.onDidChange((state) => builds.setBranches(branchRefs(state.repositories)))
  builds.onDidChange(() => provider.refresh())
  activities.onDidChange(() => provider.refresh())
  const tree = vscode.window.createTreeView<Node>(VIEW_ID, { treeDataProvider: provider })

  // Scan and watch only while the view is on screen.
  let active = tree.visible ? activateAll() : undefined
  tree.onDidChangeVisibility(() => {
    active?.dispose()
    active = tree.visible ? activateAll() : undefined
  })

  function activateAll(): vscode.Disposable {
    const running = [
      store.activate(),
      pullRequests.activate(),
      activities.activate(),
      builds.activate()
    ]
    return new vscode.Disposable(() => running.forEach((item) => item.dispose()))
  }

  store.onDidChange((state) => {
    tree.message = state.status === 'error' ? `Scan failed: ${state.error}` : undefined
  })

  context.subscriptions.push(
    tree,
    store,
    logger,
    new vscode.Disposable(() => active?.dispose()),
    pullRequests,
    activities,
    builds,
    iap,
    vscode.authentication.registerAuthenticationProvider(
      IAP_AUTH_PROVIDER_ID,
      'TeamCity (Google IAP)',
      iap
    ),
    vscode.commands.registerCommand('worktreeWatcher.connectTeamCity', async () => {
      await connectTeamCity(context, teamCitySettings.url, () => buildSource.verify())
      builds.refresh()
    }),
    vscode.commands.registerCommand('worktreeWatcher.triggerDeploy', async (node?: Node) => {
      if (node?.kind !== 'worktree' || !node.worktree.branch) {
        return
      }
      const repositoryName = node.repository.name
      await triggerDeploy(node.worktree.branch, {
        // This branch's own builds are the cheapest source of the project.
        knownBuilds: builds.find(repositoryName, node.worktree.branch)?.builds,
        // Otherwise ask TeamCity about a branch that certainly has built: the
        // repository's main checkout. Its builds carry the same project.
        discoverProject: async () => {
          const mainBranch = node.repository.worktrees.find((w) => w.isMain)?.branch
          if (!mainBranch) {
            return undefined
          }
          const found = await buildSource.buildsForBranch(mainBranch)
          return deployProjectOf(found.filter((b) => buildBelongsTo(b, repositoryName)))
        },
        buildTypesIn: (projectId) => buildSource.buildTypesIn(projectId),
        trigger: (buildTypeId, branch) => buildSource.trigger(buildTypeId, branch),
        preference: teamCitySettings.deployBuildTypeNames,
        environment: teamCitySettings.deployEnvironment,
        onTriggered: () => builds.refresh(),
        logger
      })
    }),
    vscode.commands.registerCommand('worktreeWatcher.openBuild', (node?: Node) => {
      if (node?.kind !== 'worktree') {
        return
      }
      const found = builds.find(node.repository.name, node.worktree.branch)
      if (found?.builds[0]?.webUrl) {
        void vscode.env.openExternal(vscode.Uri.parse(found.builds[0].webUrl))
      }
    }),
    vscode.commands.registerCommand('worktreeWatcher.refresh', () => {
      store.refresh()
      pullRequests.refresh()
      builds.refresh()
    }),
    vscode.commands.registerCommand('worktreeWatcher.openPullRequest', (node?: Node) => {
      if (node?.kind !== 'worktree') {
        return
      }
      const pullRequest = pullRequests.find(node.repository.name, node.worktree.branch)
      if (pullRequest) {
        void vscode.env.openExternal(vscode.Uri.parse(pullRequest.url))
      }
    }),
    vscode.commands.registerCommand('worktreeWatcher.reveal', () =>
      vscode.commands.executeCommand(`${VIEW_ID}.focus`)
    ),
    vscode.commands.registerCommand('worktreeWatcher.openSettings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', SECTION)
    ),
    vscode.commands.registerCommand('worktreeWatcher.openInNewWindow', (node?: Node) =>
      withPath(node, (uri) =>
        vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true })
      )
    ),
    vscode.commands.registerCommand('worktreeWatcher.addToWorkspace', (node?: Node) =>
      withPath(node, (uri) => {
        vscode.workspace.updateWorkspaceFolders(
          vscode.workspace.workspaceFolders?.length ?? 0,
          0,
          { uri }
        )
      })
    ),
    vscode.commands.registerCommand('worktreeWatcher.revealInFinder', (node?: Node) =>
      withPath(node, (uri) => vscode.commands.executeCommand('revealFileInOS', uri))
    ),
    vscode.commands.registerCommand('worktreeWatcher.copyPath', (node?: Node) =>
      withPath(node, (uri) => vscode.env.clipboard.writeText(uri.fsPath))
    ),
    vscode.commands.registerCommand('worktreeWatcher.openClaudeSession', async (node?: Node) => {
      const session = await chooseSession(node, 'Open which Claude session?', transcripts)
      if (session && node?.kind === 'worktree') {
        await launcher.open(session.id, node.worktree.absolutePath)
      }
    }),
    vscode.commands.registerCommand('worktreeWatcher.resumeClaudeSession', async (node?: Node) => {
      const session = await chooseSession(node, 'Resume which Claude session?', transcripts)
      if (session && node?.kind === 'worktree') {
        resumeInTerminal(session.id, node.worktree.absolutePath)
      }
    }),
    vscode.commands.registerCommand('worktreeWatcher.removeWorktree', async (node?: Node) => {
      if (node?.kind !== 'worktree' || node.worktree.isMain) {
        return
      }
      await removeWorktree(node, {
        remover,
        pullRequest: pullRequests.find(node.repository.name, node.worktree.branch),
        logger,
        onRemoved: () => store.refresh()
      })
    }),
    vscode.commands.registerCommand('worktreeWatcher.copySessionId', async (node?: Node) => {
      const session = await chooseSession(node, 'Copy which session id?', transcripts)
      if (session) {
        await vscode.env.clipboard.writeText(session.id)
      }
    })
  )
}

/**
 * Single session resolves immediately; several prompt, newest first.
 *
 * Titles are read at pick time rather than during the scan, so a session renamed
 * in Claude Code's sidebar shows its new name without waiting for a rescan.
 */
async function chooseSession(
  node: Node | undefined,
  placeHolder: string,
  transcripts: ClaudeTranscriptVerifier
): Promise<ClaudeSession | undefined> {
  if (node?.kind !== 'worktree') {
    return undefined
  }
  const sessions = node.worktree.claudeSessions
  if (sessions.length <= 1) {
    return sessions[0]
  }

  const titles = await transcripts.titles(sessions.map((session) => session.id))

  const picked = await vscode.window.showQuickPick(
    sessions.map((session, index) => ({
      label: titles.get(session.id) ?? session.id,
      description: index === 0 ? 'most recent' : undefined,
      // The id stays visible, since it is what `claude --resume` takes.
      detail: [session.id, session.at].filter(Boolean).join('  ·  '),
      session
    })),
    { placeHolder, matchOnDetail: true, matchOnDescription: true }
  )
  return picked?.session
}

/**
 * Finds the deploy configuration for this branch's project and, after an explicit
 * confirmation naming it, queues it.
 *
 * The confirmation is not ceremony: this is the extension's only write to CI, the
 * button sits beside ones that merely open a window, and the configurations next
 * to the right one include Rollback and Flyway.
 */
async function triggerDeploy(
  branch: string,
  deps: {
    knownBuilds?: readonly { projectId?: string }[]
    discoverProject: () => Promise<string | undefined>
    buildTypesIn: (projectId: string) => Promise<readonly { id: string; name: string; projectId?: string; projectName?: string }[]>
    trigger: (buildTypeId: string, branch: string) => Promise<string | undefined>
    preference: readonly string[]
    environment: string
    onTriggered: () => void
    logger: OutputLogger
  }
): Promise<void> {
  let target: DeployTarget | undefined
  try {
    // A brand-new branch has no builds, so fall back to discovering the project
    // from the repository's main checkout — which has certainly built.
    const projectId =
      (deps.knownBuilds && deployProjectOf(deps.knownBuilds)) ??
      (await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Finding the TeamCity project…' },
        () => deps.discoverProject()
      ))

    if (!projectId) {
      void vscode.window.showWarningMessage(
        'No TeamCity project found for this repository — nothing on any of its branches has built.'
      )
      return
    }

    const targets = chooseDeployTargets(
      await deps.buildTypesIn(projectId),
      deps.preference,
      deps.environment
    )
    if (targets.length === 0) {
      void vscode.window.showWarningMessage(
        `No ${deps.environment || 'matching'} deploy configuration in ${projectId} matched ` +
          `${deps.preference.join(' or ')}.`
      )
      return
    }

    // Several environments can pass the guard; ask rather than choose.
    target =
      targets.length === 1
        ? targets[0]
        : (
            await vscode.window.showQuickPick(
              targets.map((candidate) => ({
                label: candidate.name,
                description: candidate.projectName,
                candidate
              })),
              { placeHolder: 'Which deploy configuration?' }
            )
          )?.candidate
    if (!target) {
      return
    }
  } catch (error) {
    void vscode.window.showErrorMessage(`Could not read TeamCity configurations: ${describeError(error)}`)
    return
  }

  const confirmed = await vscode.window.showWarningMessage(
    'Trigger a deploy?',
    { modal: true, detail: describeDeploy(target, branch) },
    'Trigger'
  )
  if (!confirmed) {
    return
  }

  try {
    const url = await deps.trigger(target.buildTypeId, branch)
    deps.logger.info(`triggered ${target.buildTypeId} on ${branch}`)
    const open = await vscode.window.showInformationMessage(
      `Queued ${target.name} for ${branch}.`,
      ...(url ? ['Open in TeamCity'] : [])
    )
    if (open && url) {
      void vscode.env.openExternal(vscode.Uri.parse(url))
    }
    deps.onTriggered()
  } catch (error) {
    void vscode.window.showErrorMessage(`Could not trigger the build: ${describeError(error)}`)
  }
}

/**
 * Confirms, then removes. The dialog carries the facts that differ per worktree —
 * a generic "are you sure?" just trains you to click through it.
 */
async function removeWorktree(
  node: Extract<Node, { kind: 'worktree' }>,
  deps: {
    remover: GitWorktreeRemover
    pullRequest?: PullRequest
    logger: OutputLogger
    onRemoved: () => void
  }
): Promise<void> {
  const { worktree } = node
  const { remover } = deps

  let mainRepository: string
  let status
  try {
    ;[mainRepository, status] = await Promise.all([
      remover.mainRepository(worktree.absolutePath),
      remover.status(worktree.absolutePath)
    ])
  } catch (error) {
    void vscode.window.showErrorMessage(`Could not inspect the worktree: ${describeError(error)}`)
    return
  }

  const plan = planRemoval({
    label: worktreeLabel(worktree),
    absolutePath: worktree.absolutePath,
    branch: worktree.branch,
    pullRequest: deps.pullRequest,
    status,
    homePath: os.homedir()
  })

  const actions = plan.canDeleteBranch ? ['Remove', 'Remove and Delete Branch'] : ['Remove']
  const choice = await vscode.window.showWarningMessage(
    plan.title,
    { modal: true, detail: plan.detail },
    ...actions
  )
  if (!choice) {
    return
  }

  try {
    await remover.remove(mainRepository, worktree.absolutePath, false)
  } catch (error) {
    if (!(error instanceof WorktreeDirtyError)) {
      void vscode.window.showErrorMessage(`Could not remove the worktree: ${describeError(error)}`)
      return
    }
    // Git refused because of uncommitted work. Force only after saying so.
    const forced = await vscode.window.showWarningMessage(
      `“${worktreeLabel(worktree)}” has uncommitted changes.`,
      {
        modal: true,
        detail: `${status.dirtyFiles} file(s) would be discarded permanently. This cannot be undone.`
      },
      'Discard Changes and Remove'
    )
    if (!forced) {
      return
    }
    try {
      await remover.remove(mainRepository, worktree.absolutePath, true)
    } catch (forceError) {
      void vscode.window.showErrorMessage(`Could not remove the worktree: ${describeError(forceError)}`)
      return
    }
  }

  deps.logger.info(`removed worktree ${worktree.absolutePath}`)

  if (choice === 'Remove and Delete Branch' && worktree.branch) {
    await deleteBranch(mainRepository, worktree.branch, remover)
  }
  deps.onRemoved()
}

async function deleteBranch(
  mainRepository: string,
  branch: string,
  remover: GitWorktreeRemover
): Promise<void> {
  try {
    await remover.deleteBranch(mainRepository, branch, false)
  } catch (error) {
    if (!(error instanceof BranchNotMergedError)) {
      void vscode.window.showWarningMessage(`Worktree removed, but the branch was not deleted: ${describeError(error)}`)
      return
    }
    // Squash-merged PRs look unmerged to git, so this is common — but still ask.
    const forced = await vscode.window.showWarningMessage(
      `Branch “${branch}” is not fully merged locally.`,
      {
        modal: true,
        detail: 'This is normal for squash-merged pull requests. Delete it anyway?'
      },
      'Delete Branch'
    )
    if (forced) {
      try {
        await remover.deleteBranch(mainRepository, branch, true)
      } catch (forceError) {
        void vscode.window.showWarningMessage(`Branch not deleted: ${describeError(forceError)}`)
      }
    }
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const TEAMCITY_TOKEN_KEY = 'worktreeWatcher.teamCity.token'

/**
 * Collects the two credentials TeamCity needs: its own access token (kept in the
 * OS keychain, never in settings) and a Google sign-in for the proxy in front of
 * it. Deliberately a command rather than anything in the Settings screen — VS Code
 * sanitises command links there, so a button in Settings cannot work.
 */
async function connectTeamCity(
  context: vscode.ExtensionContext,
  url: string,
  verify: () => Promise<string | undefined>
): Promise<void> {
  if (!url) {
    void vscode.window.showErrorMessage('Set worktreeWatcher.teamCity.url first.')
    return
  }

  const token = await vscode.window.showInputBox({
    title: 'TeamCity access token',
    prompt: `Create one in TeamCity → Your Profile → Access Tokens (${url})`,
    password: true,
    ignoreFocusOut: true
  })
  if (!token) {
    return
  }
  await context.secrets.store(TEAMCITY_TOKEN_KEY, token.trim())

  try {
    // createIfNone drives the browser consent through the registered provider.
    await vscode.authentication.getSession(IAP_AUTH_PROVIDER_ID, [], { createIfNone: true })
  } catch (error) {
    void vscode.window.showErrorMessage(
      `Google sign-in failed: ${error instanceof Error ? error.message : String(error)}`
    )
    return
  }

  // Prove it works now rather than leaving a silent failure for the next poll.
  const failure = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Checking TeamCity access…' },
    () => verify()
  )

  if (failure) {
    void vscode.window.showErrorMessage(`Connected, but TeamCity refused the request. ${failure}`)
    return
  }
  void vscode.window.showInformationMessage(
    'TeamCity connected and verified. Set worktreeWatcher.teamCity.enabled to show build status.'
  )
}

/** Every recorded session, so its transcript can be watched and read. */
function sessionRefs(
  repositories: readonly { worktrees: readonly { absolutePath: string; claudeSessions: readonly { id: string }[] }[] }[]
): Array<{ sessionId: string; worktreePath: string }> {
  return repositories.flatMap((repository) =>
    repository.worktrees.flatMap((worktree) =>
      worktree.claudeSessions.map((session) => ({
        sessionId: session.id,
        worktreePath: worktree.absolutePath
      }))
    )
  )
}

/** Every non-main worktree with a branch, as something the poller can look up. */
function branchRefs(repositories: readonly { name: string; worktrees: readonly { branch?: string; isMain: boolean }[] }[]): BranchRef[] {
  return repositories.flatMap((repository) =>
    repository.worktrees
      .filter((worktree) => !worktree.isMain && worktree.branch)
      .map((worktree) => ({ repository: repository.name, branch: worktree.branch as string }))
  )
}

function withPath(node: Node | undefined, action: (uri: vscode.Uri) => unknown): void {
  if (!node) {
    return
  }
  const target =
    node.kind === 'repository' ? node.repository.worktreesPath : node.worktree.absolutePath
  void action(vscode.Uri.file(target))
}

export function deactivate(): void {}
