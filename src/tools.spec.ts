import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SHOW_VIEW_MIXED_SUMMARY, showViewSharesStep } from './card-step.ts'
import { apply, TASK_ACTIONS } from './tools.ts'
import { apply as applyReflection, REFLECTION_SUBMIT_TOOL } from './reflection.ts'
import { DEFAULT_SETTINGS, TOOL, type DotSettings } from './contracts.ts'
import { DEFAULT_PERSONA } from './persona.ts'
import { settingsSnapshotBlock, SelfSettings } from './self-settings.ts'
import { DotStore } from './store.ts'

interface Seg { sessionId: string; persona: string; opening?: string; agreements?: string; cognition?: string }

/** Load the preset row against a recording host: every definition must compile. */
function load(settings: { current: DotSettings; segment?: Seg; notes?: string; cognition?: string } = { current: DEFAULT_SETTINGS }) {
  const registered: Array<Record<string, unknown>> = []
  const sections: Array<{ name: string; order: number; text: (context?: { agent?: { session?: { id?: string } } }) => string }> = []
  const store = new DotStore(undefined)
  const view = async () => ({
    agreements: { text: settings.notes ?? '', maxChars: 4000, canUndo: false },
    cognition: { text: settings.cognition ?? '', maxChars: 4000, history: [] },
  })
  // A real SelfSettings backed by a real DotStore so the locks guard works.
  const service = {
    store,
    knowledgeView: view,
    setAgreements: view,
    setCognition: view,
    undoAgreements: view,
    restoreCognition: view,
    settingsChanged: async () => {},
    serialSettings: async <T>(work: () => Promise<T>) => work(),
  }
  const realSelf = new SelfSettings(service as never)
  let cardNumber = 0
  const ctx = {
    tools: {
      schemas: () => [],
      restrict: () => () => {},
      register(definition: Record<string, unknown>) { registered.push(definition); return () => {} },
    },
    on: () => () => {},
    systemPrompt: { section(section: (typeof sections)[number]) { sections.push(section); return () => {} } },
    dot: {
      store: { get settings() { return settings.current }, get segment() { return settings.segment } },
      currentAgreementsBlock: () => settings.notes ?? '',
      currentCognitionBlock: () => settings.cognition ?? '',
      selfSettings: realSelf,
      answer: (id: string, answer: unknown) => JSON.stringify({ id, answer }),
      presentCard: async (shown: { title: string; view: Record<string, unknown>; interactive: boolean }, callId?: string) => {
        cardNumber += 1
        return {
          owner: 'dsh-deep-view', title: shown.title, view: shown.view, interactive: shown.interactive,
          awaitReply: shown.interactive, ...(callId ? { viewId: callId } : {}),
          ...(shown.interactive ? { dotCard: { number: cardNumber } } : {}),
        }
      },
    },
    effect(fn: () => unknown) { fn() },
  }
  apply(ctx as never)
  return Object.assign(registered, { sections })
}

/** The private preset gets the same schema guard as the public dot tools. */
function loadReflection() {
  const registered: Array<Record<string, unknown>> = []
  applyReflection({
    tools: {
      schemas: () => [],
      restrict: () => () => {},
      register(definition: Record<string, unknown>) { registered.push(definition); return () => {} },
    },
    dot: {},
    on: () => () => {},
    effect(fn: () => unknown) { fn() },
  } as never)
  return registered
}

const allSchemas = () => [...load(), ...loadReflection()]

