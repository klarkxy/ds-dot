import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function pythonBin(): string {
  for (const bin of ['python3', 'python']) {
    try {
      execFileSync(bin, ['-c', 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)'], { stdio: 'ignore' })
      return bin
    } catch {
      continue
    }
  }
  throw new Error('python3 is required for Arena builder tests')
}

describe('Arena builder script', () => {
  it('keeps dated identities, isolates the download cache, and avoids pandas', () => {
    execFileSync(pythonBin(), [join(root, 'scripts/test_build_model_arena.py')], { cwd: root, encoding: 'utf8' })
  })
})
