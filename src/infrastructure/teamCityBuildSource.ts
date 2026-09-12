import { BuildSource, TeamCitySettings } from '../application/ports'
import { Build, BuildStatus } from '../domain/build'
import { BuildTypeSummary } from '../domain/deploy'

/**
 * Ask for each build's VCS root in the same request, so builds can be attributed
 * to a repository without a second call or a hand-maintained mapping. TeamCity
 * project ids do not follow from repository names — `api-gateway` builds under
 * `Gateway`, `feed-importer` under `Importer` — so the VCS root is the only
 * reliable link.
 */
const BUILD_FIELDS =
  'count,build(id,number,status,state,branchName,webUrl,composite,finishOnAgentDate,' +
  'buildTypeId,buildType(id,name,projectId,projectName),' +
  'revisions(revision(vcs-root-instance(name,properties(property(name,value))))))'

/**
 * A popular branch name spans several repositories, so overfetch and filter
 * client-side rather than trusting the first page to contain this repo's builds.
 */
const OVERFETCH = 100

const REQUEST_TIMEOUT_MS = 20_000

export class TeamCityBuildSource implements BuildSource {
  constructor(
    private readonly settings: TeamCitySettings,
    private readonly idToken: () => Promise<string | undefined>,
    private readonly token: () => Promise<string | undefined>
  ) {}

  async available(): Promise<boolean> {
    return Boolean(this.settings.url && (await this.token()) && (await this.idToken()))
  }

  /**
   * One cheap call to prove both credentials work, used right after connecting.
   * Returns undefined on success, or the reason it failed — which names the layer
   * that refused, since IAP and TeamCity problems are fixed in different places.
   */
  async verify(): Promise<string | undefined> {
    try {
      await this.get<unknown>('/app/rest/server', { fields: 'version' })
      return undefined
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }

  async buildsForBranch(branch: string): Promise<readonly Build[]> {
    const locator = `branch:(name:${branch}),running:any,canceled:any,failedToStart:any,count:${OVERFETCH}`
    const payload = await this.get<BuildsResponse>('/app/rest/builds', {
      locator,
      fields: BUILD_FIELDS
    })
    return (payload.build ?? []).map(toBuild)
  }

  /** Build configurations in a project, to find the deploy entry point. */
  async buildTypesIn(projectId: string): Promise<readonly BuildTypeSummary[]> {
    // `project:` returns only direct children; the deploy configurations live in
    // environment sub-projects, so the whole subtree is needed.
    const payload = await this.get<BuildTypesResponse>('/app/rest/buildTypes', {
      locator: `affectedProject:(id:${projectId})`,
      fields: 'buildType(id,name,projectId,projectName)'
    })
    return (payload.buildType ?? [])
      .filter((raw) => Boolean(raw.id && raw.name))
      .map((raw) => ({
        id: raw.id as string,
        name: raw.name as string,
        projectId: raw.projectId,
        projectName: raw.projectName
      }))
  }

  /** Queues a build. The only write this extension makes to TeamCity. */
  async trigger(buildTypeId: string, branch: string): Promise<string | undefined> {
    const queued = await this.post<{ id?: number; webUrl?: string }>('/app/rest/buildQueue', {
      buildType: { id: buildTypeId },
      branchName: branch
    })
    return queued.webUrl
  }

  private async post<T>(route: string, body: unknown): Promise<T> {
    return this.request<T>(route, {}, { method: 'POST', body: JSON.stringify(body) })
  }

  private async get<T>(route: string, params: Record<string, string>): Promise<T> {
    return this.request<T>(route, params)
  }

  private async request<T>(
    route: string,
    params: Record<string, string>,
    init: { method?: string; body?: string } = {}
  ): Promise<T> {
    const [token, idToken] = await Promise.all([this.token(), this.idToken()])
    if (!token) {
      throw new Error('No TeamCity token — run “Worktrees: Connect to TeamCity”.')
    }
    if (!idToken) {
      throw new Error('Not signed in to Google — sign in from the Accounts menu.')
    }

    const url = new URL(route, this.settings.url)
    url.search = new URLSearchParams(params).toString()

    const response = await fetch(url, {
      method: init.method ?? 'GET',
      headers: {
        // TeamCity's own auth, plus the IAP layer in front of it.
        Authorization: `Bearer ${token}`,
        'Proxy-Authorization': `Bearer ${idToken}`,
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {})
      },
      body: init.body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })

    if (response.status === 401 || response.status === 403) {
      // Naming the layer from `www-authenticate` alone was unreliable — IAP does
      // not always send it — so report the evidence instead of a guess. IAP
      // rejections mention Google sign-in in the body; TeamCity's do not.
      const body = (await response.text()).replace(/\s+/g, ' ').trim().slice(0, 160)
      const challenge = response.headers.get('www-authenticate') ?? 'none'
      const looksLikeIap = /accounts\.google|iap|identity-aware|sign in/i.test(body)
      throw new Error(
        `${looksLikeIap ? 'IAP' : 'TeamCity'} rejected the request (${response.status}). ` +
          `www-authenticate: ${challenge}. body: ${body || '<empty>'}`
      )
    }
    if (!response.ok) {
      throw new Error(`TeamCity returned ${response.status}`)
    }
    return (await response.json()) as T
  }
}

interface BuildsResponse {
  build?: RawBuild[]
}

interface BuildTypesResponse {
  buildType?: Array<{ id?: string; name?: string; projectId?: string; projectName?: string }>
}

interface RawBuild {
  id?: number
  status?: string
  state?: string
  branchName?: string
  webUrl?: string
  composite?: boolean
  buildTypeId?: string
  finishOnAgentDate?: string
  buildType?: { name?: string; projectId?: string; projectName?: string }
  revisions?: {
    revision?: Array<{
      'vcs-root-instance'?: {
        name?: string
        properties?: { property?: Array<{ name?: string; value?: string }> }
      }
    }>
  }
}

function toBuild(raw: RawBuild): Build {
  return {
    id: raw.id ?? 0,
    buildTypeId: raw.buildTypeId ?? '',
    buildTypeName: raw.buildType?.name,
    projectId: raw.buildType?.projectId,
    branch: raw.branchName ?? '',
    status: toStatus(raw.state, raw.status),
    webUrl: raw.webUrl ?? '',
    vcsRoots: vcsRootsOf(raw),
    finishedAt: raw.finishOnAgentDate,
    composite: raw.composite === true
  }
}

/**
 * State wins over status: a build still running has a provisional status that
 * would otherwise read as a finished result.
 */
function toStatus(state: string | undefined, status: string | undefined): BuildStatus {
  if (state === 'queued') {
    return 'queued'
  }
  if (state === 'running') {
    return status === 'FAILURE' ? 'failure' : 'running'
  }
  if (status === 'SUCCESS') {
    return 'success'
  }
  if (status === 'FAILURE' || status === 'ERROR') {
    return 'failure'
  }
  return 'unknown'
}

/** Both the root's display name and its URL property can identify the repo. */
function vcsRootsOf(raw: RawBuild): string[] {
  const roots: string[] = []
  for (const revision of raw.revisions?.revision ?? []) {
    const instance = revision['vcs-root-instance']
    if (instance?.name) {
      roots.push(instance.name)
    }
    for (const property of instance?.properties?.property ?? []) {
      if (property.name === 'url' && property.value) {
        roots.push(property.value)
      }
    }
  }
  return roots
}
