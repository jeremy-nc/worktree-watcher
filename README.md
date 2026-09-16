# Worktree Watcher

A bottom-panel tree listing every git worktree under a watched directory, grouped by
repository and labelled by branch.

```
▾ report-service                                    2 worktrees
     main                                                        ~/Code/report-service
     feature/ABC-123-cleanup-pubsub-push-handlers   ABC-123
▾ widget-service                                            3 worktrees
     main                                                        ~/Code/widget-service
     chore/dependabot-config-compliance
     dependabot/gradle/minor-and-patch-bea9c3e41d
```

The dimmed text on the right is the on-disk folder, shown **only when it disagrees with
the branch** — the `ABC-123` row above is a worktree actually sitting on
`feature/ABC-123-cleanup-…`. Matching folders stay quiet.

## The convention it codifies

```
<root>/<repo>                    main checkout      → .git is a DIRECTORY
<root>/<repo>.worktrees/         worktree container
<root>/<repo>.worktrees/**/      a worktree         → .git is a FILE
```

Three properties of the real layout drive the implementation:

- **The folder name is not the branch.** Nesting under `.worktrees` is arbitrary, and a
  worktree in a folder called `ABC-123` may be on `feature/ABC-123-cleanup-…`. The
  branch is always read from git.
- **Depth varies.** `chore/dependabot-config-compliance` is two levels;
  `dependabot/terraform/infrastructure/minor-and-patch-0ba…` is four. The scanner
  recurses until it finds a `.git` file and prunes branches containing none.
- **Empty prefix directories linger** after `git worktree remove`. Repositories with no
  live worktrees are hidden unless `showEmptyRepositories` is on.

Reading a branch takes no subprocess — two file reads:

```
<worktree>/.git   →  "gitdir: <repo>/.git/worktrees/<name>"
  └─ <that>/HEAD  →  "ref: refs/heads/feature/ABC-123-cleanup-…"
```

## GitHub pull request status

Each worktree row shows the pull request for its branch:

```
▾ feed-importer                                    3 worktrees
     dependabot/gradle/minor-and-patch-8e69e0ae7a    #627 closed
     fix/ABC-984-web-client-5xx                      #469 open · approved
     fix/ABC-983-partition-writer                    #468 open · review required
```

Hover for the title, checks, review decision and a link; right-click for **Open
Pull Request**. A merged or closed PR means nothing is left to push, which the
tooltip says plainly — it is the signal that a worktree can go.

### Why the review needs two sources

`reviewDecision` is the obvious field, and on its own it is wrong for half our
repositories. It is **not** "has anyone approved this": it is GitHub's verdict
relative to *required* reviewers, so a repository with no required-review rule
reports `null` however many approvals a pull request collects. A PR sitting there
approved reads as plain `open`.

So both are read, and `reviewDecision` wins where it exists:

| | `reviewDecision` | `latestReviews` | Row |
|---|---|---|---|
| Branch protection on | `REVIEW_REQUIRED` | — | `review required` |
| No required-review rule | `null` | one `APPROVED` | `approved` |
| Mixed opinions | `null` | `APPROVED` + `CHANGES_REQUESTED` | `changes requested` |

`latestReviews` is the most recent review *per reviewer*, so a dismissed or
superseded one does not linger. Among them, changes-requested beats approved —
the two coexist from different reviewers and the blocking one is the news.
`commented`, `dismissed` and `pending` carry no verdict at all, which matters
because bot reviewers comment constantly.

The review disappears from the row once a PR is merged or closed: the outcome is
settled, so how it got there is history and only costs space beside the branch
name. It costs no extra request — one more field on the existing query.

**Auth rides the `gh` CLI's own keyring token**, so there is nothing to configure
and no token stored in settings. If `gh` is missing or signed out the feature goes
quiet and the rest of the panel is unaffected.

**One request per poll, whatever the worktree count.** The query is a single
GraphQL call with one aliased search per repository and the worktree branches as
`head:` terms, which GitHub ORs within a query:

```graphql
r0: search(query: "is:pr repo:acme/widget-service head:chore/a head:chore/b", …)
r1: search(query: "is:pr repo:acme/api-gateway head:feature/c", …)
```

Measured on a real `~/Code`: 17 branches → 15 PRs in one ~3.8s call.

Polling only runs while the panel is visible, backs off 4× (capped at 30 min) on
failure, and keeps the last good results rather than blanking on error. The branch
set is taken from each scan, so a refetch happens when worktrees change, not on a
timer alone.

