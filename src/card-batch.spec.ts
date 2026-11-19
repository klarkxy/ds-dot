import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createAssistantMessage, type ToolCallBlock } from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { bindScopeParent, createScope } from '@deepseek-ai/dsh-scope'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { defineTool, ToolsService } from '@deepseek-ai/dsh-tools'
import { executeToolBatch, ToolExecutionPipeline } from '@deepseek-ai/dsh-tools/pipeline'
import { expect, it, vi } from 'vitest'
import { apply, DOT_INHERITED_ALLOW, dotDevIndexReady } from './tools.ts'
import { restrictInheritedTools } from './tool-scope.ts'

// Replay the incident at the same boundary as the native executor. Network and the
// model's two messages are fixtures; session events, tool dispatch and settlement are real.
it.each([true, false])('reads the lookup before concluding with one card (card first: %s)', async cardFirst => {
  const ctx = new Context()
  new SystemPrompt(ctx, {} as never)
  new ToolsService(ctx)
  new SessionStore(ctx)
  const session = ctx.sessions.create()
  const agent = { id: session.id, session } as Agent
  const presentCard = vi.fn(async (shown, viewId) => ({ ...shown, owner: 'dsh-deep-view', viewId, awaitReply: false }))
  ctx.provide('dot', { presentCard } as never)
  const presetKey = {}
  const preset = createScope(ctx, presetKey)
  const scoped = createScope(ctx, agent)
  bindScopeParent(agent, presetKey)
  try {
    apply(preset.ctx)
    await dotDevIndexReady()
    restrictInheritedTools(scoped.ctx, DOT_INHERITED_ALLOW, agent)
    expect(ctx.tools.schemas(agent).map(tool => tool.name)).toEqual(expect.arrayContaining(['dot_task', 'show_view', 'web_fetch']))
    const lookup = defineTool({
      name: 'web_fetch', description: 'Fixture source', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async () => 'Riichi requires a closed hand.',
    })
    const pipeline = new ToolExecutionPipeline(ctx, { get: (name, scope) => name === 'web_fetch' ? lookup : ctx.tools.get(name, scope) })
    const card = (id: string, text: string): ToolCallBlock => ({ type: 'tool-call', id: ToolCallId(id), name: 'show_view', arguments: JSON.stringify({ view: JSON.stringify({ type: 'text', text }) }) })
    const fetch: ToolCallBlock = { type: 'tool-call', id: ToolCallId('lookup'), name: 'web_fetch', arguments: '{}' }
    const run = async (calls: ToolCallBlock[], step: number) => {
      const log = { turn: 1, step }
      session.append('step/start', log)
      const message = createAssistantMessage({ content: calls, source: { provider: 'fixture', model: 'fixture' } } as never)
      session.append('assistant/message', { ...log, message, stream: [] }, { surfaceOp: 'append' })
      const result = await executeToolBatch({ agent, calls, log, signal: new AbortController().signal }, pipeline, () => 4)
      session.append('step/end', log)
      return result
    }
    session.append('turn/start', { turn: 1 })
    const earlyCard = card('early', '稍等，我去查。')
    const batch = await run(cardFirst ? [earlyCard, fetch] : [fetch, earlyCard], 1)
    expect(batch.results.find(entry => entry.callId === fetch.id)?.result.content).toEqual([{ type: 'text', text: 'Riichi requires a closed hand.' }])
    expect(batch.concluded).toBe(false)
    expect(batch.results.find(entry => entry.callId === earlyCard.id)?.result).toMatchObject({
      isError: false, meta: { dshDot: { showView: 'deferred' } },
    })
    expect(presentCard).not.toHaveBeenCalled()
    const final = await run([card('answer', '立直需要门前清。')], 2)
    expect(final.concluded).toBe(true)
    expect(presentCard).toHaveBeenCalledTimes(1)
    expect(presentCard.mock.calls[0][0].view).toEqual({ type: 'text', text: '立直需要门前清。' })
  } finally {
    await scoped.dispose()
    await preset.dispose()
  }
})
