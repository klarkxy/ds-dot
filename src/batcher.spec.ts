import { describe, expect, it } from 'vitest'
import { NoticeBatcher, formatNoticeDisplay, formatNotices, type Notice, type Timer } from './batcher.ts'

function clock() {
  let now = 0, next = 0
  const tasks = new Map<number, { at: number; fn: () => void }>()
  const timer: Timer = { set: (fn, ms) => { const id = ++next; tasks.set(id, { at: now + ms, fn }); return id }, clear: id => { tasks.delete(id as number) }, now: () => now }
  const advance = (ms: number) => { now += ms; for (const [id, row] of [...tasks]) if (row.at <= now) { tasks.delete(id); row.fn() } }
  return { timer, advance }
}
const n = (id: string): Notice => ({ sessionId: id, kind: 'turn-end', text: id, at: 0 })

describe('idle notice queue', () => {
  it('holds running updates and delivers them together after idle', async () => {
    const c = clock(), batches: string[][] = []
    let idle = false
    const b = new NoticeBatcher(async items => { batches.push(items.map(item => item.sessionId)) }, { timer: c.timer, isIdle: () => idle })
    b.push(n('a')); b.hold(n('b')); c.advance(1500)
    expect(batches).toEqual([])
    idle = true; await b.drain()
    expect(batches).toEqual([['a', 'b']])
  })
  it('drops an approval settled during grace', async () => {
    const c = clock(), batches: Notice[][] = []
    const b = new NoticeBatcher(async items => { batches.push([...items]) }, { timer: c.timer, isIdle: () => true })
    b.push({ ...n('a'), kind: 'approval', requestId: 'ap-1' }, true, 10_000)
    c.advance(1500); await Promise.resolve(); b.dropWhere(item => item.requestId === 'ap-1'); c.advance(10_000)
    expect(batches).toEqual([])
  })
  it('holds routine notices until the threshold, and take carries unexpired approval', async () => {
    const c = clock(), batches: Notice[][] = []
    const b = new NoticeBatcher(async items => { batches.push([...items]) }, { timer: c.timer, isIdle: () => true, holdLimit: 2 })
    b.hold(n('a')); await b.drain(); expect(batches).toHaveLength(0)
    b.hold(n('b')); await b.drain(); expect(batches[0]).toHaveLength(2)
    b.push({ ...n('c'), kind: 'approval' }, true, 10_000); expect(b.take()).toHaveLength(1)
  })
  it('requeues failed delivery ahead of new items with a 60 second retry', async () => {
    const c = clock(), batches: string[][] = []
    let fail = true
    const b = new NoticeBatcher(async items => { batches.push(items.map(item => item.sessionId)); if (fail) { fail = false; throw Error('offline') } }, { timer: c.timer, isIdle: () => true })
    b.push(n('a')); await b.drain(); b.hold(n('b')); c.advance(60_000); await Promise.resolve()
    expect(batches).toEqual([['a'], ['a', 'b']])
  })
  it('does not let new arrivals or idle wake bypass the 60 second retry deadline', async () => {
    const c = clock(), calls: number[] = []
    let fail = true
    const b = new NoticeBatcher(async () => { calls.push(c.timer.now()); if (fail) { fail = false; throw Error('offline') } }, { timer: c.timer, isIdle: () => true })
    b.push(n('first')); await b.drain()
    c.advance(1000); b.push(n('second')); b.wake(); c.advance(1500); await Promise.resolve()
    expect(calls).toEqual([0])
    await b.drain(); expect(calls).toEqual([0])
    c.advance(57_500); await Promise.resolve()
    expect(calls).toEqual([0, 60_000])
  })
  it('orders request blocks and folds repeated task turns', () => {
    const text = formatNotices([{ ...n('s'), changeId: 't-1', text: 'old' }, { ...n('s'), changeId: 't-1', text: 'new' }, { ...n('x'), kind: 'approval', text: 'request' }], ['t-2 P3'])
    expect(text.indexOf('Requests waiting')).toBeLessThan(text.indexOf('Tasks:'))
    expect(text).not.toContain('old')
    expect(text).toContain('- turn-end · s: new')
    expect(text).toContain('Ready to start')
  })
  it('preserves display facts directly and folds the same completed turns as model text', () => {
    const display = { kind: 'approval' as const, sessionId: 'x', requestId: 'ap-1', subject: 'pwsh', command: 'unescaped \"command\"\nnext line' }
    const batch = [{ ...n('s'), changeId: 't-1', text: 'old' }, { ...n('s'), changeId: 't-1', text: 'new' }, { ...n('x'), kind: 'approval' as const, text: 'unrelated copy', display }]
    expect(formatNoticeDisplay(batch)).toEqual({ isReminder: false, entries: [{ kind: 'turn-end', sessionId: 's', summary: 'new' }, display] })
  })

  it('formats result notices under Tasks and maps display.kind result cleanly', () => {
    const resNotice: Notice = { sessionId: 'dot-1', kind: 'result', changeId: 'chg-1', text: 'PR acme/widgets#1 merged', at: 10 }
    const formatted = formatNotices([resNotice])
    expect(formatted).toContain('Tasks:\n- result · dot-1: PR acme/widgets#1 merged')
    expect(formatNoticeDisplay([resNotice]).entries[0]).toMatchObject({ kind: 'result', sessionId: 'dot-1', summary: 'PR acme/widgets#1 merged' })
  })

})