| Setting | Default | |
|---|---|---|
| `worktreeWatcher.github.enabled` | `true` | Turn the feature off entirely. |
| `worktreeWatcher.github.organisation` | `acme` | Org that owns the repos. |
| `worktreeWatcher.github.pollMinutes` | `5` | Minutes between polls. |
| `worktreeWatcher.reviewRequests.scope` | `personal` | `personal` names only you; `team` also matches any team you are in. |
| `worktreeWatcher.reviewRequests.excludeDrafts` | `true` | Leave out drafts. |
| `worktreeWatcher.reviewRequests.excludeReviewed` | `true` | Leave out ones you have already reviewed. |

Branch and repository names are validated against `^[A-Za-z0-9._\-/]+$` before
going into the query — anything else is dropped rather than escaped, since a git
ref never legitimately contains characters that could break out of a GraphQL
string or a search qualifier.

## TeamCity build status

Off by default. When on, each row shows the rolled-up build status for its branch,
and hovering lists every build configuration with links into TeamCity:

```
feature/ABC-123-cleanup    #1302 open · REA / Build failed · waiting for you
```

### Setting it up

1. **Settings** — `worktreeWatcher.teamCity.url`, `.iapClientId`, `.iapClientSecret`
2. **Command palette** → **Worktrees: Connect to TeamCity…** — prompts for a
   TeamCity access token (Your Profile → Access Tokens), then opens the browser
   for Google sign-in
3. **Settings** — set `worktreeWatcher.teamCity.enabled` to `true`

Sign-in is **not** a button in the Settings screen: VS Code sanitises `command:`
links in setting descriptions, so one cannot work there. It lives in the command
palette and, once connected, in VS Code's **Accounts** menu, where you can also
sign out.

### The auth flow

TeamCity sits behind Google's Identity-Aware Proxy, so **every request carries two
credentials** — one for the proxy, one for TeamCity itself:

```
GET https://teamcity.example.com/app/rest/builds
  Proxy-Authorization: Bearer <google id_token>   ← satisfies IAP
  Authorization:       Bearer <teamcity token>    ← satisfies TeamCity
```

Obtaining the first one is the whole dance:

```
Connect to TeamCity…
  │
  ├─ prompt for TeamCity token ─────────────────► SecretStorage (OS keychain)
  │
  └─ getSession(createIfNone) ─► GoogleIapAuthProvider.createSession()
        │
        ├─ start loopback server on 127.0.0.1:8723-8726
        ├─ openExternal(accounts.google.com/o/oauth2/v2/auth
        │                 ?client_id&redirect_uri=http://localhost:<port>/
        │                 &scope=openid email&access_type=offline
        │                 &code_challenge=<S256>&state=<nonce>)
        │
        ├─ browser consent ─► redirect back with ?code&state
        ├─ verify state, shut the server down
        └─ POST oauth2.googleapis.com/token (code + verifier)
              └─► refresh_token ─────────────────► SecretStorage (OS keychain)

every request afterwards
  └─ POST oauth2.googleapis.com/token (grant_type=refresh_token)
        └─► id_token, cached in memory until 5 min before expiry
```

PKCE (`S256`) and a `state` nonce are used because the redirect is a loopback
listener anything local could reach. The `id_token` is never persisted — it is
minted from the refresh token on demand, so a stale one is never sent.

**The redirect URI must match a registered one exactly.** This client rejects
anything else with `redirect_uri_mismatch`, which means it is a *Web application*
client rather than a Desktop one — a Desktop client would accept any loopback port
under RFC 8252. So `http://localhost:<port>/` is required: `127.0.0.1` is a
different string, and the trailing slash matters. The ports 8723–8726 are not
arbitrary either; they are the registered set.

The server nonetheless *binds* `127.0.0.1` while the redirect says `localhost`.
That mismatch is deliberate — it is what terminal-project's `wsgiref` server does,
and it is the combination proven to work against this client.

### Where each secret lives

| | Where | Why |
|---|---|---|
| TeamCity access token | `SecretStorage` (OS keychain) | A bearer credential for the whole TeamCity API. |
| Google refresh token | `SecretStorage` (OS keychain) | Same — it mints identities indefinitely until revoked. |
| Google `id_token` | Memory only | Short-lived; re-minted per request, never written down. |
| IAP client id + secret | Settings | A desktop OAuth client's secret is **not** confidential (RFC 8252 §8.5) — an installed app cannot keep one. Security comes from PKCE plus the loopback redirect, not from hiding it. |