describe('dot tools', () => {
  it('keeps the private reflection preset to history reads and one restricted submission', () => {
    expect(loadReflection().map(tool => tool.name).sort()).toEqual([TOOL.searchHistory, TOOL.readHistory, REFLECTION_SUBMIT_TOOL].sort())
  })
  it('compiles every dot tool definition through defineTool and keeps 19 dot_* plus show_view', () => {
    const names = load().map(tool => tool.name)
    expect([...names].sort()).toEqual([...Object.values(TOOL), 'show_view'].sort())
    expect(names).toHaveLength(20)
    expect(new Set(names).size).toBe(20)
  })

  it('marks only the reading tools read-only', () => {
    const readOnly = load().filter(tool => tool.hostEffect === 'read-only').map(tool => tool.name).sort()
    // dot_schedule is NOT read-only: add and remove mutate state.
    // dot_settings is NOT read-only: propose mutates state.
    // dot_workspace is NOT read-only: create mutates state.
    // dot_agreement / dot_cognition are NOT read-only: they mutate knowledge.
    // show_view is read-only so the no-approval dot policy runs it directly.
    expect(readOnly).toEqual([TOOL.listModels, TOOL.overview, TOOL.read, TOOL.readHistory, TOOL.searchHistory, 'show_view'].sort())
  })

  it('registers the merged tools, not the old split ones', () => {
    const names = load().map(tool => tool.name)
    expect(names).toContain(TOOL.workspace)
    expect(names).toContain(TOOL.schedule)
    expect(names).toContain(TOOL.settings)
    expect(names).toContain(TOOL.agreement)
    expect(names).toContain(TOOL.cognition)
    for (const old of ['dot_list_workspaces', 'dot_create_workspace', 'dot_schedule_add', 'dot_schedule_list', 'dot_schedule_remove', 'dot_read_settings', 'dot_propose_settings', 'dot_remember', 'dot_forget']) {
      expect(names).not.toContain(old)
    }
  })

  it('lists inspect/files on workspaces and names the Deep View rich nodes', () => {
    const workspace = load().find(row => row.name === TOOL.workspace) as { parameters: { properties?: { action?: { enum?: string[] } }; action?: { enum?: string[] } }; description: string }
    const action = workspace.parameters.properties?.action ?? workspace.parameters.action
    expect(action?.enum).toEqual(['list', 'inspect', 'files', 'create', 'read'])
    expect(workspace.description).toContain('inspect')
    expect(workspace.description).toContain('files')
    expect(workspace.description).toContain('read')
    const view = load().find(row => row.name === 'show_view') as { description: string }
    for (const node of ['steps', 'math', 'flow', 'explore', 'map']) expect(view.description).toContain(node)
  })

  it('does not tell the model a review is read-only or that closeout takes a settled review', () => {
    type Tool = { description: string; parameters: { properties: Record<string, { description?: string }> } }
    const task = load().find(row => row.name === TOOL.task) as Tool
    const role = task.parameters.properties.role?.description ?? ''
    // Review holds the workspace exclusively so writers cannot run alongside, but the session launches read-only.
    expect(role).toContain('reserves the whole workspace')
    expect(role).toContain('read-only')
    expect(role).not.toContain('write access')
    // closeoutFromTool refuses a review that is already completed, failed, or stopped, then holds an open one.
    const review = task.parameters.properties.review_run_id?.description ?? ''
    expect(review).toContain('open review')
    expect(review).toContain('already completed, failed, or stopped')
    expect(review).not.toMatch(/settled/)
    // human_review gates acceptance. The first closeout records the verification and opens the decision.
    const human = task.parameters.properties.human_review?.description ?? ''
    expect(human).toContain('before acceptance')
    expect(human).not.toContain('before closeout')
  })

  it('no tool parameter schema uses oneOf / anyOf / allOf / const or a union type', () => {
    const tools = allSchemas()
    const forbidden = ['oneOf', 'anyOf', 'allOf', 'const']
    for (const t of tools) {
      const json = JSON.stringify(t.parameters ?? {})
      for (const kw of forbidden) {
        expect(json, `${t.name as string} schema must not contain "${kw}"`).not.toContain(`"${kw}"`)
      }
      // union type like ["string","null"] is also forbidden
      expect(json, `${t.name as string} schema must not use type arrays`).not.toMatch(/"type"\s*:\s*\[/)
    }
  })

  it('uses only scalar fields in every flat tool schema', () => {
    for (const tool of allSchemas()) {
      const parameters = tool.parameters as Record<string, unknown>
      const properties = (parameters.properties ?? parameters) as Record<string, Record<string, unknown>>
      for (const [name, field] of Object.entries(properties)) {
        expect(['string', 'number', 'integer', 'boolean'], `${tool.name}.${name}`).toContain(field.type)
        expect(field).not.toHaveProperty('properties')
        expect(field).not.toHaveProperty('items')
      }
    }
  })

  it('accepts JSON-encoded settings values and reports malformed JSON', async () => {
    const tool = load().find(row => row.name === TOOL.settings) as { execute(args: unknown): Promise<string> }
    expect(await tool.execute({ action: 'propose', field: 'approvals', value: '"human"', reason: 'Ask me every time' })).toContain('waits for the human')
    expect(await tool.execute({ action: 'propose', field: 'reflection', value: 'false', reason: 'pause it' })).toContain('waits for the human')
    await expect(tool.execute({ action: 'propose', field: 'scope', value: 'broken JSON', reason: 'invalid' })).rejects.toMatchObject({ code: 'dot/invalid' })
  })

  it('decodes question answers from JSON text and rejects malformed payloads', async () => {
    const tool = load().find(row => row.name === TOOL.answerPending) as { execute(args: unknown): Promise<string> }
    const answer = await tool.execute({ id: 'q-1', answers: '[{"id":"choice","selected":["Yes"],"custom":"why"}]' })
    expect(JSON.parse(answer)).toEqual({ id: 'q-1', answer: { kind: 'question', answers: [{ id: 'choice', selected: ['Yes'], custom: 'why' }] } })
    await expect(tool.execute({ id: 'q-1', answers: 'broken' })).rejects.toMatchObject({ code: 'dot/invalid' })
    await expect(tool.execute({ id: 'q-1', answers: '[null]' })).rejects.toMatchObject({ code: 'dot/invalid' })
    await expect(tool.execute({ id: 'q-1', allow: true, answers: '[]' })).rejects.toMatchObject({ code: 'dot/invalid' })
  })

  it('registers one same-name show_view with a flat schema and single-step conclusion', async () => {
    const tool = load().find(row => row.name === 'show_view') as unknown as {
      parameters: { properties: Record<string, { type: string }>; required?: string[] }
      output: { render: (args: unknown, value: unknown) => unknown; presentationMeta: (args: unknown, value: unknown) => unknown }
      execute: (args: unknown, exec: { callId?: string; concludeTurn(): void }) => Promise<Record<string, unknown>>
    }
    expect(Object.keys(tool.parameters.properties).sort()).toEqual(['approval_id', 'await_reply', 'title', 'view'])
    expect(tool.parameters.properties.title!.type).toBe('string')
    expect(tool.parameters.properties.view!.type).toBe('string')
    expect(tool.parameters.properties.await_reply!.type).toBe('boolean')
    expect(tool.parameters.required).toEqual(['view'])

    let concluded = 0
    const exec = { callId: 'call-1', concludeTurn: () => { concluded += 1 } }
    const result = await tool.execute({ title: 'Pick target', view: JSON.stringify({ type: 'options', id: 'o', options: [{ label: 'A' }, { label: 'B' }] }), await_reply: true }, exec)
    expect(result.status).toBe('shown')
    expect(concluded).toBe(1)
    expect(tool.output.render(undefined, result)).toEqual([{ type: 'text', text: 'shown' }])
    expect(tool.output.presentationMeta(undefined, result)).toMatchObject({ owner: 'dsh-deep-view', title: 'Pick target', interactive: true, awaitReply: true, dotCard: { number: 1 } })
  })

  it('shows a math card', async () => {
    const tool = load().find(row => row.name === 'show_view') as unknown as {
      execute: (args: unknown, exec: { callId?: string; concludeTurn(): void }) => Promise<Record<string, unknown>>
    }
    let concluded = 0
    const result = await tool.execute({
      title: 'Plot',
      view: JSON.stringify({ type: 'math', id: 'm', mathPoints: [{ id: 'p', x: 0, y: 0 }] }),
    }, { callId: 'm1', concludeTurn: () => { concluded += 1 } })
    expect(result.status).toBe('shown')
    expect(concluded).toBe(1)
  })

  it('treats either tool order as one shared step and does not read an older message', () => {
    const step = (calls: { id: string }[]) => ({ role: 'assistant', content: calls.map(call => ({ type: 'tool-call', id: call.id })) })
    const cardFirst = [step([{ id: 'card' }, { id: 'lookup' }])]
    const workFirst = [step([{ id: 'lookup' }, { id: 'card' }])]
    expect(showViewSharesStep(cardFirst, 'card')).toBe(true)
    expect(showViewSharesStep(workFirst, 'card')).toBe(true)
    expect(showViewSharesStep([step([{ id: 'card' }])], 'card')).toBe(false)
    expect(showViewSharesStep([step([{ id: 'card' }, { id: 'card' }])], 'card')).toBe(true)
    const followed = [cardFirst[0]!, step([{ id: 'answer' }])]
    expect(showViewSharesStep(followed, 'answer')).toBe(false)
    // The same id in an older message is not this step, and it is not a single card.
    expect(showViewSharesStep(followed, 'card')).toBe(true)
    expect(showViewSharesStep(undefined, 'card')).toBe(false)
    expect(showViewSharesStep([], 'card')).toBe(false)
  })

  it('tells the model to call the card alone when the step is mixed', async () => {
    const tool = load().find(row => row.name === 'show_view') as unknown as {
      output: { render: (args: unknown, value: unknown) => unknown }
      execute: (args: unknown, exec: { callId?: string; concludeTurn(): void; agent?: { session?: { deriveMessages(): readonly { role?: string; content?: readonly { type?: string; id?: string }[] }[] } } }) => Promise<Record<string, unknown>>
    }
    let concluded = 0
    const result = await tool.execute({ view: JSON.stringify({ type: 'text', text: 'hi' }) }, {
      callId: 'card',
      concludeTurn: () => { concluded += 1 },
      agent: { session: { deriveMessages: () => [{ role: 'assistant', content: [{ type: 'tool-call', id: 'card' }, { type: 'tool-call', id: 'lookup' }] }] } },
    })
    expect(result).toMatchObject({ status: 'deferred', summary: SHOW_VIEW_MIXED_SUMMARY })
    expect(tool.output.render(undefined, result)).toEqual([{ type: 'text', text: SHOW_VIEW_MIXED_SUMMARY }])
    expect(concluded).toBe(0)
  })

  it('keeps an invalid show_view in the same turn without concluding it', async () => {
    const tool = load().find(row => row.name === 'show_view') as unknown as {
      output: { presentationMeta: (args: unknown, value: unknown) => unknown }
      execute: (args: unknown, exec: { callId?: string; concludeTurn(): void }) => Promise<Record<string, unknown>>
    }
    let concluded = 0
    const exec = { callId: 'c', concludeTurn: () => { concluded += 1 } }
    const badJson = await tool.execute({ view: '{not json' }, exec)
    expect(badJson.status).toBe('invalid')
    expect(String(badJson.summary)).toContain('JSON')
    const missingType = await tool.execute({ view: JSON.stringify({ text: 'hi' }) }, exec)
    expect(missingType.status).toBe('invalid')
    const mismatch = await tool.execute({ view: JSON.stringify({ type: 'text', text: 'hi' }), await_reply: true }, exec)
    expect(mismatch.status).toBe('invalid')
    expect(tool.output.presentationMeta(undefined, mismatch)).toBeNull()
    expect(concluded).toBe(0)
  })

  it('gives the knowledge tools flat, primitive schemas', () => {
    const byName = new Map(load().map(tool => [tool.name, tool]))
    const propsOf = (tool: Record<string, unknown>): Record<string, { type: string; enum?: string[] }> => {
      const parameters = tool.parameters as Record<string, unknown> | undefined
      const properties = parameters && typeof parameters === 'object' ? parameters.properties : undefined
      return (properties && typeof properties === 'object' ? properties : parameters) as Record<string, { type: string; enum?: string[] }>
    }
    const agreement = propsOf(byName.get(TOOL.agreement)!)
    expect(agreement.action).toMatchObject({ type: 'string', enum: ['add', 'remove'] })
    expect(agreement.text).toMatchObject({ type: 'string' })
    const cognition = propsOf(byName.get(TOOL.cognition)!)
    // No action on cognition: it always rewrites the whole text.
    expect(Object.keys(cognition)).toEqual(['text'])
    expect(cognition.text).toMatchObject({ type: 'string' })
  })

  it('exposes exactly the high-level task operations and rejects removed actions', async () => {
    const tool = load().find(row => row.name === TOOL.task) as { parameters: { properties: Record<string, { enum?: string[] }> }; execute(args: unknown): Promise<string> }
    expect(tool.parameters.properties.action.enum).toEqual(['create', 'revise', 'dispatch', 'check', 'read', 'list', 'supplement', 'finish', 'step', 'closeout', 'pause', 'resume', 'cancel', 'decide', 'reject', 'link', 'unlink'])
    expect(tool.parameters.properties.action.enum).toEqual([...TASK_ACTIONS])
    for (const action of ['reserve', 'baseline', 'subject', 'evidence', 'verify', 'hold', 'accept', 'move', 'note', 'delete', 'board', 'update', 'start']) await expect(tool.execute({ action })).rejects.toThrow()
    for (const field of ['subject', 'subject_ref', 'evidence_ref', 'to', 'status', 'summary', 'session_id']) expect(tool.parameters.properties).not.toHaveProperty(field)
    expect(loadReflection().map(row => row.name)).not.toContain(TOOL.task)
  })

  it('brings Deep View once under its own mount id without restoring dsh-dev-index', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..')
    const rowsOf = (file: string) => [...readFileSync(file, 'utf8').matchAll(/- id: (\S+)\s+name: '([^']+)'/g)].map(match => ({ id: match[1]!, name: match[2]! }))
    const rows = rowsOf(join(root, 'cordis.patch.yml'))
    expect(rows).toEqual([{ id: 'dot-attribution', name: 'ds-dot/attribution' }, { id: 'deep-view', name: '@klarkxy/dsh-deep-view' }, { id: 'dot', name: 'ds-dot' }])
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    // The dependency has to resolve from npm: a link:/file: spec only resolves on
    // the machine that owns that checkout, so a GitHub install would find no Deep View.
    expect(String(pkg.dependencies['@klarkxy/dsh-deep-view'])).toMatch(/^\^?\d+\.\d+\.\d+$/)
    expect(JSON.stringify(pkg.pnpm ?? {})).not.toContain('dsh-deep-view')
    expect(pkg.files).toContain('src')
    expect(pkg.peerDependencies['@klarkxy/dsh-dev-index']).toBeTruthy()
    expect(pkg.peerDependenciesMeta['@klarkxy/dsh-dev-index']?.optional).toBe(true)
  })

  it('injects a settings-snapshot section after the frozen blocks', () => {
    const settings: { current: DotSettings } = { current: { ...DEFAULT_SETTINGS, approvals: 'human' as const, scope: 'tracked' as const } }
    const snap = load(settings).sections.find(s => s.name === 'dsh-dot:settings-snapshot')
    expect(snap).toBeDefined()
    expect(snap!.order).toBe(5)
    const text = snap!.text()
    expect(text).toContain('scope: tracked')
    expect(text).toContain('approvals: human')
    // Live — not frozen by segment
    settings.current = { ...DEFAULT_SETTINGS, approvals: 'deny' as const }
    expect(snap!.text()).toContain('approvals: deny')
  })

  it('renders the persona from the live settings until a segment freezes it', () => {
    const settings: Parameters<typeof load>[0] = { current: DEFAULT_SETTINGS }
    const [section] = load(settings).sections
    expect(section).toMatchObject({ name: 'dsh-dot:persona', order: 1 })
    expect(section!.text()).toContain(DEFAULT_PERSONA)
    expect(section!.text()).toContain('\u201c你\u201d')  // DEFAULT_ADDRESS wrapped in curly quotes
    settings.current = { ...DEFAULT_SETTINGS, persona: 'A calm librarian.', address: '老板' }
    expect(section!.text()).toContain('A calm librarian.')
    expect(section!.text()).not.toContain('鲸鱼娘')
    expect(section!.text()).toContain('\u201c老板\u201d')  // custom address in curly quotes
    settings!.segment = { sessionId: 'dot1', persona: 'FROZEN PERSONA' }
    expect(section!.text()).toBe('FROZEN PERSONA')
    expect(section!.text({ agent: { session: { id: 'dot1' } } })).toBe('FROZEN PERSONA')
    // A session that is not the recorded segment still reads the live settings.
    expect(section!.text({ agent: { session: { id: 'dot2' } } })).toContain('A calm librarian.')
  })

  it('carries the agreements and cognition between the persona and the handoff, as the segment froze them', () => {
    const settings: Parameters<typeof load>[0] = { current: DEFAULT_SETTINGS, notes: '[agreements]\n- live', cognition: '[cognition]\nfeel' }
    const [, agreements, cognition] = load(settings).sections
    expect(agreements).toMatchObject({ name: 'dsh-dot:agreements', order: 2 })
    expect(cognition).toMatchObject({ name: 'dsh-dot:cognition', order: 3 })
    // No segment yet: the blocks as they are now.
    expect(agreements!.text()).toBe('[agreements]\n- live')
    expect(cognition!.text()).toBe('[cognition]\nfeel')
    settings!.segment = { sessionId: 'dot1', persona: 'P', agreements: '[agreements]\n- frozen', cognition: '[cognition]\nfrozen feel' }
    expect(agreements!.text({ agent: { session: { id: 'dot1' } } })).toBe('[agreements]\n- frozen')
    expect(cognition!.text({ agent: { session: { id: 'dot1' } } })).toBe('[cognition]\nfrozen feel')
    // A session being set up is not the recorded segment and reads the live blocks.
    expect(agreements!.text({ agent: { session: { id: 'dot2' } } })).toBe('[agreements]\n- live')
    // A segment that started without a block keeps none, whatever was added since.
    settings!.segment = { sessionId: 'dot1', persona: 'P' }
    expect(agreements!.text({ agent: { session: { id: 'dot1' } } })).toBe('')
    expect(cognition!.text({ agent: { session: { id: 'dot1' } } })).toBe('')
  })

  it('adds the handoff block after the knowledge blocks, and nothing in the first segment', () => {
    const settings: Parameters<typeof load>[0] = { current: DEFAULT_SETTINGS }
    const handoff = load(settings).sections[3]
    expect(handoff).toMatchObject({ name: 'dsh-dot:handoff', order: 4 })
    expect(handoff!.text()).toBe('')
    settings!.segment = { sessionId: 'dot1', persona: 'P', opening: '[conversation handoff] …' }
    expect(handoff!.text({ agent: { session: { id: 'dot1' } } })).toBe('[conversation handoff] …')
    expect(handoff!.text({ agent: { session: { id: 'dot2' } } })).toBe('')
  })

  it('does not expose locks or the workspace directory as a self-service setting', async () => {
    const tool = load().find(row => row.name === TOOL.settings) as { execute(args: unknown): Promise<string> }
    // propose with locked field should fail (SelfSettings.propose throws)
    await expect(tool.execute({ action: 'propose', field: 'locks', value: '{}', reason: 'unlock' })).rejects.toThrow()
  })
})

describe('settingsSnapshotBlock', () => {
  it('includes all core hard-switch fields', () => {
    const block = settingsSnapshotBlock(DEFAULT_SETTINGS)
    expect(block).toContain('scope: tracked')
    expect(block).toContain('approvals: dot')
    expect(block).toContain('questions: dot')
    expect(block).toContain('[settings snapshot')
  })

  it('includes taskPermission when present', () => {
    const settings = { ...DEFAULT_SETTINGS, taskPermission: 'workspace-write' } as unknown as DotSettings
    expect(settingsSnapshotBlock(settings)).toContain('taskPermission: workspace-write')
  })

  it('shows the fresh workspace-write default and reflection switch', () => {
    const snapshot = settingsSnapshotBlock(DEFAULT_SETTINGS)
    expect(snapshot).toContain('taskPermission: workspace-write')
    expect(snapshot).toContain('reflection: true')
    expect(settingsSnapshotBlock({ ...DEFAULT_SETTINGS, taskPermission: 'default', reflection: false })).toContain('taskPermission: default')
    expect(settingsSnapshotBlock({ ...DEFAULT_SETTINGS, reflection: false })).toContain('reflection: false')
  })
})
