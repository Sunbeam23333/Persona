import { interactionId } from '../../runtime-sdk/index.js'
import { randomUUID } from 'node:crypto'

const cancelled = () => ({ outcome: { outcome: 'cancelled' } })

/** Only an explicit, current user answer can grant permission. Dismissal, disconnect, and abort deny. */
export async function handleInteraction(method, params, context) {
  const { session, ask, signal } = context
  if (signal?.aborted) return cancelled()
  // Upstream tool-call IDs can be absent or reused. Never reuse a resolved Persona approval.
  // One invocation keeps its ID throughout runtime.ask's own reconnect handling.
  const id = interactionId('cursor', session.id, method, randomUUID())
  const askSafely = async interaction => {
    try {
      const answer = await ask({ id, session_id: session.id, ...interaction }, { signal })
      return signal?.aborted || answer?.dismiss ? undefined : answer
    } catch { return undefined }
  }
  if (method === 'session/request_permission') {
    if (params.sessionId !== session.nativeId) return cancelled()
    const options = Array.isArray(params.options) ? params.options : []
    if (!options.length || options.some(option => !option || typeof option.optionId !== 'string' || !option.optionId ||
      !['allow_once', 'allow_always', 'reject_once', 'reject_always'].includes(option.kind)) ||
      new Set(options.map(option => option.optionId)).size !== options.length ||
      new Set(options.map(option => option.kind)).size !== options.length) return cancelled()
    const allow = options.find(option => option.kind === 'allow_once')
    const deny = options.find(option => option.kind === 'reject_once')
    if (!allow || typeof allow.optionId !== 'string') return cancelled()
    const answer = await askSafely({ kind: 'permission', tool_name: params.toolCall?.title ?? 'Cursor tool',
      tool_input: params.toolCall?.rawInput ?? {}, summary: params.toolCall?.title ?? 'Cursor requests permission' })
    const selected = answer?.allow === true ? allow : deny
    return selected && typeof selected.optionId === 'string'
      ? { outcome: { outcome: 'selected', optionId: selected.optionId } } : cancelled()
  }
  if (method === 'cursor/create_plan') {
    if (typeof params.plan !== 'string' || !params.plan.trim()) return { outcome: { outcome: 'rejected', reason: 'No valid plan was provided.' } }
    const answer = await askSafely({ kind: 'plan', plan: params.plan, summary: typeof params.name === 'string' ? params.name : 'Cursor plan' })
    return answer?.approve === true
      ? { outcome: { outcome: 'accepted' } }
      : { outcome: { outcome: 'rejected', reason: answer?.feedback ?? 'Not approved in Persona.' } }
  }
  if (method === 'cursor/ask_question') {
    const questions = params.questions
    if (!Array.isArray(questions) || !questions.length || questions.length > 20 ||
      questions.some(q => !q || typeof q.id !== 'string' || !q.id.trim() || typeof q.prompt !== 'string' || !q.prompt.trim() || !Array.isArray(q.options) || !q.options.length ||
        q.options.some(option => !option || typeof option.id !== 'string' || !option.id || typeof option.label !== 'string' || !option.label ||
          (q.allowMultiple === true && option.label.includes(', '))) ||
        new Set(q.options.map(option => option.label)).size !== q.options.length ||
        new Set(q.options.map(option => option.id)).size !== q.options.length) ||
      new Set(questions.map(q => q.prompt)).size !== questions.length ||
      new Set(questions.map(q => q.id)).size !== questions.length) return cancelled()
    const answer = await askSafely({ kind: 'question', questions: questions.map(q => ({ question: q.prompt,
      header: params.title ?? '', multi_select: q.allowMultiple === true,
      options: q.options.map(option => ({ label: option.label, description: option.id })) })) })
    if (!answer?.answers || typeof answer.answers !== 'object') return cancelled()
    const answers = []
    for (const question of questions) {
      const raw = answer.answers[question.prompt]
      const labels = typeof raw === 'string' ? (question.allowMultiple ? raw.split(', ').filter(Boolean) : [raw]) : []
      const chosen = labels.map(label => question.options.find(option => option.label === label))
      if (!chosen.length || chosen.some(option => !option) || (!question.allowMultiple && chosen.length !== 1)) return cancelled()
      answers.push({ questionId: question.id, selectedOptionIds: [...new Set(chosen.map(option => option.id))] })
    }
    return { outcome: { outcome: 'answered', answers } }
  }
  throw new Error('Unsupported ACP request')
}
