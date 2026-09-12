import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { parseActivity } from '../domain/activity'

function entry(value: Record<string, unknown>): string {
  return JSON.stringify(value)
}

const assistantTool = entry({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', name: 'Bash' }] }
})
const assistantText = entry({
  type: 'assistant',
  message: { content: [{ type: 'text' }] }
})
const userPrompt = entry({ type: 'user', message: { content: 'do the thing' } })
const toolResult = entry({
  type: 'user',
  message: { content: [{ type: 'tool_result' }] }
})

describe('parseActivity', () => {
  it('names the tool being run', () => {
    assert.equal(parseActivity(assistantTool), 'running Bash')
  })

  it('reports waiting once the assistant has replied', () => {
    assert.equal(parseActivity(assistantText), 'waiting for you')
  })

  it('reports thinking after a prompt', () => {
    assert.equal(parseActivity(userPrompt), 'thinking')
  })

  it('reports working when a tool result has come back', () => {
    assert.equal(parseActivity(toolResult), 'working')
  })

  it('uses the last entry, not the first', () => {
    assert.equal(parseActivity([userPrompt, assistantTool].join('\n')), 'running Bash')
    assert.equal(parseActivity([assistantTool, assistantText].join('\n')), 'waiting for you')
  })

  it('skips entries that carry no activity', () => {
    const transcript = [assistantTool, entry({ type: 'ai-title', aiTitle: 'x' }), entry({ type: 'mode' })]
    assert.equal(parseActivity(transcript.join('\n')), 'running Bash')
  })

  it('tolerates a tail that begins mid-line', () => {
    assert.equal(parseActivity(`{"type":"assist\n${assistantTool}`), 'running Bash')
  })

  it('tolerates a half-written final line from a live session', () => {
    assert.equal(parseActivity(`${assistantTool}\n{"type":"ass`), 'running Bash')
  })

  it('is undefined when nothing in the tail says anything', () => {
    assert.equal(parseActivity(entry({ type: 'mode' })), undefined)
    assert.equal(parseActivity(''), undefined)
  })
})