**Why not put the token in settings?** Not because of Settings Sync — that is
avoidable. VS Code excludes a setting from sync when it declares `ignoreSync`, or
a scope of `machine` (2) or `machine-overridable` (7):

```js
(property.ignoreSync || scope === 2 || scope === 7) && ignored.add(key)
```

The real reasons are that `settings.json` is plaintext on disk readable by any
process running as you, the Settings UI renders the value in the clear during any
screen share, and settings files get copied, backed up and pasted into issues.
`SecretStorage` is OS-keychain backed, so none of those apply.

The cost is that a token in the keychain cannot be inspected or hand-edited — which
is why rotating one is just re-running **Connect to TeamCity…**.

### Its own consent, deliberately

Credentials for this same TeamCity already exist on a developer machine — in
`~/.claude.json` for the TeamCity MCP server, and in terminal-project's
`teamcity.json`. This extension reads **neither**. Those layouts are undocumented
and would break silently, and sharing one grant across three apps makes it unclear
what revoking it actually revokes. terminal-project states the same rule for the
same reason.

### When it goes wrong

**Connect to TeamCity… verifies immediately.** It makes one `/app/rest/server`
call after storing the credentials and reports success or the exact failure, so a
bad token is caught at setup rather than silently producing empty rows later.

Failures name the layer that rejected, and 401s carry the response body — the two
layers are fixed in different places, and the body is what distinguishes them:

```
TeamCity rejected the request (401).
  www-authenticate: Basic realm="TeamCity", Bearer realm="TeamCity"
  body: Invalid authentication request or authentication scheme is not supported
```

That signature means the request **passed through IAP** and TeamCity itself
refused it — so the Google sign-in is fine and the TeamCity token is wrong.
An IAP refusal looks different: its body mentions Google sign-in, and the
`www-authenticate` challenge does not name a TeamCity realm.

Both appear in the **Worktree Watcher** output channel.

### Triggering a deploy

Worktree rows with builds get a **rocket** button on the right, and **Trigger
Deploy in TeamCity…** in the context menu. It queues the deploy chain for that
branch.

Which configuration it queues is a name match, in order, against the build
configurations in that branch's environment project:

```
1. "Terraform Apply + App Deploy"
2. "Start Deploy"
```

Projects genuinely differ, which is why it is a list rather than one name:

| Project | Entry point |
|---|---|
| Widget Service | `…_DevelopmentTerraformApply` — *Terraform Apply + App Deploy* |
| Platform | `…_DevelopmentApproveDeploy` — *Start Deploy* (no App Deploy variant) |

Configure with `worktreeWatcher.teamCity.deployBuildTypeNames`. **If nothing
matches, no button appears** rather than falling back — the neighbouring
configurations include `Rollback` and `Flyway`, and guessing at those would be
worse than doing nothing.

The confirmation is modal and names exactly what will happen:

```
Trigger a deploy?

Terraform Apply + App Deploy
Widget Service / Acme Development
branch: fix/ABC-456-firestore-blocking-future-timeout

[Trigger]  [Cancel]
```

This is the extension's **only write to TeamCity** — everything else is a read.
The button sits beside ones that merely open a window, so it cannot be a
single-click action.

#### Finding the project

The project comes from `buildType.projectId`, never from parsing the build type
id — `WidgetService_Development` and `TerraformApply` concatenate with no
separator, so the id cannot be split back apart.

A brand-new branch has no builds, so there are two sources, cheapest first:

1. **This branch's builds**, already fetched for the status column.
2. **The repository's main checkout**, queried on demand. Its branch has certainly
   built, and its builds name the same project.

So the button works on a branch that has never built. It only gives up when
nothing in the repository has ever built.

Configuration lookup uses `affectedProject:` rather than `project:`, because the
latter returns only direct children and the deploy configurations live in
environment sub-projects.

#### The environment guard

Every environment in a project tree uses the **same configuration names**:

```
WidgetService_Development   → "Terraform Apply + App Deploy"
WidgetService_Production    → "Terraform Apply + App Deploy"   ← same name
WidgetService_EuProduction  → "Terraform Apply + App Deploy"   ← same name
```

Widening the search to find branches without builds therefore made it possible to
queue a **production** deploy by name match. Candidates are restricted to
`worktreeWatcher.teamCity.deployEnvironment` (default `Development`) *before* the
name preference is applied, and there is a test asserting production is never
offered by default. Setting it empty removes the guard deliberately.

