/**
 * The row projection: DSH Session log events, turned into the Claude Code
 * `session.append`, `turn.start` and `turn.complete` events Delta records.
 *
 * Claude Code lets a plugin observe and rewrite each conversation row as it is
 * appended, and it assigns that row a door (`prompt`, `response`, `tool-result`,
 * ...) which is what Delta's capture rules select on. The Harness Session log
 * is post-commit and cannot be rewritten, but its event vocabulary carries the
 * same facts: `user/message`, `assistant/message`, `tool/result`,
 * `turn/start`, `turn/end`, `session/title`. This module synthesizes the
 * engine events Delta's unchanged hooks expect from those events.
 *
 * Rows Delta would not record (an injected context block, a skill body, a
 * compaction notice) map to a door its hook matchers exclude, so the guard
 * stays at the same place as in Claude Code.
 */
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { transcriptPath } from './paths.js'

/** Parse a tool call's raw arguments; a malformed string stays visible as its text. */
function parseArguments(raw) {
  if (typeof raw !== 'string') return raw ?? {}
  try {
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' ? parsed : { value: parsed }
  } catch {
    return { value: raw }
  }
}

/** One DSH content block as the Messages-API block Delta's converter understands. */
export function apiBlock(block) {
  if (block === null || typeof block !== 'object') return undefined
  switch (block.type) {
    case 'text':
      return typeof block.text === 'string' ? { type: 'text', text: block.text } : undefined
    case 'reasoning':
      return typeof block.text === 'string' ? { type: 'thinking', thinking: block.text } : undefined
    case 'tool-call':
      return {
        type: 'tool_use',
        id: String(block.id),
        name: String(block.name),
        input: parseArguments(block.arguments),
      }
    case 'image':
      // The DSH image block carries an attachment reference, not bytes; keep the row
      // readable for Delta rather than dropping what the person attached.
      return { type: 'text', text: '[image attachment]' }
    case 'file':
      return { type: 'text', text: `[file attachment${block.attachment?.name ? `: ${block.attachment.name}` : ''}]` }
    default:
      return undefined
  }
}

/** A list of DSH content blocks as Messages-API blocks. */
export function apiBlocks(blocks) {
  if (!Array.isArray(blocks)) return []
  return blocks.map(apiBlock).filter((block) => block !== undefined)
}

/** Whether a Harness message source is the person typing at the prompt. */
function isHumanUserMessage(message) {
  return message?.source?.kind === 'user'
}

/** A user-role message's API form, with the door that decides whether Delta records it. */
function userAppend(message, agentId) {
  const human = isHumanUserMessage(message)
  const content = apiBlocks(message.content)
  if (!content.length) return undefined
  const door = human ? 'prompt' : doorForSource(message.source)
  return {
    event: {
      message: { type: 'user', role: 'user', content, ...(human ? {} : { isMeta: true }) },
      door,
      origin: human ? { kind: 'user' } : { kind: 'plugin', name: message.source?.kind ?? 'harness' },
      uuid: `${String(message.id ?? 'user')}`,
      ...(agentId === undefined ? {} : { agentId }),
    },
  }
}

/** The door a non-human user-role row came by; only `delivery` and `prompt` are recorded. */
function doorForSource(source) {
  const kind = source?.kind
  if (kind === 'recall' || kind === 'relay') return 'delivery'
  if (source?.form === 'notice') return 'notice'
  if (source?.form === 'instructions' || source?.form === 'catalog') return 'hook-context'
  if (source?.form === 'snapshot') return 'hook-context'
  if (kind === 'system-prompt') return 'note'
  return 'hook-context'
}

/** An assistant message's API form. */
function assistantAppend(message, agentId) {
  const content = apiBlocks(message.content)
  if (!content.length) return undefined
  return {
    event: {
      message: { type: 'assistant', role: 'assistant', content },
      door: 'response',
      origin: { kind: 'model', model: String(message.source?.model ?? 'harness') },
      uuid: `${String(message.id ?? 'assistant')}`,
      ...(agentId === undefined ? {} : { agentId }),
    },
  }
}

/** A tool result's API form: a user-role row carrying one `tool_result` block. */
function toolResultAppend(data, agentId) {
  const message = data?.message
  if (!message) return undefined
  const blocks = apiBlocks(message.content)
  const error = message.isError === true
  return {
    event: {
      message: {
        type: 'user',
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: String(message.toolCallId ?? data.callId ?? ''),
          content: blocks,
          is_error: error,
        }],
      },
      door: 'tool-result',
      origin: { kind: 'tool', tool: String(data.toolName ?? 'tool') },
      uuid: `${String(message.id ?? 'tool-result')}`,
      ...(agentId === undefined ? {} : { agentId }),
    },
  }
}

