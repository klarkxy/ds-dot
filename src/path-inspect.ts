/** Shared lexical path helpers for read-only inspection. */
import { posix, win32 } from 'node:path'

/** Strip a Windows long-path prefix so relative() compares the same volume. */
export function withoutNamespace(path: string): string {
  if (path.startsWith('\\\\?\\UNC\\')) return `\\\\${path.slice(8)}`
  if (path.startsWith('\\\\?\\')) return path.slice(4)
  return path
}

export function pathInsideRoot(root: string, target: string, platform: NodeJS.Platform = process.platform): boolean {
  const api = platform === 'win32' ? win32 : posix
  const rel = api.relative(withoutNamespace(api.resolve(root)), withoutNamespace(api.resolve(target)))
  return rel === '' || (!rel.startsWith('..') && !api.isAbsolute(rel))
}