If several permitted environments still match, a QuickPick asks which — it never
picks silently.

### Two TeamCity facts that shape the code

**A branch is not one build.** One branch fans out across many configurations —
the monolith runs ~25 (unit-test batches A–F, lint, jars, a composite). Status is
rolled up from the *newest build per configuration*, worst first, so a failure
that was retried green no longer counts.

**Branch names collide across repositories.** Dependabot reuses identical branch
names everywhere, so a build counts only if its VCS root is this worktree's repo.
That root is requested in the same call, which avoids a repo→project mapping —
there is no rule to derive one: `report-service` builds under
`ReportService`, but `api-gateway` under `Gateway` and
`feed-importer` under `Importer`.

Matching is on a path boundary, so `api` does not match `api-gateway`.

### Is this worth it over GitHub checks?

Often not. TeamCity already reports into GitHub checks (`REA / Build`, via the
*NurtureCloud TeamCity App*), and the panel's GitHub integration surfaces that for
free with no auth. The direct integration earns its keep only for **branches with
no pull request**, and as the groundwork for triggering builds.

## Session activity

Each row shows what its most recent Claude session is doing:

```
chore/dependabot-config-compliance    #415 merged · idle
feature/ARC-123                       #501 open · running Bash
fix/ABC-456                           #502 open · waiting for you · AskUserQuestion
```

Read from the last entry of the session's transcript:

| Last transcript entry | Reads as |
|---|---|
| Assistant called a tool | `running Bash` |
| Assistant called a **blocking** tool | `waiting for you · AskUserQuestion` |
| Assistant finished its turn | `idle` |
| A tool result came back | `working` |
| You sent a prompt | `thinking` |

Nothing is inferred — no "probably stuck", no idle threshold. It reports the last
thing that happened and stops there.

**`idle` is not a judgement about elapsed time.** It is the literal reading of a
transcript whose last entry is the assistant finishing its turn: nothing is
pending, the session is simply done until someone types again. That is why it is
worded differently from `waiting for you`, which is reserved for the one case
where something is genuinely outstanding on *your* side.

A tool call normally means the session is busy, which is why the default wording
is `running`. `AskUserQuestion` is the exception: the call is outstanding
*precisely because* it is waiting for an answer, so reporting it as running points
at the machine when the thing to look at is you. The set of blocking tools is one
constant in `domain/activity.ts`.

**No polling and no timers.** Transcripts are watched for content changes; a live
session appends roughly once every twelve seconds and nothing at all when idle, so
the panel does no work while nothing is happening. Only the last 64KB of a
transcript is read, so a 7MB one costs the same as a 100KB one — 14ms for a real
session.

The row shows the word only, never an elapsed time: nothing re-renders on a timer,
so a duration there would freeze and start lying. Exact timing lives in the
tooltip, which is built on hover and therefore accurate when read:

```
Activity
running Bash — 7:41:27 pm (3s ago)
```

Note this watches the same directories as the worktree scan, but for *content*
changes; the scan still ignores those, because a rescan walks the filesystem and
must not run on every transcript write.

| Setting | Default | |
|---|---|---|
| `worktreeWatcher.activity.enabled` | `true` | Turn the activity column off. |
| `worktreeWatcher.teamCity.enabled` | `false` | Show TeamCity build status. |
| `worktreeWatcher.teamCity.url` | `""` | e.g. `https://teamcity.example.com` |
| `worktreeWatcher.teamCity.iapClientId` | `""` | Google **desktop** OAuth client id. |
| `worktreeWatcher.teamCity.iapClientSecret` | `""` | Its secret — not confidential (RFC 8252 §8.5). |
| `worktreeWatcher.teamCity.pollMinutes` | `5` | Minutes between polls. |

### Why not a process watcher

Reading `ps`/`lsof` was tried and rejected. It cost 0.22s per poll against 0.004s,
only works on macOS, and could not reliably answer the one question that matters:
**which session a process belongs to**. A fresh (non-resumed) session exposes its
id in neither its command line, its environment, nor its open file handles — so
attribution fell back to guessing by directory, which is wrong exactly when several
sessions share one. Transcripts are named by session id, so the question never
arises. The only thing processes could add is liveness — whether a quiet session is
still running — which the panel does not currently need.

## Checking out review requests

