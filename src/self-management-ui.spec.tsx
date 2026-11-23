import { act, useState } from 'react'
import { JSDOM } from 'jsdom'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type CognitionEntry, type DotSettings, type KnowledgeEdit } from './contracts.ts'
import { applyAgreementEdit, applyCognitionEdit, cognitionWithActive } from './memory.ts'
import { ContextPanel } from './context-panel.tsx'
import { PersonaPanel } from './persona-panel.tsx'
import { SettingsPanel } from './settings-panel.tsx'
import { TrajectoryPanel } from './trajectory-panel.tsx'

const dom = new JSDOM('<div id="root"></div>', { url: 'https://local.test' })
vi.stubGlobal('window', dom.window)
vi.stubGlobal('document', dom.window.document)
vi.stubGlobal('navigator', dom.window.navigator)
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
let createRoot: typeof import('react-dom/client').createRoot
beforeAll(async () => { createRoot = (await import('react-dom/client')).createRoot })
afterEach(() => { document.body.innerHTML = '<div id="root"></div>' })

function changeValue(element: HTMLElement, value: string): void {
  ;(element as HTMLInputElement | HTMLTextAreaElement).value = value
  const propsKey = Object.keys(element).find(key => key.startsWith('__reactProps'))
  const props = propsKey ? (element as unknown as Record<string, { onChange?: (event: { target: HTMLElement }) => void }>)[propsKey] : undefined
  props?.onChange?.({ target: element })
}

