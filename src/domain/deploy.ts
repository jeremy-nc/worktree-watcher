/**
 * Choosing which TeamCity configuration a worktree's deploy button triggers.
 *
 * Pure — the decision is a name-matching rule over the configurations that exist
 * for the branch's project, because the entry point differs between projects:
 *
 *   Widget Service → "Terraform Apply + App Deploy"  (tops the chain; the
 *                          build that pulled in Build, Plan and Start Deploy)
 *   Platform            → "Start Deploy"                  (no App Deploy variant;
 *                          described as "kicks off the deploy chain")
 *
 * So the rule is an ordered preference, not a single name.
 */

export interface DeployTarget {
  readonly buildTypeId: string
  readonly name: string
  readonly projectName?: string
}

/** Tried in order; the first configuration whose name matches wins. */
export const DEFAULT_DEPLOY_PREFERENCE = ['Terraform Apply + App Deploy', 'Start Deploy']

export interface BuildTypeSummary {
  readonly id: string
  readonly name: string
  readonly projectId?: string
  readonly projectName?: string
}

/**
 * Which environment a deploy button may target.
 *
 * This is a safety boundary, not a convenience. A repository's project tree
 * contains the same configuration names for every environment — Development,
 * Testing, Acme Production, EU Production — so a name match alone would
 * happily queue a **production** deploy. Candidates are restricted to
 * environments matching this before any name preference is applied.
 */
export const DEFAULT_DEPLOY_ENVIRONMENT = 'Development'

/**
 * Deploy configurations this branch could target, best first and **restricted to
 * the permitted environment**.
 *
 * Returns every match rather than one, because a project tree can hold several
 * environments that all pass the filter; the caller asks which when that happens
 * rather than picking silently.
 *
 * Empty when nothing matches — no button is then offered, rather than falling
 * back to some other configuration. The neighbours include `Rollback` and
 * `Flyway`, and guessing at those would be worse than doing nothing.
 */
export function chooseDeployTargets(
  buildTypes: readonly BuildTypeSummary[],
  preference: readonly string[] = DEFAULT_DEPLOY_PREFERENCE,
  environment: string = DEFAULT_DEPLOY_ENVIRONMENT
): DeployTarget[] {
  const permitted = buildTypes.filter((buildType) => inEnvironment(buildType, environment))

  for (const wanted of preference) {
    const matches = permitted.filter(
      (buildType) => buildType.name.trim().toLowerCase() === wanted.trim().toLowerCase()
    )
    if (matches.length > 0) {
      return matches.map((match) => ({
        buildTypeId: match.id,
        name: match.name,
        projectName: match.projectName
      }))
    }
  }
  return []
}

/** Convenience for the single-match case; undefined when ambiguous or absent. */
export function chooseDeployTarget(
  buildTypes: readonly BuildTypeSummary[],
  preference: readonly string[] = DEFAULT_DEPLOY_PREFERENCE,
  environment: string = DEFAULT_DEPLOY_ENVIRONMENT
): DeployTarget | undefined {
  const targets = chooseDeployTargets(buildTypes, preference, environment)
  return targets.length === 1 ? targets[0] : undefined
}

/**
 * An empty environment disables the guard entirely, which is why it must be
 * opted into explicitly rather than being the default.
 */
function inEnvironment(buildType: BuildTypeSummary, environment: string): boolean {
  if (!environment.trim()) {
    return true
  }
  const needle = environment.trim().toLowerCase()
  return (
    (buildType.projectId ?? '').toLowerCase().includes(needle) ||
    (buildType.projectName ?? '').toLowerCase().includes(needle)
  )
}

/**
 * The environment project to look for deploy configurations in, taken from a
 * build already seen on this branch.
 *
 * Deliberately not derived from the build type id: `WidgetService_Development`
 * + `TerraformApply` concatenate with no separator, so the id cannot be split
 * back apart. TeamCity returns the project id, so use that.
 */
export function deployProjectOf(
  builds: readonly { projectId?: string }[]
): string | undefined {
  return builds.find((build) => build.projectId)?.projectId
}

/** Wording for the confirmation, which must name what is about to happen. */
export function describeDeploy(target: DeployTarget, branch: string): string {
  return [target.name, target.projectName, `branch: ${branch}`].filter(Boolean).join('\n')
}