The panel's title bar has **Check Out Review Requests…**: it lists every open
pull request in the organisation waiting on your review and creates worktrees
for the ones you tick.

```
Pull requests awaiting your review
Ticked items get a worktree under <repo>.worktrees/

 [x] CORE-558: extend agent VM lifecycle IAM   upside-ci-build-config #371 · nc-apark · opened today
 [x] Bump the kotlin group with 2 updates      nct-eventarc-outbox #116 · dependabot · 3 days old
 [ ] ALR-6762: Tune Cloud Task attempt delays  upside #20970 · augmentcode · opened today
     ⚠ upside is not cloned under the watched root
```

This is the inverse of everything else here. Elsewhere worktrees are known and
their pull requests are looked up; here the pull requests are known and the
worktrees do not exist yet.

**Not filtered by author.** Dependabot dominates a review queue by volume, but a
colleague's pull request needs a checkout for exactly the same reason, and
filtering to bots would hide the ones that matter most. The author is shown on
each row so the two are easy to tell apart.

**The count lives in the status bar** as `$(git-pull-request) 5 PRs awaiting
review`, carrying the same command as the title-bar button so either opens the
list. Hidden at zero.

Two earlier attempts were removed. A **numeric badge** reads as a worktree count
on a panel called Worktrees. `TreeView.description` says what it counts, but only
while you are looking at the panel — which is the wrong place for something worth
noticing when you are not. VS Code offers no way to put a number on a title-bar
button: a `navigation` item renders its static `package.json` icon and nothing
else, and the command `title` only ever appears as a tooltip.

**Clicking does not search.** The poll behind the status bar already holds the
answer, so the list opens from memory. It re-reads only when nothing has been
polled yet, when the last poll failed, or when the result is older than one poll
interval — a stale list could otherwise offer a worktree for a pull request that
has since merged.

> **Future work.** The poll stops when the Worktrees panel is hidden, so with the
> panel closed the status bar shows the last count seen rather than the current
> one. Clicking still re-reads, so acting on a stale number never acts on stale
> data. Polling while the window is open, regardless of the panel, would fix the
> display.

**A codicon marks who opened it** — `$(robot)` against `$(account)`, taken from
GitHub typing the author as `Bot` rather than `User`. A bot login is otherwise
indistinguishable from a person's, and bot-versus-human is the first way anyone
sorts a review queue.

### Team requests, or only yours

GitHub draws a line the obvious query does not:

| Qualifier | Matches |
|---|---|
| `user-review-requested:@me` | pull requests naming **you** personally |
| `review-requested:@me` | those, **plus** any where a team you belong to was asked |

The gap is not marginal. Measured on this organisation: **33** against **5**, with
**28 of the 33** requested from a single broad `cloud-services` team. A list where
six rows in seven are someone else's problem is a list nobody reads, so the default
is the personal form and `worktreeWatcher.reviewRequests.scope` opens it up.

### Two filters that look redundant

| Setting | Default | |
|---|---|---|
| `reviewRequests.excludeDrafts` | `true` | adds `draft:false` |
| `reviewRequests.excludeReviewed` | `true` | adds `-reviewed-by:@me` |

The second changes almost nothing on its own, and that is expected: submitting a
review **clears your pending request**, so the two sets barely overlap — measured
here, they do not overlap at all. It earns its place in the one case where they
do, a review **re-requested** after you had already looked, which is otherwise
indistinguishable from a fresh one.

### Creating the worktree

Two git steps, both needed:

```
git fetch origin <branch>
git worktree add --track -b <branch> <repo>.worktrees/<branch> origin/<branch>
```

The fetch is not optional. A plain clone only has remote-tracking refs for
branches that existed when it was cloned, so a branch opened since then is not
there at all and `worktree add` fails on an unknown ref. The `--track -b` form
then creates the local branch and sets its upstream together, leaving the
worktree ready to push from.

If a local branch of that name already exists — left behind by a worktree since
removed — that fails, and it falls back to checking the existing branch out. If
the branch is checked out in *another* worktree, git refuses and that is reported
rather than worked around.

Branch names are used verbatim, so `dependabot/gradle/org.flywaydb-11.1.0` nests
three directories deep. The convention places no meaning on depth, and flattening
the separators would collide two branches differing only in where their slashes
fall.

### What it will not do