/** The engine reason for a Harness turn-end reason. */
function stopReason(reason) {
  switch (reason?.kind) {
    case 'completed': return { reason: 'answer', isAborted: false }
    case 'aborted': return { reason: 'aborted', isAborted: true }
    case 'error': return { reason: 'error', isAborted: false }
    case 'max-tokens': return { reason: 'refusal', isAborted: false }
    default: return { reason: 'aborted', isAborted: true }
  }
}

/** The turn id Delta receives: one stable name per Harness turn number. */
export function turnIdOf(turn) {
  return `turn-${turn}`
}

/**
 * Projects one Session's events into Delta's engine events and keeps the small
 * per-session facts the Host adapter needs (turn count and the current turn).
 */
export class RowProjector {
  constructor({ engine, bridge, logger }) {
    this.engine = engine
    this.bridge = bridge
    this.logger = logger
    this.sessions = new Map()
  }

  /** Per-session projection state. */
  state(sessionId) {
    let state = this.sessions.get(sessionId)
    if (state === undefined) {
      state = { turns: 0, userTurns: 0, openTurn: undefined, answer: '', queue: Promise.resolve() }
      this.sessions.set(sessionId, state)
    }
    return state
  }

  /** How many human prompts this session has recorded. */
  userTurns(sessionId) {
    return this.sessions.get(sessionId)?.userTurns ?? 0
  }

  /** Forget a disposed session's projection. */
  forget(sessionId) {
    this.sessions.delete(sessionId)
  }

  /** Enqueue one event behind the session's earlier events, so order is preserved. */
  handle(agent, session, event) {
    const state = this.state(String(session.id))
    state.queue = state.queue.then(() => this.apply(agent, session, event)).catch((error) => {
      this.logger.warn(`delta-dsh: could not project ${event.type}: ${error instanceof Error ? error.message : String(error)}`)
    })
    return state.queue
  }

  /** Dispatch one synthesized engine event. */
  async dispatch(agent, session, event, input, bottom, skip) {
    return await this.engine.dispatch(event, Object.freeze(input), bottom, {
      agent,
      session,
      signal: new AbortController().signal,
      skip,
    })
  }

  async apply(agent, session, event) {
    const state = this.state(String(session.id))
    const agentId = agent?.session?.header?.parentSession !== undefined ? String(session.id) : undefined
    switch (event.type) {
      case 'turn/start': {
        const turnId = turnIdOf(event.data.turn)
        state.turns = Math.max(state.turns, event.data.turn)
        state.openTurn = turnId
        state.answer = ''
        await this.dispatch(agent, session, 'turn.start', { text: '', turnId, ...(agentId === undefined ? {} : { agentId }) },
          async () => ({ turnId }))
        return
      }
      case 'user/message': {
        const row = userAppend(event.data, agentId)
        if (row === undefined) return
        if (isHumanUserMessage(event.data)) state.userTurns += 1
        await this.dispatch(agent, session, 'session.append', row.event, async (current) => ({
          message: current.message,
          uuid: current.uuid,
        }))
        return
      }
      case 'assistant/message': {
        const row = assistantAppend(event.data.message, agentId)
        if (row === undefined) return
        const text = apiBlocks(event.data.message.content)
          .filter((block) => block.type === 'text').map((block) => block.text).join('')
        if (text) state.answer = text
        await this.dispatch(agent, session, 'session.append', row.event, async (current) => ({
          message: current.message,
          uuid: current.uuid,
        }))
        return
      }
      case 'tool/result': {
        const row = toolResultAppend(event.data, agentId)
        if (row === undefined) return
        await this.dispatch(agent, session, 'session.append', row.event, async (current) => ({
          message: current.message,
          uuid: current.uuid,
        }))
        return
      }
      case 'turn/end': {
        const turnId = turnIdOf(event.data.turn)
        const stop = stopReason(event.data.reason)
        state.openTurn = undefined
        await this.dispatch(agent, session, 'turn.complete', {
          turnId,
          answer: state.answer,
          durationMs: 0,
          isAborted: stop.isAborted,
          reason: stop.reason,
          ...(agentId === undefined ? {} : { agentId }),
        }, async () => ({ text: '' }))
        return
      }
      case 'session/title': {
        await this.writeTitle(session, event.data)
        return
      }
      default:
        return
    }
  }

  /**
   * Append a Claude-shaped title row to a synthetic transcript, so Delta's own
   * title reader (which tails a transcript looking for `ai-title` and
   * `custom-title` rows) works unchanged.
   */
  async writeTitle(session, data) {
    const title = typeof data?.title === 'string' ? data.title : undefined
    if (!title) return
    const cwd = this.bridge.cwdOf(session)
    const path = transcriptPath(cwd, String(session.id))
    const renamed = data?.source?.kind === 'user'
    const row = renamed ? { type: 'custom-title', customTitle: title } : { type: 'ai-title', aiTitle: title }
    await mkdir(dirname(path), { recursive: true })
    await appendFile(path, `${JSON.stringify(row)}\n`, 'utf8')
  }
}
