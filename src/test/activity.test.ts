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
const askUserQuestion = entry({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', name: 'AskUserQuestion' }] }
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

  it('reports idle once the assistant has finished its turn', () => {
    assert.equal(parseActivity(assistantText), 'idle')
  })

  it('reports a blocking tool as waiting for you, not as running', () => {
    assert.equal(parseActivity(askUserQuestion), 'waiting for you · AskUserQuestion')
  })

  it('still reports an ordinary tool as running', () => {
    const other = entry({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read' }] } })
    assert.equal(parseActivity(other), 'running Read')
  })

  it('stops waiting for you once the answer comes back', () => {
    assert.equal(parseActivity([askUserQuestion, toolResult].join('\n')), 'working')
  })

  it('reports thinking after a prompt', () => {
    assert.equal(parseActivity(userPrompt), 'thinking')
  })

  it('reports working when a tool result has come back', () => {
    assert.equal(parseActivity(toolResult), 'working')
  })

  it('uses the last entry, not the first', () => {
    assert.equal(parseActivity([userPrompt, assistantTool].join('\n')), 'running Bash')
    assert.equal(parseActivity([assistantTool, assistantText].join('\n')), 'idle')
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