| | |
|---|---|
| Clone a missing repository | Only `<root>/<repo>` is supported; anything else reads as not cloned |
| Recreate an existing worktree | Listed, but unticked |
| Run in parallel | `git worktree add` writes to the shared `.git/worktrees` admin directory |
| Poll in the background | It runs on click. A review queue that refreshed itself would be a notification, which this panel is not |

A pull request whose repository is not cloned still appears, held back by its
warning — "why is that one missing" is a worse question to leave the reader with
than one unticked row.

## Removing a worktree

Right-click a worktree → **Remove Worktree…**. Deliberately **not** an inline icon:
a destructive action should not sit one misclick from the everyday ones.

The confirmation carries the facts rather than asking a generic question, because
what matters differs per worktree:

```
Remove worktree “chore/dependabot-config-compliance”?

~/Code/widget-service.worktrees/chore/dependabot-config-compliance
PR #415 merged · working tree clean

[Remove]  [Remove and Delete Branch]  [Cancel]
```

What git does on its own decides what this has to add:

| Situation | git | so we |
|---|---|---|
| Uncommitted / untracked files | **refuses** | surface it and ask again before `--force` |
| Unpushed commits | **removes silently** | warn: the branch keeps them, nothing else does |
| The branch | **always survives** | offer to delete it, when safe |

`--force` is never passed implicitly — git's refusal *is* the safety net, so it is
shown ("3 file(s) would be discarded permanently") and confirmed separately.

**Remove and Delete Branch** only appears when the PR is merged and nothing is
unpushed. Deletion uses `git branch -d`, which refuses an unmerged branch; since
squash-merged PRs look unmerged to git, that refusal is surfaced with an
explanation rather than silently forced.

The Claude session sidecar needs no cleanup — `git worktree remove` deletes
`.git/worktrees/<name>/` along with it.

## Cleaning up idle worktrees

Worktrees accumulate. The **Clean Up Idle Worktrees…** button on a repository row
finds the ones that have gone quiet and removes the ones you tick:

```
Idle worktrees in upside
Idle for 14 days or more — ticked items will be removed

 [x] CONN-580-queues        2 months idle
 [x] CONN-508               2 months idle
 [ ] CONN-725               44 days idle    1 uncommitted change — git will refuse
 [x] CONN-756               37 days idle
```

### What "idle" measures

The **more recent** of two signals: the last commit on the branch, and the
worktree directory's mtime.

Taking the newer of the two is the conservative direction. Each signal misses a
different kind of work — committing need not touch the directory's mtime, and
editing files without committing does not move `HEAD` — so a worktree counts as
active if *either* says so. A branch untouched for 90 days that you edited this
morning does not appear.

A worktree whose age cannot be read is skipped entirely. An unknown age is not an
old age, and guessing in a delete flow is how you lose work.

These signals are read on click, never during a scan: it is a git call and a stat
per worktree, which is unnoticeable once and ruinous on a watcher that rescans
whenever the tree changes.

### Why only some boxes start ticked

Only worktrees that are **clean and fully pushed** are pre-selected. Anything
holding uncommitted changes or unpushed commits is listed with the reason but
left unticked, so removing it is a deliberate act rather than the default.

Dirty worktrees are shown rather than hidden — they are usually the ones you most
want to know about — but this flow will not force past git's refusal. That stays
with **Remove Worktree…**, which names the file count before discarding anything.

### What it will not do

| | |
|---|---|
| Force past a dirty worktree | Reported as skipped; use the per-item flow |
| Delete branches | Never — the stated guarantee of the confirmation |
| Remove the main checkout | Not a worktree, never a candidate |
| Run removals in parallel | `git worktree remove` writes to the shared `.git/worktrees` admin directory, so they would race |

Partial failure is reported honestly — "Removed 7 worktrees; 2 could not be
removed", with **Show Details** naming each one. A bulk action that quietly
skipped things would leave you believing the tree is cleaner than it is.

## Architecture

Ports and adapters, so the interesting logic runs under plain `node --test` with no VS
Code host.

```
src/
├── domain/           model.ts, display.ts       pure rules — no vscode, no fs
├── application/      ports.ts, worktreeStore.ts orchestration — depends only on ports
├── infrastructure/   fsWorktreeScanner.ts       node:fs only (so: testable)
│                     vscodeDirectoryWatcher.ts  ┐
│                     vscodeSettings.ts          ├ the only files importing vscode
│                     outputLogger.ts            ┘
├── presentation/     worktreeTreeProvider.ts    domain → TreeItem mapping
│   (github)      pullRequestStore + ghPullRequestSource
│   (teamcity)    buildStore + teamCityBuildSource + iapAuthProvider
│   (activity)    activityStore + transcriptActivityReader
└── extension.ts      composition root — the only file that knows every layer
```

