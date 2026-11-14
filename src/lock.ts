import path from 'node:path'
import type { Ticket } from './contracts.ts'

/** Compare directory boundaries using the platform's path semantics. */
export function directoriesConflict(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  const api = platform === 'win32' ? path.win32 : path.posix
  const normalize = (value: string) => {
    const resolved = api.resolve(value)
    const root = api.parse(resolved).root
    const trimmed = resolved === root ? root : resolved.replace(/[\\/]+$/, '')
    return platform === 'win32' ? trimmed.toLowerCase() : trimmed
  }
  const first = normalize(a)
  const second = normalize(b)
  const contains = (parent: string, child: string) => {
    const relative = api.relative(parent, child)
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${api.sep}`) && !api.isAbsolute(relative))
  }
  return contains(first, second) || contains(second, first)
}

export function lockHolders(tickets: Iterable<Ticket>, dir: string, exceptId?: string, platform: NodeJS.Platform = process.platform): Ticket[] {
  return [...tickets].filter(ticket => ticket.id !== exceptId && ticket.access === 'write' && (ticket.status === 'active' || ticket.status === 'review') && directoriesConflict(ticket.dir, dir, platform))
}