describe('Dorothy self-management controls', () => {
  it('locks a setting, renders readable proposal chips, switches segmented choices, and filters task models', async () => {
    const decisions: Array<{ id: string; allow: boolean }> = []
    let current: DotSettings = { ...DEFAULT_SETTINGS }
    const makeHarness = () => {
      const api = {
        models: async () => ({
          groups: [
            { id: 'openai', name: 'OpenAI', models: [{ id: 'gpt-5', name: 'GPT-5' }] },
            { id: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] },
          ],
        }),
        settings: async () => current,
        settingProposals: async () => [{ id: 'setting-1', field: 'scope' as const, before: 'all', after: 'tracked', reason: 'less noise', createdAt: 1 }],
        decideSetting: async (id: string, allow: boolean) => { decisions.push({ id, allow }); return 'Approved' },
        setSettings: async (patch: Partial<DotSettings>) => {
          current = { ...current, ...patch } as DotSettings
          return current
        },
      }
      return function Harness() {
        const [settings, setSettings] = useState<DotSettings>(current)
        return <SettingsPanel locale="zh" api={api as never} settings={settings} onSaved={setSettings} />
      }
    }
    const Harness = makeHarness()
    const root = createRoot(document.getElementById('root')!)
    await act(async () => root.render(<Harness />))
    await act(async () => { await Promise.resolve() })

    expect(document.body.textContent).toContain('待确认的修改')
    expect(document.body.textContent).toContain('less noise')
    const chips = [...document.querySelectorAll('.dsh-dot-proposal-chip')].map(node => node.textContent)
    expect(chips).toEqual(['所有会话', '仅她跟进的任务'])

    const lock = document.querySelector<HTMLButtonElement>('button[aria-label="禁止桃乐丝修改：桃乐丝的模型"]')!
    expect(lock.getAttribute('title')).toContain('允许她提议修改')
    await act(async () => lock.click())
    expect(current.locks).toEqual({ model: true })
    const unlock = document.querySelector<HTMLButtonElement>('button[aria-label="允许桃乐丝申请修改：桃乐丝的模型"]')!
    expect(unlock.hasAttribute('data-locked')).toBe(true)
    expect(unlock.getAttribute('title')).toContain('已锁定')

    await act(async () => document.querySelector<HTMLButtonElement>('.dsh-dot-proposal button')!.click())
    expect(decisions).toEqual([{ id: 'setting-1', allow: true }])

    expect(document.body.textContent).not.toContain('默认任务权限')
    const tabLabels = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].map(node => node.textContent)
    expect(tabLabels).toEqual(expect.arrayContaining(['桃乐丝管', '我来管', '一律拒绝']))
    // The blanket allow mode is gone; the task permission is its own field.
    expect(tabLabels).not.toContain('一律允许')
    expect(tabLabels).toEqual(expect.arrayContaining(['工作区写入', '完全访问']))

    const fullAccessTab = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(node => node.textContent === '完全访问')!
    await act(async () => fullAccessTab.click())
    expect(current.taskPermission).toBe('danger-full-access')

    // The reflection switch is a direct on/off Switch control, not a model proposal.
    const reflectionSwitch = document.querySelector<HTMLButtonElement>('button[role="switch"][aria-label="后台反思"]')!
    await act(async () => reflectionSwitch.click())
    expect(current.reflection).toBe(false)

    const allowTab = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(node => node.textContent === '仅允许所选')!
    await act(async () => allowTab.click())
    expect(current.taskModels.mode).toBe('allow')
    expect(document.body.textContent).toContain('尚未勾选任何模型')

    const filterInput = document.querySelector<HTMLInputElement>('input[aria-label="筛选模型…"]')!
    await act(async () => { changeValue(filterInput, 'DeepSeek') })
    const checkboxes = [...document.querySelectorAll<HTMLInputElement>('.dsh-dot-model-list input[type="checkbox"]')]
    expect(checkboxes.length).toBe(1)
    await act(async () => checkboxes[0]!.click())
    expect(current.taskModels.list).toEqual(['deepseek/deepseek-chat'])

    await act(async () => root.unmount())
  })

  it('edits, discards and saves the persona, and keeps agreements and cognition apart', async () => {
    let current: DotSettings = { ...DEFAULT_SETTINGS }
    const flagged = (entries: readonly CognitionEntry[]) => cognitionWithActive(entries, 2)
    let seq = 1
    let knowledge = {
      agreements: { entries: [{ id: 'a1', text: '先给结论', createdAt: 1, updatedAt: 1 }], canUndo: true },
      cognition: {
        entries: flagged([
          { id: 'c2', text: '一条休眠认知。', createdAt: 1, updatedAt: 1, seenAt: 1 },
          { id: 'c3', text: '共享的梗。', createdAt: 2, updatedAt: 2, seenAt: 2 },
          { id: 'c1', text: '他偏好先看结论。', createdAt: 3, updatedAt: 3, seenAt: 3 },
        ]),
        history: [{ entries: [{ id: 'c9', text: '旧的一版。', createdAt: 1, updatedAt: 1, seenAt: 1 }], at: 1_700_000_000_000 }],
      },
    }
    const restores: number[] = []
    const agreementEdits: KnowledgeEdit[] = []
    const cognitionEdits: KnowledgeEdit[] = []
    function Harness() {
      const [settings, setSettings] = useState<DotSettings>(current)
      const api = {
        setSettings: async (patch: Record<string, unknown>) => {
          current = {
            ...current,
            ...(patch.persona === null ? { persona: undefined } : patch.persona !== undefined ? { persona: String(patch.persona) } : {}),
            ...(patch.address === null ? { address: undefined } : patch.address !== undefined ? { address: String(patch.address) } : {}),
            ...(patch.locks !== undefined ? { locks: patch.locks as DotSettings['locks'] } : {}),
          }
          setSettings(current)
          return current
        },
        knowledge: async () => knowledge,
        editAgreements: async (edit: KnowledgeEdit) => {
          agreementEdits.push(edit)
          knowledge = { ...knowledge, agreements: { entries: applyAgreementEdit(knowledge.agreements.entries, edit, 9, () => `a${++seq}`), canUndo: true } }
          return knowledge
        },
        undoAgreements: async () => {
          knowledge = { ...knowledge, agreements: { entries: [], canUndo: false } }
          return knowledge
        },
        editCognition: async (edit: KnowledgeEdit) => {
          cognitionEdits.push(edit)
          knowledge = { ...knowledge, cognition: { ...knowledge.cognition, entries: flagged(applyCognitionEdit(knowledge.cognition.entries, edit, 9, () => `c${++seq}`)) } }
          return knowledge
        },
        restoreCognition: async (at: number) => {
          restores.push(at)
          const hit = knowledge.cognition.history.find(item => item.at === at)
          knowledge = { ...knowledge, cognition: { ...knowledge.cognition, entries: flagged(hit?.entries ?? []) } }
          return knowledge
        },
      }
      return <PersonaPanel locale="zh" api={api} settings={settings} onSaved={setSettings} />
    }
    const root = createRoot(document.getElementById('root')!)
    await act(async () => root.render(<Harness />))
    await act(async () => { await Promise.resolve() })

    const personaBox = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="性格与说话方式"]')!
    await act(async () => { changeValue(personaBox, '沉稳干练') })
    const buttons = () => [...document.querySelectorAll<HTMLButtonElement>('button')]
    await act(async () => buttons().find(btn => btn.textContent === '放弃改动')!.click())
    expect(personaBox.value).not.toBe('沉稳干练')

    await act(async () => { changeValue(personaBox, '沉稳干练') })
    await act(async () => buttons().find(btn => btn.textContent === '保存修改')!.click())
    expect(current.persona).toBe('沉稳干练')
    expect(document.body.textContent).toContain('已自定义')

    await act(async () => buttons().filter(btn => btn.textContent === '恢复默认')[1]!.click())
    expect(current.persona).toBeUndefined()

    // The two knowledge lists render their entries separately.
    const sections = [...document.querySelectorAll<HTMLElement>('.dsh-dot-pane-section')]
    const agreementsSection = sections[1]!
    const cognitionSection = sections[2]!
    expect(agreementsSection.textContent).toContain('先给结论')
    expect(cognitionSection.textContent).toContain('他偏好先看结论。')
    expect(document.body.textContent).toContain('与认知冲突时，一律以约定为准')
    // A dormant entry is muted and tagged, and the list explains what dormant means.
    const dormant = cognitionSection.querySelector<HTMLElement>('.dsh-dot-entry[data-dormant]')!
    expect(dormant.textContent).toContain('一条休眠认知。')
    expect(dormant.textContent).toContain('休眠')
    expect(cognitionSection.textContent).toContain('休眠条目当前不出现在桃乐丝的提示词里')

    // The agreements keep a lock toggle, so an existing lock can be lifted here.
    const lock = document.querySelector<HTMLButtonElement>('button[aria-label="禁止桃乐丝修改：约定"]')!
    await act(async () => lock.click())
    expect(current.locks).toEqual({ agreements: true })
    const unlock = document.querySelector<HTMLButtonElement>('button[aria-label="允许桃乐丝申请修改：约定"]')!
    expect(unlock.hasAttribute('data-locked')).toBe(true)

    // Adding an agreement entry calls the agreements edit endpoint only.
    const addInput = agreementsSection.querySelector<HTMLInputElement>('input[aria-label="添加"]')!
    await act(async () => { changeValue(addInput, '少说废话') })
    await act(async () => [...agreementsSection.querySelectorAll<HTMLButtonElement>('button')].find(btn => btn.textContent === '添加')!.click())
    expect(agreementEdits).toEqual([{ op: 'add', text: '少说废话' }])
    expect(agreementsSection.textContent).toContain('少说废话')
    expect(cognitionEdits).toEqual([])

    // Inline edit on a cognition row sends an edit op for that entry.
    const jokeRow = [...cognitionSection.querySelectorAll<HTMLElement>('.dsh-dot-entry')].find(row => row.textContent?.includes('共享的梗。'))!
    await act(async () => [...jokeRow.querySelectorAll<HTMLButtonElement>('button')].find(btn => btn.textContent === '编辑')!.click())
    const editor = jokeRow.querySelector<HTMLTextAreaElement>('textarea[aria-label="编辑"]')!
    await act(async () => { changeValue(editor, '共享的新梗。') })
    await act(async () => [...jokeRow.querySelectorAll<HTMLButtonElement>('button')].find(btn => btn.textContent === '保存修改')!.click())
    expect(cognitionEdits).toEqual([{ op: 'edit', id: 'c3', text: '共享的新梗。' }])
    expect(cognitionSection.textContent).toContain('共享的新梗。')

    // Pinning a cognition row sends a pin op; the row then offers unpin and carries a pinned tag.
    const pinRow = [...cognitionSection.querySelectorAll<HTMLElement>('.dsh-dot-entry')].find(row => row.textContent?.includes('他偏好先看结论。'))!
    await act(async () => [...pinRow.querySelectorAll<HTMLButtonElement>('button')].find(btn => btn.textContent === '置顶')!.click())
    expect(cognitionEdits[1]).toEqual({ op: 'pin', id: 'c1', pinned: true })
    expect(pinRow.textContent).toContain('取消置顶')
    expect(pinRow.textContent).toContain('已置顶')

    // Deleting an agreement row sends a remove op.
    const newRow = [...agreementsSection.querySelectorAll<HTMLElement>('.dsh-dot-entry')].find(row => row.textContent?.includes('少说废话'))!
    await act(async () => [...newRow.querySelectorAll<HTMLButtonElement>('button')].find(btn => btn.textContent === '删除')!.click())
    expect(agreementEdits[1]).toEqual({ op: 'remove', id: 'a2' })
    expect(agreementsSection.textContent).not.toContain('少说废话')

    // One step of undo on the agreements.
    await act(async () => buttons().find(btn => btn.textContent === '回退上次保存')!.click())
    expect(knowledge.agreements.entries).toEqual([])

    // The cognition history previews a version's entries and restores by timestamp.
    expect(document.body.textContent).toContain('历史版本')
    expect(document.body.textContent).toContain('- 旧的一版。')
    await act(async () => buttons().find(btn => btn.textContent === '回到这一版')!.click())
    expect(restores).toEqual([1_700_000_000_000])
    expect(knowledge.cognition.entries.map(entry => entry.text)).toEqual(['旧的一版。'])

    await act(async () => root.unmount())
  })

  it('switches directly from the context page and reports a refusal', async () => {
    const root = createRoot(document.getElementById('root')!)
    let view = {
      live: true,
      compactions: 0,
      contextWindow: 1_000_000,
      rolloverAt: 700_000,
      compactAt: 900_000,
      breakdown: { system: 1_200, tools: 1_800, messages: 400 },
      surface: {
        nodes: [{ id: 'pre:system:0', seq: 0, at: 0, category: 'system' as const, name: 'dsh-dot:persona', tokens: 1_200, text: 'Persona' }],
        parts: { system: 1_200, tools: 1_800, user: 0, inject: 400, skill: 0, assistant: 0, tool: 0 },
      },
      usage: { input: 2_000, cacheRead: 6_000, cacheWrite: 500, output: 1_500 },
      sections: {
        persona: '[persona] 你是桃乐丝',
        agreements: '[agreements]\n- 推送到个人仓库可直接放行',
        cognition: '[cognition]\n他偏好先看结论。',
        handoff: '[handoff] 上文已交接',
      },
    }
    const api = {
      context: vi.fn(async () => view),
      newSegment: vi.fn(async () => { throw new Error('stop the current turn first') }),
      clearUsage: vi.fn(async () => {
        view = { ...view, usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 } }
        return view
      }),
    }
    await act(async () => root.render(<ContextPanel locale="zh" api={api} />))
    await act(async () => { await Promise.resolve() })
    expect(document.body.textContent).toContain('3.4K')
    expect(document.body.textContent).toContain('提示词明细')
    expect(document.body.textContent).toContain('10K')

    // The frozen prompt blocks of this segment are shown as their own zones.
    expect(document.body.textContent).toContain('提示词分区')
    expect(document.body.textContent).toContain('约定')
    expect(document.body.textContent).toContain('认知')
    expect(document.body.textContent).toContain('- 推送到个人仓库可直接放行')
    expect(document.body.textContent).toContain('他偏好先看结论。')
    const zones = [...document.querySelectorAll('.dsh-dot-ctx-section-row > dt')].map(node => node.textContent)
    expect(zones).toEqual(['人设', '约定', '认知', '交接'])

    const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === '开启新分段')!
    await act(async () => button.click())
    expect(api.newSegment).toHaveBeenCalledOnce()
    expect(document.body.textContent).toContain('stop the current turn first')

    const clearButton = [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === '清零')!
    expect(clearButton.disabled).toBe(false)
    await act(async () => clearButton.click())
    expect(api.clearUsage).toHaveBeenCalledOnce()
    expect(clearButton.disabled).toBe(true)
    await act(async () => root.unmount())
  })

  it('renders localized tool names and localized turn end states in trajectory view', async () => {
    const root = createRoot(document.getElementById('root')!)
    const api = {
      trajectory: async () => ({
        earlier: 0,
        turns: [{
          turn: 1,
          startedAt: 1_700_000_000_000,
          endedAt: 1_700_000_001_500,
          end: 'cancelled',
          records: [],
          steps: [{
            step: 1,
            model: 'deepseek-chat',
            startedAt: 1_700_000_000_000,
            durationMs: 1200,
            records: [{
              kind: 'call' as const,
              id: 'call-1',
              name: 'dot_overview',
              args: '{}',
              result: '{"ok":true}',
              status: 'done' as const,
              at: 1_700_000_000_100,
              endedAt: 1_700_000_000_400,
            }],
          }],
        }],
      }),
      reflectionRuns: async () => [],
      reflectionTrajectory: async () => ({ earlier: 0, turns: [] }),
    }
    await act(async () => root.render(<TrajectoryPanel locale="zh" api={api} running={false} />))
    await act(async () => { await Promise.resolve() })

    expect(document.body.textContent).toContain('查看全局 · dot_overview')
    expect(document.body.textContent).toContain('结束：已停止')
    const recHead = document.querySelector<HTMLButtonElement>('.dsh-dot-tr-recordhead')!
    await act(async () => recHead.click())
    expect(document.querySelectorAll('.dsh-dot-tr-copy').length).toBeGreaterThanOrEqual(2)
    await act(async () => root.unmount())
  })

  it('lists reflection runs and opens an archived reflection trajectory', async () => {
    const root = createRoot(document.getElementById('root')!)
    const archived = {
      earlier: 0,
      turns: [{
        turn: 1,
        startedAt: 1_700_000_000_000,
        endedAt: 1_700_000_001_500,
        end: 'completed',
        records: [],
        steps: [{
          step: 1,
          model: 'deepseek-chat',
          startedAt: 1_700_000_000_000,
          durationMs: 1200,
          records: [{
            kind: 'call' as const,
            id: 'call-1',
            name: 'dot_read_history',
            args: '{}',
            result: '{"ok":true}',
            status: 'done' as const,
            at: 1_700_000_000_100,
            endedAt: 1_700_000_000_400,
          }],
        }],
      }],
    }
    const api = {
      trajectory: async () => ({ earlier: 0, turns: [] }),
      reflectionRuns: async () => [
        { sessionId: 'sess-1', startedAt: 1_700_000_000_000, endedAt: 1_700_000_001_000, ok: true },
        { sessionId: 'sess-2', startedAt: 1_700_000_100_000, endedAt: 1_700_000_101_000, ok: false },
      ],
      reflectionTrajectory: vi.fn(async () => archived),
    }
    await act(async () => root.render(<TrajectoryPanel locale="zh" api={api} running={false} />))
    await act(async () => { await Promise.resolve() })
    const toggle = document.querySelector<HTMLButtonElement>('.dsh-dot-tr-reflection-toggle')!
    expect(toggle.textContent).toBe('反思')
    await act(async () => toggle.click())
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(document.body.textContent).toContain('已更新')
    expect(document.body.textContent).toContain('失败')
    // Newest first: the failed pass leads the list.
    const rows = [...document.querySelectorAll<HTMLButtonElement>('.dsh-dot-tr-run')]
    expect(rows.length).toBe(2)
    await act(async () => rows[0]!.click())
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(api.reflectionTrajectory).toHaveBeenCalledWith('sess-2', expect.anything())
    expect(document.body.textContent).toContain('dot_read_history')
    await act(async () => root.unmount())
  })
})
