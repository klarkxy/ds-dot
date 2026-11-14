import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const root = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  plugins: [{
    name: 'css-as-text',
    enforce: 'pre',
    load(id) {
      const file = id.split('?')[0]
      if (!file?.endsWith('.css')) return null
      return 'export default ' + JSON.stringify(readFileSync(file, 'utf8'))
    },
    transform(_code, id) {
      const file = id.split('?')[0]
      if (!file?.endsWith('.css')) return null
      return 'export default ' + JSON.stringify(readFileSync(file, 'utf8'))
    },
  }],
  resolve: {
    alias: {
      '@deepseek-ai/dsh-client-ui-primitives': root + 'scripts/ui-primitives-stub.tsx',
    },
  },
  test: {
    watch: false,
    maxWorkers: 2,
    include: ['src/**/*.spec.ts', 'src/**/*.spec.tsx'],
  },
})
