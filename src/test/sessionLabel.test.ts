import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { labelWithSession, truncate } from '../domain/display'

describe('truncate', () => {
  it('leaves a title that fits alone', () => {
    assert.equal(truncate('Fix the build', 28), 'Fix the build')
  })

  it('cuts to the limit including the ellipsis', () => {
    const cut = truncate('Create always-visible VSCode plugin panel', 28)
    assert.equal(cut, 'Create always-visible VSCod…')
    assert.equal([...cut].length, 28)
  })

  it('does not leave a space before the ellipsis', () => {
    assert.equal(truncate('Review and explain codebase', 11), 'Review and…')
  })

  it('never splits an emoji into a broken half', () => {
    assert.equal(truncate('🚀🚀🚀🚀', 3), '🚀🚀…')
  })

  it('collapses line breaks and runs of spaces', () => {
    assert.equal(truncate('Two\n   lines', 28), 'Two lines')
  })

  it('returns nothing at a limit of zero', () => {
    assert.equal(truncate('Anything', 0), '')
  })
})

describe('labelWithSession', () => {
  it('leads with the title, then the branch', () => {
    assert.equal(
      labelWithSession('dependabot/gradle/minor-and-patch', 'Create always-visible VSCode plugin', 28),
      'Create always-visible VSCod…  dependabot/gradle/minor-and-patch'
    )
  })

  it('is just the branch when there is no session title', () => {
    assert.equal(labelWithSession('feature/ABC-123', undefined, 28), 'feature/ABC-123')
  })

  it('is just the branch when titles are turned off', () => {
    assert.equal(labelWithSession('feature/ABC-123', 'Fix the build', 0), 'feature/ABC-123')
  })

  it('is just the branch when the title is only whitespace', () => {
    assert.equal(labelWithSession('feature/ABC-123', '   ', 28), 'feature/ABC-123')
  })
})
