import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { sessionTitle, transcriptCwd } from '../domain/transcript'

const SESSION = 'a79ca43a-c779-464d-be69-ea4b2c78888b'

function line(entry: Record<string, unknown>): string {
  return JSON.stringify({ sessionId: SESSION, ...entry })
}

describe('sessionTitle', () => {
  it('returns the most recent title when it has been renamed', () => {
    const transcript = [
      line({ type: 'user', cwd: '/Users/x/Code/repo.worktrees/a' }),
      line({ type: 'ai-title', aiTitle: 'Initial guess' }),
      line({ type: 'assistant' }),
      line({ type: 'ai-title', aiTitle: 'Review and explain codebase' })
    ].join('\n')
    assert.equal(sessionTitle(transcript), 'Review and explain codebase')
  })

  it('is undefined when the session has not been titled yet', () => {
    assert.equal(sessionTitle(line({ type: 'user' })), undefined)
  })

  it('tolerates a half-written final line from a live session', () => {
    const transcript = `${line({ type: 'ai-title', aiTitle: 'Good' })}\n{"type":"assist`
    assert.equal(sessionTitle(transcript), 'Good')
  })

  it('ignores an ai-title entry with a non-string title', () => {
    assert.equal(sessionTitle(line({ type: 'ai-title', aiTitle: 42 })), undefined)
  })

  it('handles an empty transcript', () => {
    assert.equal(sessionTitle(''), undefined)
  })

  it('prefers a user-set customTitle over the generated one', () => {
    const transcript = [
      line({ type: 'ai-title', aiTitle: 'Review and explain codebase' }),
      line({ type: 'user', customTitle: 'Worktree panel work' })
    ].join('\n')
    assert.equal(sessionTitle(transcript), 'Worktree panel work')
  })

  it('keeps the latest customTitle when renamed twice', () => {
    const transcript = [
      line({ customTitle: 'First name' }),
      line({ customTitle: 'Second name' })
    ].join('\n')
    assert.equal(sessionTitle(transcript), 'Second name')
  })

  it('falls back to aiTitle when the custom title is blank', () => {
    const transcript = [
      line({ type: 'ai-title', aiTitle: 'Generated' }),
      line({ customTitle: '' })
    ].join('\n')
    assert.equal(sessionTitle(transcript), 'Generated')
  })
})

describe('transcriptCwd', () => {
  it('reads the directory the session ran in', () => {
    const transcript = [
      line({ type: 'queue-operation' }),
      line({ type: 'user', cwd: '/Users/x/Code/repo.worktrees/chore/thing' })
    ].join('\n')
    assert.equal(transcriptCwd(transcript), '/Users/x/Code/repo.worktrees/chore/thing')
  })

  it('is undefined when no entry records a cwd', () => {
    assert.equal(transcriptCwd(line({ type: 'ai-title', aiTitle: 'x' })), undefined)
  })
})
