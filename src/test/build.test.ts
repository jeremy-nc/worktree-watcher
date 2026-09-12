import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { Build, buildBelongsTo, buildSummary, buildTypeLabel, rollUp } from '../domain/build'

function build(overrides: Partial<Build> = {}): Build {
  return {
    id: 1,
    buildTypeId: 'Gateway_Build',
    branch: 'feature/thing',
    status: 'success',
    webUrl: 'https://teamcity.example.com/build/1',
    vcsRoots: ['git@github.com:acme/api-gateway.git'],
    composite: false,
    ...overrides
  }
}

describe('buildBelongsTo', () => {
  it('matches the repository in a VCS root URL', () => {
    assert.equal(buildBelongsTo(build(), 'api-gateway'), true)
  })

  it('does not match a repository that merely shares a prefix', () => {
    assert.equal(buildBelongsTo(build(), 'api'), false)
  })

  it('does not match a different repository with the same branch name', () => {
    assert.equal(buildBelongsTo(build(), 'widget-service'), false)
  })

  it('matches when the root is a bare name rather than a URL', () => {
    assert.equal(buildBelongsTo(build({ vcsRoots: ['api-gateway'] }), 'api-gateway'), true)
  })

  it('does not match a longer sibling repository', () => {
    assert.equal(
      buildBelongsTo(build({ vcsRoots: ['git@github.com:acme/api-gateway-2.git'] }), 'api-gateway'),
      false
    )
  })

  it('does not attribute a build with no VCS root information', () => {
    assert.equal(buildBelongsTo(build({ vcsRoots: [] }), 'api-gateway'), false)
  })
})

describe('rollUp', () => {
  const repo = 'api-gateway'

  it('is undefined when no build belongs to this repository', () => {
    assert.equal(rollUp('other-repo', 'feature/thing', [build()]), undefined)
  })

  it('reports failure when any configuration is failing', () => {
    const rolled = rollUp(repo, 'feature/thing', [
      build({ buildTypeId: 'Gateway_Build', status: 'success' }),
      build({ buildTypeId: 'Gateway_Terraform', status: 'failure' })
    ])
    assert.equal(rolled?.status, 'failure')
    assert.equal(rolled?.builds[0].buildTypeId, 'Gateway_Terraform')
  })

  it('keeps only the newest build per configuration', () => {
    // TeamCity returns newest first: a retry that passed supersedes the failure.
    const rolled = rollUp(repo, 'feature/thing', [
      build({ id: 2, buildTypeId: 'Gateway_Build', status: 'success' }),
      build({ id: 1, buildTypeId: 'Gateway_Build', status: 'failure' })
    ])
    assert.equal(rolled?.status, 'success')
    assert.equal(rolled?.builds.length, 1)
    assert.equal(rolled?.builds[0].id, 2)
  })

  it('prefers running over success when nothing has failed', () => {
    const rolled = rollUp(repo, 'feature/thing', [
      build({ buildTypeId: 'Gateway_Build', status: 'success' }),
      build({ buildTypeId: 'Gateway_Lint', status: 'running' })
    ])
    assert.equal(rolled?.status, 'running')
  })
})

describe('buildTypeLabel', () => {
  it('uses the display name when TeamCity gives one', () => {
    assert.equal(buildTypeLabel(build({ buildTypeName: 'Build' })), 'Build')
  })

  it('falls back to the id without its project prefix', () => {
    assert.equal(buildTypeLabel(build({ buildTypeId: 'Platform_JavaUnitTestsA' })), 'JavaUnitTestsA')
  })
})

describe('buildSummary', () => {
  it('names the failing configuration', () => {
    const rolled = rollUp('api-gateway', 'b', [
      build({ buildTypeId: 'Gateway_Terraform', buildTypeName: 'Terraform Plan', status: 'failure' })
    ])
    assert.equal(buildSummary(rolled!), 'Terraform Plan failed')
  })

  it('summarises a passing branch', () => {
    const rolled = rollUp('api-gateway', 'b', [build()])
    assert.equal(buildSummary(rolled!), 'build passed')
  })
})
