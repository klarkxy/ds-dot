import { execFile } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, it } from 'vitest'

const execFileAsync = promisify(execFile)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')

async function pythonBin(): Promise<string> {
  // On Windows, actions/setup-python puts Python 3.x at `python` while
  // WindowsApps may hold a stub `python3` alias; try `python` first there.
  const candidates = process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python']
  for (const bin of candidates) {
    try {
      await execFileAsync(bin, ['-c', 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)'], { windowsHide: true, timeout: 15_000 })
      return bin
    } catch {
      continue
    }
  }
  throw new Error('python3 is required for Arena builder tests')
}

describe('Arena builder script', () => {
  it('keeps dated identities, isolates the download cache, and avoids pandas', async () => {
    await execFileAsync(await pythonBin(), [join(root, 'scripts/test_build_model_arena.py')], { cwd: root, encoding: 'utf8', windowsHide: true })
  }, 30_000)
})