Dependencies point inward: `presentation → application → domain`, with
`infrastructure` implementing the ports the application declares. Swapping the
filesystem scanner for a `git worktree list` one, or the tree for a webview, touches one
file each.

`npm test` covers the domain rules and runs the real scanner against a temp fixture
reproducing every awkward case above — 26 tests, no VS Code required.

## Watching, without watching everything

A recursive watch on `~/Code` would mean watching every file in every checked-out
repository, and watchers outside the workspace ignore `files.watcherExclude`, so there
would be no way to trim it back.

Instead the scanner reports the directories that actually define the structure, and each
is watched **non-recursively** — a `RelativePattern` whose pattern has no `**` matches
only direct children:

- `~/Code` — a new `*.worktrees` container appearing
- each `*.worktrees` and prefix directory — worktrees added or removed
- each repo's git admin dir — `HEAD` changes, i.e. branch switches

On a real `~/Code` that is ~64 watch paths for 24 worktrees, and a full rescan takes
~30ms. Events are debounced 400ms, since git operations arrive in bursts.

## The `/worktree` Claude skill

`skill/` holds a Claude Code skill that creates worktrees under this same convention
and records the session that asked for it:

```
/worktree widget-service ARC-123-add-thing
```

It fetches origin, branches from `origin/main`, and records the session in two places:

| Where | Purpose |
|---|---|
| `.git/worktrees/<name>/claude-sessions` | Live link, read by this extension. |
| `~/.local/state/worktree-watcher/worktrees.jsonl` | Append-only history. |

The sidecar lives in git's **admin directory**, which is not tracked content — it
cannot be committed or pushed and needs no gitignore entry. `git worktree remove`
deletes it along with the worktree, so the link never goes stale.

### Many sessions per worktree

The usual case: you create a worktree today and return tomorrow in a new session. The
sidecar is therefore **append-only**, one record per line:

```
a88704ad-2961-4b2a-9220-26ee816b5e95 2026-09-12T07:07:45Z
3f19c204-8d51-4e2a-91bb-77c0e4a1b9de 2026-09-13T22:14:02Z
```

A comma-separated list would need read-modify-write, which loses an entry when two
sessions start concurrently; a short `>>` append does not. The legacy single-id file
parses identically under the same line reader, so there is no migration.

`skill/hooks/session-start.sh` is a `SessionStart` hook that appends the current
session whenever a session starts **anywhere inside** a worktree — without it only
the creating session is ever recorded. It reads `session_id` from the hook payload
rather than the environment, exits early (~9ms) when the cwd is not in a worktree,
and never duplicates a session on resume.

Worktrees with a session show a purple branch icon and gain two actions. With more
than one session each prompts with a QuickPick, newest first.

**Open Claude Session** (inline, primary) opens the conversation in the Claude Code
extension's own sidebar, not a terminal.

**Resume Claude Session in Terminal** is the CLI fallback — `claude --resume <id>`
in a terminal rooted at the worktree.

### How opening a session works

The Claude Code extension (v2.1.220) registers a URI handler whose `/open` path
forwards to a command:

```js
case "/open": {
  let session = query.get("session"), prompt = query.get("prompt")
  executeCommand("claude-vscode.primaryEditor.open", session, prompt)
}
```

So from **outside** VS Code, on macOS:

```bash
open "vscode://Anthropic.claude-code/open?session=<id>"
```

(note the capital `A` — that is the real publisher id; `code --open-url` does not
exist in current builds, so `open` is the route.)

From **inside** an extension the URI is unnecessary — call the command directly.
That is what this panel does when the worktree is already open in the window.

When it is not, the URI would be the obvious approach and is the wrong one: VS Code
delivers a URI to whichever window is *active*, so it races with the new window
taking focus.

Instead the request is parked at
`~/.local/state/worktree-watcher/pending-session.json`, the folder is opened, and
whichever window lands on it claims the request as it activates. Three details make
that reliable:

- **A file, not `globalState`.** A Memento is cached per window and its cross-window
  visibility is not a documented guarantee, so a brand-new window reading a
  just-written value is a gamble. A file is immediately visible, survives the
  writing window closing, and can be inspected when something goes wrong.
