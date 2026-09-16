import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as vscode from 'vscode'

import { ActivityStore } from './application/activityStore'
import { PullRequestStore } from './application/pullRequestStore'
import { ReviewRequestStore } from './application/reviewRequestStore'
import { WorktreeStore } from './application/worktreeStore'
import { ClaudeSession, Repository, WORKTREES_SUFFIX } from './domain/model'
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
import {
  CleanUpCandidate,
  CleanUpOutcome,
  candidateDescription,
  confirmCleanUp,
  selectStale,
  summariseCleanUp
} from './domain/cleanUp'
import {
  CheckoutCandidate,
  CheckoutOutcome,
  QueryOptions,
  ReviewRequest,
  authorIcon,
  botSessionTooltip,
  candidateDescription as reviewRequestDescription,
  planCheckouts,
  summariseCheckouts
} from './domain/reviewRequests'
import { GhReviewRequestSource } from './infrastructure/ghReviewRequestSource'
import {
  BranchAlreadyCheckedOutError,
  GitWorktreeCreator
} from './infrastructure/gitWorktreeCreator'
import { chooseDeployTargets, deployProjectOf, describeDeploy, DeployTarget } from './domain/deploy'
import {
  ClaudeCodeLauncher,
  resumeInTerminal,
  startClaudeInTerminal
} from './infrastructure/claudeCodeLauncher'
import { ClaudeTranscriptVerifier } from './infrastructure/claudeTranscriptVerifier'
import { PendingSessionStore } from './infrastructure/pendingSessionStore'
import { FsWorktreeScanner } from './infrastructure/fsWorktreeScanner'
import { OutputLogger } from './infrastructure/outputLogger'
import { tildify, worktreeLabel } from './domain/display'
import { buildBelongsTo } from './domain/build'
import {
  SECTION,
  VscodeActivitySettings,
  VscodeGitHubSettings,
  VscodeTeamCitySettings,
  VscodeSettings
} from './infrastructure/vscodeSettings'
import { VscodeDirectoryWatcher } from './infrastructure/vscodeDirectoryWatcher'
import { ReviewRequestStatusBar } from './presentation/reviewRequestStatusBar'
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
  const settings = new VscodeSettings()
  const store = new WorktreeStore(
    new FsWorktreeScanner(transcripts),
    new VscodeDirectoryWatcher(),
    settings,
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

  // One search per cycle, independent of worktree count. Feeds the header text,
  // and the checkout list reads straight off it rather than searching again.
  const reviewRequests = new ReviewRequestStore(
    {
      fetch: () =>
        new GhReviewRequestSource(
          gitHubSettings.organisation,
          reviewQueryOptions(settings)
        ).fetch()
    },
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
      builds.activate(),
      reviewRequests.activate()
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
    // Same command as the title-bar button, so either route opens the list.
    new ReviewRequestStatusBar(reviewRequests, 'worktreeWatcher.checkOutReviewRequests'),
    new vscode.Disposable(() => active?.dispose()),
    pullRequests,
    activities,
    builds,
    reviewRequests,
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
    vscode.commands.registerCommand('worktreeWatcher.checkOutReviewRequests', async () => {
      await checkOutReviewRequests({
        // Reuses the polled result, so the list opens instantly instead of
        // repeating a search the store has already run.
        source: reviewRequests,
        creator: new GitWorktreeCreator(),
        rootPath: settings.rootPath,
        organisation: gitHubSettings.organisation,
        botWorkspace: settings.botWorkspace,
        transcripts,
        launcher,
        logger,
        onCreated: () => {
          store.refresh()
          // One fewer waiting on you, so the badge should say so now.
          reviewRequests.refresh()
        }
      })
    }),
    vscode.commands.registerCommand('worktreeWatcher.cleanUpWorktrees', async (node?: Node) => {
      if (node?.kind !== 'repository') {
        return
      }
      await cleanUpWorktrees(node.repository, {
        remover,
        staleDays: settings.staleDays,
        pullRequest: (branch) => pullRequests.find(node.repository.name, branch),
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
/**
 * Lists pull requests waiting on your review and checks out worktrees for the
 * ones you tick.
 *
 * The inverse of everything else here: these branches have no worktree yet, which
 * is the whole point — the alternative is copying a branch name out of a browser
 * for each one.
 */
async function checkOutReviewRequests(deps: {
  source: { ensure(): Promise<readonly ReviewRequest[]> }
  creator: GitWorktreeCreator
  rootPath: string
  organisation: string
  botWorkspace: string
  transcripts: ClaudeTranscriptVerifier
  launcher: ClaudeCodeLauncher
  logger: OutputLogger
  onCreated: () => void
}): Promise<void> {
  if (!deps.organisation) {
    void vscode.window.showWarningMessage(
      'Set “worktreeWatcher.github.organisation” before looking for review requests.'
    )
    return
  }

  let pullRequests
  try {
    // Usually resolves from the polled result without touching the network, so
    // the progress notification never appears.
    pullRequests = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: 'Finding pull requests awaiting your review…'
      },
      () => deps.source.ensure()
    )
  } catch (error) {
    void vscode.window.showErrorMessage(`Could not reach GitHub: ${describeError(error)}`)
    return
  }

  if (pullRequests.length === 0) {
    void vscode.window.showInformationMessage(
      'No pull requests are waiting on your review.'
    )
    return
  }

  // Resolving each repository is a couple of stats, so it runs for all of them
  // at once rather than blocking the list on a sequential walk.
  const local = new Map<string, { mainCheckout?: string; worktreeExists: boolean }>()
  await Promise.all(
    pullRequests.map(async (pullRequest) => {
      const mainCheckout = await deps.creator.mainCheckout(deps.rootPath, pullRequest.repository)
      const worktreeExists = mainCheckout
        ? await deps.creator.exists(
            `${mainCheckout}${WORKTREES_SUFFIX}/${pullRequest.branch}`
          )
        : false
      local.set(`${pullRequest.repository}#${pullRequest.branch}`, { mainCheckout, worktreeExists })
    })
  )

  const candidates = planCheckouts(
    pullRequests,
    (pullRequest) =>
      local.get(`${pullRequest.repository}#${pullRequest.branch}`) ?? { worktreeExists: false }
  )

  // Read before the list is shown, so a row can say whether its button resumes
  // or starts — the worktree rows know that from the scan, and these should not
  // be the odd ones out. One readdir plus, at most, one transcript read.
  const botSessions = await deps.transcripts.sessionsIn(deps.botWorkspace)
  const latestBotTitle = botSessions[0]
    ? await deps.transcripts.title(botSessions[0].id)
    : undefined

  const selected = await pickReviewRequests(candidates, {
    botWorkspace: deps.botWorkspace,
    botSessions,
    latestBotTitle,
    logger: deps.logger,
    openBotSession: (pullRequest) =>
      openBotWorkspaceSession(pullRequest, {
        workspace: deps.botWorkspace,
        transcripts: deps.transcripts,
        launcher: deps.launcher,
        logger: deps.logger
      })
  })
  if (selected.length === 0) {
    return
  }
  const blocked = selected.filter((candidate) => !candidate.ready)
  if (blocked.length === selected.length) {
    void vscode.window.showWarningMessage(
      'Nothing to do — every selected pull request is already checked out or its repository is not cloned.'
    )
    return
  }

  const outcomes = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Creating worktrees…' },
    (progress) => createEach(selected, deps.creator, deps.logger, progress)
  )

  deps.onCreated()
  reportCheckouts(outcomes)
}



/**
 * Opens a Claude session in the workspace kept for dependency bumps.
 *
 * The same shape as the worktree row's **Open Claude Session**: sessions for the
 * directory, one resolved straight away, several offered as a list. The only
 * difference is where the sessions come from — a worktree has a git sidecar, a
 * plain directory has its Claude project folder.
 *
 * The workspace is created if missing. It is a scratch directory by design: a
 * bot's pull request is a dependency bump to be judged, and the repository it
 * belongs to is reached through a worktree from here, not by working in place.
 */
async function openBotWorkspaceSession(
  pullRequest: ReviewRequest,
  deps: {
    workspace: string
    transcripts: ClaudeTranscriptVerifier
    launcher: ClaudeCodeLauncher
    logger: OutputLogger
  }
): Promise<void> {
  try {
    await fs.mkdir(deps.workspace, { recursive: true })
  } catch (error) {
    void vscode.window.showErrorMessage(
      `Could not create ${deps.workspace}: ${describeError(error)}`
    )
    return
  }

  const sessions = await deps.transcripts.sessionsIn(deps.workspace)
  deps.logger.info(`bot workspace ${deps.workspace}: ${sessions.length} session(s)`)

  const session = await chooseSessionFrom(
    sessions,
    deps.transcripts,
    `Which session for ${pullRequest.repository} #${pullRequest.number}?`
  )

  if (session) {
    await deps.launcher.open(session.id, deps.workspace)
    return
  }

  if (sessions.length > 0) {
    // There were sessions and the list was dismissed — that is a cancel, not a
    // request for a new one.
    return
  }

  // Nothing has ever run here. A session cannot be created by id, so the window
  // opens and Claude is started in a terminal there.
  await vscode.commands.executeCommand(
    'vscode.openFolder',
    vscode.Uri.file(deps.workspace),
    { forceNewWindow: true }
  )
  startClaudeInTerminal(deps.workspace)
}

/** As `chooseSession`, but over sessions already in hand. */
async function chooseSessionFrom(
  sessions: readonly ClaudeSession[],
  transcripts: ClaudeTranscriptVerifier,
  placeHolder: string
): Promise<ClaudeSession | undefined> {
  if (sessions.length <= 1) {
    return sessions[0]
  }

  const titles = await transcripts.titles(sessions.map((session) => session.id))
  const picked = await vscode.window.showQuickPick(
    sessions.map((session, index) => ({
      label: titles.get(session.id) ?? session.id,
      description: index === 0 ? 'most recent' : undefined,
      detail: [session.id, session.at].filter(Boolean).join('  ·  '),
      session
    })),
    { placeHolder, matchOnDetail: true, matchOnDescription: true }
  )
  return picked?.session
}

/** Per-item actions. Identity matters — the handler compares by reference. */
const OPEN_ON_GITHUB: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon('link-external'),
  tooltip: 'Open on GitHub'
}
interface ReviewQuickPickItem extends vscode.QuickPickItem {
  readonly candidate: CheckoutCandidate
}

/**
 * The checklist, with per-item buttons.
 *
 * Built with `createQuickPick` rather than `showQuickPick` because item buttons
 * are only rendered by the former — the typings say so outright. The extra cost
 * is owning the lifetime, which is why everything resolves through one promise
 * and disposes in `onDidHide`.
 *
 * The buttons exist because the row itself cannot carry these actions: with
 * `canSelectMany`, clicking a row toggles its checkbox. Anything else has to be
 * a button.
 */
async function pickReviewRequests(
  candidates: readonly CheckoutCandidate[],
  deps: {
    botWorkspace: string
    botSessions: readonly ClaudeSession[]
    latestBotTitle?: string
    openBotSession: (pullRequest: ReviewRequest) => Promise<void>
    logger: OutputLogger
  }
): Promise<readonly CheckoutCandidate[]> {
  const now = Date.now()

  // Built once: the workspace is shared, so every bot row carries the same
  // button, and the handler matches it by reference.
  const botButton: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon(deps.botSessions.length > 0 ? 'comment-discussion' : 'add'),
    tooltip: botSessionTooltip({
      count: deps.botSessions.length,
      latestTitle: deps.latestBotTitle,
      workspace: tildify(deps.botWorkspace, os.homedir())
    })
  }
  const quickPick = vscode.window.createQuickPick<ReviewQuickPickItem>()
  quickPick.title = 'Pull requests awaiting your review'
  quickPick.placeholder = 'Ticked items get a worktree under <repo>.worktrees/'
  quickPick.canSelectMany = true
  quickPick.matchOnDescription = true
  quickPick.matchOnDetail = true

  quickPick.items = candidates.map((candidate) => ({
    // The codicon marks bot against human at a glance, which is the first thing
    // you sort a review queue by.
    label: `${authorIcon(candidate.pullRequest)}  ${candidate.pullRequest.title}`,
    description: reviewRequestDescription(candidate, now),
    detail: candidate.warning ?? candidate.pullRequest.branch,
    buttons: candidate.pullRequest.authorIsBot
      ? [OPEN_ON_GITHUB, botButton]
      : // The bot workspace is for dependency bumps; a colleague's pull request
        // belongs in its own repository's worktree, not a shared scratch folder.
        [OPEN_ON_GITHUB],
    candidate
  }))
  // Only ones that can actually be created start ticked.
  quickPick.selectedItems = quickPick.items.filter((item) => item.candidate.ready)

  return new Promise<readonly CheckoutCandidate[]>((resolve) => {
    let accepted: readonly CheckoutCandidate[] = []

    quickPick.onDidTriggerItemButton(async (event) => {
      const { pullRequest } = event.item.candidate
      if (event.button === OPEN_ON_GITHUB) {
        await vscode.env.openExternal(vscode.Uri.parse(pullRequest.url))
        return
      }
      if (event.button === botButton) {
        // Hide first: opening a window while the picker is up leaves it
        // stranded over the new editor.
        quickPick.hide()
        await deps.openBotSession(pullRequest)
      }
    })

    quickPick.onDidAccept(() => {
      accepted = quickPick.selectedItems.map((item) => item.candidate)
      quickPick.hide()
    })

    quickPick.onDidHide(() => {
      quickPick.dispose()
      resolve(accepted)
    })

    quickPick.show()
  })
}

/**
 * Creates each worktree in turn.
 *
 * Sequential for the same reason clean-up is: `git worktree add` writes to the
 * shared `.git/worktrees` administrative directory. Several of these may also be
 * fetching from the same repository, where parallelism buys nothing anyway.
 */
async function createEach(
  selected: readonly CheckoutCandidate[],
  creator: GitWorktreeCreator,
  logger: OutputLogger,
  progress: vscode.Progress<{ message?: string }>
): Promise<CheckoutOutcome[]> {
  const outcomes: CheckoutOutcome[] = []
  const actionable = selected.filter((candidate) => candidate.ready)

  for (const [index, candidate] of actionable.entries()) {
    const { pullRequest, targetPath } = candidate
    const label = `${pullRequest.repository} #${pullRequest.number}`
    progress.report({ message: `${index + 1}/${actionable.length} — ${label}` })

    if (!targetPath) {
      outcomes.push({ label, created: false, reason: 'no local clone' })
      continue
    }

    try {
      const mainCheckout = targetPath.slice(0, targetPath.indexOf(WORKTREES_SUFFIX))
      await creator.create(mainCheckout, pullRequest.branch, targetPath)
      logger.info(`created worktree ${targetPath}`)
      outcomes.push({ label, created: true, path: targetPath })
    } catch (error) {
      const reason =
        error instanceof BranchAlreadyCheckedOutError
          ? 'branch already checked out in another worktree'
          : describeError(error)
      logger.info(`could not create worktree for ${label}: ${reason}`)
      outcomes.push({ label, created: false, reason })
    }
  }

  return outcomes
}

/** Says what happened, offering to open a single new worktree straight away. */
function reportCheckouts(outcomes: readonly CheckoutOutcome[]): void {
  const created = outcomes.filter((outcome) => outcome.created)
  const failed = outcomes.filter((outcome) => !outcome.created)
  const summary = summariseCheckouts(outcomes)

  if (failed.length > 0) {
    void vscode.window
      .showWarningMessage(summary, 'Show Details')
      .then((choice) => {
        if (choice) {
          void vscode.window.showWarningMessage(summary, {
            modal: true,
            detail: failed.map((outcome) => `${outcome.label} — ${outcome.reason}`).join('\n')
          })
        }
      })
    return
  }

  // One worktree has an obvious next step; several do not.
  const single = created.length === 1 ? created[0] : undefined
  void vscode.window
    .showInformationMessage(summary, ...(single ? ['Open in New Window'] : []))
    .then((choice) => {
      if (choice && single?.path) {
        void vscode.commands.executeCommand(
          'vscode.openFolder',
          vscode.Uri.file(single.path),
          { forceNewWindow: true }
        )
      }
    })
}

/**
 * Offers every worktree in a repository that has gone quiet, and removes the
 * ones you tick.
 *
 * Deliberately narrower than the single-worktree flow: it never forces past a
 * dirty tree and never deletes a branch. Both are reasonable answers for one
 * worktree you are looking straight at, and a poor bet across a checklist —
 * so a dirty worktree is reported as skipped and left for the per-item flow,
 * which asks about discarding changes by name.
 */
async function cleanUpWorktrees(
  repository: Repository,
  deps: {
    remover: GitWorktreeRemover
    staleDays: number
    pullRequest: (branch: string | undefined) => PullRequest | undefined
    logger: OutputLogger
    onRemoved: () => void
  }
): Promise<void> {
  const { remover } = deps
  const worktrees = repository.worktrees.filter((worktree) => !worktree.isMain)
  if (worktrees.length === 0) {
    void vscode.window.showInformationMessage(`${repository.name} has no worktrees.`)
    return
  }

  // Inspecting is several git calls per worktree, so it runs behind progress and
  // all at once rather than in sequence.
  const inspected = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Checking ${worktrees.length} worktree(s) in ${repository.name}…`
    },
    () =>
      Promise.all(
        worktrees.map(async (worktree) => ({
          worktree,
          ...(await remover.age(worktree.absolutePath)),
          // A worktree git cannot read is reported as clean; `selectStale` still
          // needs an age before it will offer it, so this cannot invent a victim.
          status: await remover
            .status(worktree.absolutePath)
            .catch(() => ({ dirtyFiles: 0, unpushedCommits: 0 })),
          pullRequest: deps.pullRequest(worktree.branch)
        }))
      )
  )

  const candidates = selectStale(inspected, { now: Date.now(), staleDays: deps.staleDays })
  if (candidates.length === 0) {
    void vscode.window.showInformationMessage(
      `No worktrees in ${repository.name} have been idle for ${deps.staleDays} days.`
    )
    return
  }

  const picked = await vscode.window.showQuickPick(
    candidates.map((candidate) => ({
      label: worktreeLabel(candidate.worktree),
      description: candidateDescription(candidate),
      detail: candidate.warning,
      // Only clean, fully pushed worktrees start ticked. Anything that could
      // strand work is an explicit choice.
      picked: candidate.safe,
      candidate
    })),
    {
      canPickMany: true,
      title: `Idle worktrees in ${repository.name}`,
      placeHolder: `Idle for ${deps.staleDays} days or more — ticked items will be removed`,
      matchOnDescription: true,
      matchOnDetail: true
    }
  )
  if (!picked || picked.length === 0) {
    return
  }

  const selected = picked.map((item) => item.candidate)
  const confirmation = confirmCleanUp(repository.name, selected)
  const choice = await vscode.window.showWarningMessage(
    confirmation.title,
    { modal: true, detail: confirmation.detail },
    `Remove ${selected.length}`
  )
  if (!choice) {
    return
  }

  const outcomes = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Removing worktrees…' },
    () => removeEach(selected, remover, deps.logger)
  )

  deps.onRemoved()
  reportCleanUp(outcomes)
}

/**
 * Removes each selection in turn.
 *
 * Sequential on purpose: `git worktree remove` writes to the shared
 * `.git/worktrees` administrative directory, so parallel removals in one
 * repository race each other.
 */
async function removeEach(
  selected: readonly CleanUpCandidate[],
  remover: GitWorktreeRemover,
  logger: OutputLogger
): Promise<CleanUpOutcome[]> {
  const outcomes: CleanUpOutcome[] = []

  for (const candidate of selected) {
    const label = worktreeLabel(candidate.worktree)
    try {
      // Resolved per worktree and before removal — afterwards the directory,
      // and the pointer back to the main checkout, are gone.
      const main = await remover.mainRepository(candidate.worktree.absolutePath)
      await remover.remove(main, candidate.worktree.absolutePath, false)
      logger.info(`cleaned up worktree ${candidate.worktree.absolutePath}`)
      outcomes.push({ label, removed: true })
    } catch (error) {
      const reason =
        error instanceof WorktreeDirtyError ? 'uncommitted changes' : describeError(error)
      logger.info(`could not remove ${candidate.worktree.absolutePath}: ${reason}`)
      outcomes.push({ label, removed: false, reason })
    }
  }

  return outcomes
}

/** Says what happened, and shows the detail only when something went wrong. */
function reportCleanUp(outcomes: readonly CleanUpOutcome[]): void {
  const failed = outcomes.filter((outcome) => !outcome.removed)
  const summary = summariseCleanUp(outcomes)

  if (failed.length === 0) {
    void vscode.window.showInformationMessage(summary)
    return
  }

  void vscode.window
    .showWarningMessage(summary, 'Show Details')
    .then((choice) => {
      if (choice) {
        void vscode.window.showWarningMessage(summary, {
          modal: true,
          detail: failed.map((outcome) => `${outcome.label} — ${outcome.reason}`).join('\n')
        })
      }
    })
}

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

/** Reads the review-request filters out of settings in one place. */
function reviewQueryOptions(settings: VscodeSettings): QueryOptions {
  return {
    scope: settings.reviewScope,
    excludeDrafts: settings.excludeDraftReviews,
    excludeReviewed: settings.excludeReviewedByMe
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
