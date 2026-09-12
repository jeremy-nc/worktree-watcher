import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  chooseDeployTarget,
  chooseDeployTargets,
  deployProjectOf,
  describeDeploy
} from '../domain/deploy'

const TRADEME = [
  { id: 'WidgetService_DevelopmentTerraformPlan', name: 'Terraform Plan', projectId: 'WidgetService_Development' },
  { id: 'WidgetService_DevelopmentApproveDeploy', name: 'Start Deploy', projectId: 'WidgetService_Development' },
  { id: 'WidgetService_DevelopmentTerraformApply', name: 'Terraform Apply + App Deploy', projectId: 'WidgetService_Development' }
]

const MONOLITH = [
  { id: 'Platform_DevelopmentApproveDeploy', name: 'Start Deploy', projectId: 'Platform_Development' },
  { id: 'Platform_DevelopmentTerraformApply', name: 'Terraform Apply', projectId: 'Platform_Development' },
  { id: 'Platform_DevelopmentRollback', name: 'Rollback', projectId: 'Platform_Development' },
  { id: 'Platform_DevelopmentFlywayMigration', name: 'Flyway', projectId: 'Platform_Development' }
]

describe('chooseDeployTarget', () => {
  it('prefers the app-deploy variant where a project has one', () => {
    assert.equal(
      chooseDeployTarget(TRADEME)?.buildTypeId,
      'WidgetService_DevelopmentTerraformApply'
    )
  })

  it('falls back to Start Deploy where there is no app-deploy variant', () => {
    // Platform's "Terraform Apply" must NOT match "Terraform Apply + App Deploy".
    assert.equal(chooseDeployTarget(MONOLITH)?.buildTypeId, 'Platform_DevelopmentApproveDeploy')
  })

  it('offers nothing rather than guessing when neither name exists', () => {
    assert.equal(chooseDeployTarget([{ id: 'X_Rollback', name: 'Rollback', projectId: 'X_Development' }]), undefined)
  })

  it('never picks an alarming configuration by accident', () => {
    const chosen = chooseDeployTarget(MONOLITH)
    assert.notEqual(chosen?.name, 'Rollback')
    assert.notEqual(chosen?.name, 'Flyway')
  })

  it('matches case- and whitespace-insensitively', () => {
    assert.ok(chooseDeployTarget([{ id: 'A_B', name: '  start deploy ', projectId: 'A_Development' }]))
  })

  it('honours a custom preference order', () => {
    const chosen = chooseDeployTarget(TRADEME, ['Start Deploy'])
    assert.equal(chosen?.buildTypeId, 'WidgetService_DevelopmentApproveDeploy')
  })
})

describe('deployProjectOf', () => {
  it('takes the project id TeamCity supplies', () => {
    assert.equal(
      deployProjectOf([{}, { projectId: 'WidgetService_Development' }]),
      'WidgetService_Development'
    )
  })

  it('is undefined when no build carries one', () => {
    assert.equal(deployProjectOf([{}, {}]), undefined)
  })

  it('is undefined with no builds at all', () => {
    assert.equal(deployProjectOf([]), undefined)
  })
})

describe('describeDeploy', () => {
  it('names the configuration, project and branch', () => {
    const text = describeDeploy(
      { buildTypeId: 'x', name: 'Start Deploy', projectName: 'Platform / Acme Development' },
      'fix/ABC-456'
    )
    assert.match(text, /Start Deploy/)
    assert.match(text, /Acme Development/)
    assert.match(text, /branch: fix\/ABC-456/)
  })
})

describe('environment guard', () => {
  // The same configuration names exist in every environment of a project tree.
  const WHOLE_TREE = [
    {
      id: 'WidgetService_DevelopmentTerraformApply',
      name: 'Terraform Apply + App Deploy',
      projectId: 'WidgetService_Development',
      projectName: 'Widget Service / Acme Development'
    },
    {
      id: 'WidgetService_ProductionTerraformApply',
      name: 'Terraform Apply + App Deploy',
      projectId: 'WidgetService_Production',
      projectName: 'Widget Service / Acme Production'
    },
    {
      id: 'WidgetService_EuProductionTerraformApply',
      name: 'Terraform Apply + App Deploy',
      projectId: 'WidgetService_EuProduction',
      projectName: 'Widget Service / EU Production'
    }
  ]

  it('never offers a production configuration by default', () => {
    const targets = chooseDeployTargets(WHOLE_TREE)
    assert.deepEqual(targets.map((t) => t.buildTypeId), [
      'WidgetService_DevelopmentTerraformApply'
    ])
  })

  it('matches the environment on the project name too', () => {
    const targets = chooseDeployTargets(
      [{ id: 'A_B', name: 'Start Deploy', projectName: 'Thing / Acme Testing' }],
      ['Start Deploy'],
      'Testing'
    )
    assert.equal(targets.length, 1)
  })

  it('returns every match so the caller can ask, rather than picking silently', () => {
    const targets = chooseDeployTargets(WHOLE_TREE, ['Terraform Apply + App Deploy'], 'Production')
    assert.equal(targets.length, 2)
    assert.equal(chooseDeployTarget(WHOLE_TREE, ['Terraform Apply + App Deploy'], 'Production'), undefined)
  })

  it('is empty when the environment excludes everything', () => {
    assert.deepEqual(chooseDeployTargets(WHOLE_TREE, undefined, 'Staging'), [])
  })
})