- **The claim renames before acting**, so two windows opening the same folder
  cannot both fire.
- **It waits for Claude Code.** Both extensions activate on `onStartupFinished`, so
  in a fresh window the command usually does not exist yet. The request is held
  (polling for up to 30s) rather than dropped; only if Claude Code never appears
  does it fall back to offering the terminal.

Requests expire after two minutes so a window opened much later never fires a stale
session — see `domain/handoff.ts`.

Known limitation: if the worktree is already open in a *different* window,
`vscode.openFolder` opens a second window on it. The extension API cannot focus
another existing window; only the `code <path>` CLI can.

### Mapping a session back to its directory

Do not reverse the `~/.claude/projects/` slug — it is lossy, since `/` and `.` both
become `-`. The transcript records the real path:

```json
{ "cwd": "/Users/…/repo.worktrees/chore/thing", "gitBranch": "chore/thing" }
```

### Not every recorded session is resumable

A session id firing `SessionStart` does **not** guarantee a resumable conversation —
some sessions start and never write a transcript, and `claude --resume` on one of
those fails. Observed in practice: ~3% of session-env entries have no transcript.

The hook cannot tell at write time (the transcript does not exist yet), so
`ClaudeTranscriptVerifier` filters on read, checking for
`~/.claude/projects/<cwd with / and . as ->/<id>.jsonl`. Dead entries disappear
without rewriting any sidecar, and a session becomes visible once it writes its
transcript.

That path is an internal Claude Code convention, not a documented contract, which is
why it sits behind the `SessionVerifier` port — one file to change if it moves. The
adapter is deliberately conservative: a session is dropped only when the project
directory exists and its transcript does not. Missing projects directory, missing
project directory, or an unreadable one all mean "show everything" rather than
"hide everything".

### Installing the skill and hook

```bash
ln -sfn ~/Code/vs-code-extensions/panels/worktree-watcher/skill ~/.claude/skills/worktree
```

Then add to `~/.claude/settings.json` — a pointer only, so the implementation stays
version-controlled here:

```json
"SessionStart": [
  { "hooks": [{ "type": "command", "async": true, "timeout": 10,
                "command": "~/.claude/skills/worktree/hooks/session-start.sh" }] }
]
```

`CLAUDE_CODE_SESSION_ID` is not a documented public contract. If it is ever unset the
script warns and creates the worktree anyway — worktree creation never depends on it.

## Install

```bash
npm install
npm run install-local
```

Reload the window. Or press <kbd>F5</kbd> to run it in an Extension Development Host.

Lost the panel? <kbd>⌘⇧P</kbd> → `Focus on Worktrees View`.

## Settings

| Setting | Default | |
|---|---|---|
| `worktreeWatcher.rootPath` | `~/Code` | Directory to watch. Supports `~`, `${userHome}`, `${workspaceFolder}`. |
| `worktreeWatcher.maxDepth` | `4` | Search depth inside each `.worktrees` directory. |
| `worktreeWatcher.showEmptyRepositories` | `false` | Show repos whose `.worktrees` is empty. |
| `worktreeWatcher.cleanUp.staleDays` | `14` | Idle days before clean-up offers a worktree. |

`rootPath` is `machine-overridable` so Settings Sync does not push a machine-specific
absolute path to your other machines.

## Actions

**Repository rows** have an inline **Open in New Window** that opens the
`<repo>.worktrees/` container — one window holding every worktree for that repo —
and **Clean Up Idle Worktrees…**.

**Worktree rows** keep their inline icons for the two actions worth a single
click: **Open Claude Session**, and **Trigger Deploy** when TeamCity is on.
Everything else is one right-click away — **Open in New Window**, **Add Folder to
Workspace**, **Reveal in Finder**, **Copy Path**, **Open Pull Request**, **Open
Build in TeamCity**, **Resume Claude Session in Terminal**, **Copy Claude Session
ID**, and **Remove Worktree…**.

Opening a worktree in a new window is deliberately *not* inline. Rows already
carry a lot — branch, PR, review, build, activity — and an icon earns its place
by being the thing you reach for most, which for a worktree is its Claude session,
not another window.

## Next steps this is built for

- Dirty/ahead/behind status per worktree — add a port, implement it with `git status
  --porcelain`, widen `Worktree`. No change to the tree or the watcher.
- Stale-worktree pruning — the scanner already distinguishes empty prefix dirs.
- Grouping by branch prefix instead of repository — `domain/display.ts` only.
