import test from 'node:test'
import assert from 'node:assert/strict'
import { handleInteraction } from '../lib/interactions.js'

const session = { id: 'cursor-test', nativeId: 'native-1' }
const permission = { sessionId: 'native-1', toolCall: { toolCallId: 'call-1', title: 'Run tests' }, options: [
  { optionId: 'allow-once', kind: 'allow_once' }, { optionId: 'deny-once', kind: 'reject_once' },
  { optionId: 'allow-always', kind: 'allow_always' },
] }
const context = answer => ({ session, ask: async () => answer })

test('permission requires explicit allow; absence, dismiss, errors, and aborted answers deny', async () => {
  const yes = await handleInteraction('session/request_permission', permission, context({ allow: true, always: true }))
  assert.equal(yes.outcome.optionId, 'allow-once')
  for (const answer of [undefined, {}, { dismiss: true, allow: true }, { allow: false }]) {
    assert.equal((await handleInteraction('session/request_permission', permission, context(answer))).outcome.optionId, 'deny-once')
  }
  const controller = new AbortController()
  const aborted = await handleInteraction('session/request_permission', permission, { session, signal: controller.signal,
    ask: async () => { controller.abort(); return { allow: true } } })
  assert.equal(aborted.outcome.optionId, 'deny-once')
  const failed = await handleInteraction('session/request_permission', permission, { session, ask: async () => { throw new Error('offline') } })
  assert.equal(failed.outcome.optionId, 'deny-once')
  assert.equal((await handleInteraction('session/request_permission', { ...permission, sessionId: 'wrong' }, context({ allow: true }))).outcome.outcome, 'cancelled')
})

test('plans deny by default and selected answers map back to Cursor option ids', async () => {
  assert.equal((await handleInteraction('cursor/create_plan', { plan: 'Do work' }, context({}))).outcome.outcome, 'rejected')
  assert.equal((await handleInteraction('cursor/create_plan', { plan: 'Do work' }, context({ approve: true }))).outcome.outcome, 'accepted')
  const params = { toolCallId: 'q1', questions: [{ id: 'mode', prompt: 'Choose mode', options: [{ id: 'ask', label: 'Ask' }, { id: 'agent', label: 'Agent' }] }] }
  const answer = await handleInteraction('cursor/ask_question', params, context({ answers: { 'Choose mode': 'Ask' } }))
  assert.deepEqual(answer.outcome.answers, [{ questionId: 'mode', selectedOptionIds: ['ask'] }])
  assert.equal((await handleInteraction('cursor/ask_question', params, context({ answers: { 'Choose mode': 'invented' } }))).outcome.outcome, 'cancelled')
  const ambiguous = { questions: [{ id: 'q', prompt: 'Pick one', options: [{ id: 'one', label: 'Same' }, { id: 'two', label: 'Same' }] }] }
  assert.equal((await handleInteraction('cursor/ask_question', ambiguous, context({ answers: { 'Pick one': 'Same' } }))).outcome.outcome, 'cancelled')
  await assert.rejects(handleInteraction('unknown', {}, context({})), /Unsupported/)
})

test('each reverse request has a fresh approval identity even with reused or absent tool IDs', async () => {
  const ids = []
  const ctx = { session, ask: async request => { ids.push(request.id); return { allow: true } } }
  for (const params of [permission, permission, { ...permission, toolCall: {} }, { ...permission, toolCall: {} }]) {
    assert.equal((await handleInteraction('session/request_permission', params, ctx)).outcome.optionId, 'allow-once')
  }
  assert.equal(new Set(ids).size, 4)
})

test('malformed or ambiguous plans, option IDs, question IDs and multi-select labels fail closed', async () => {
  const ctx = { session, ask: async () => { throw new Error('Malformed request must not ask') } }
  for (const plan of [undefined, '', '  ', {}, 123]) {
    assert.equal((await handleInteraction('cursor/create_plan', { plan }, ctx)).outcome.outcome, 'rejected')
  }
  for (const options of [
    [{ kind: 'allow_once', optionId: 'same' }, { kind: 'reject_once', optionId: 'same' }],
    [{ kind: 'allow_once', optionId: 'a' }, { kind: 'allow_once', optionId: 'b' }],
    [{ kind: 'automatic', optionId: 'a' }], [null],
  ]) assert.equal((await handleInteraction('session/request_permission', { ...permission, options }, ctx)).outcome.outcome, 'cancelled')
  const q = { id: 'q', prompt: 'Pick', options: [{ id: 'a', label: 'A' }] }
  for (const questions of [
    [{ ...q, id: 1 }], [{ ...q, prompt: {} }], [q, { ...q, prompt: 'Other' }],
    [{ ...q, allowMultiple: true, options: [{ id: 'whole', label: 'A, B' }, { id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }],
  ]) assert.equal((await handleInteraction('cursor/ask_question', { questions }, ctx)).outcome.outcome, 'cancelled')
})
