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
      // Linked Deep View lives in another workspace; pin React so WidgetCard
      // and the spec share one copy.
      react: root + 'node_modules/react',
      'react-dom': root + 'node_modules/react-dom',
      'react/jsx-runtime': root + 'node_modules/react/jsx-runtime.js',
      'react/jsx-dev-runtime': root + 'node_modules/react/jsx-dev-runtime.js',
    },
    dedupe: ['react', 'react-dom'],
  },
  test: {
    watch: false,
    maxWorkers: 2,
    include: ['src/**/*.spec.ts', 'src/**/*.spec.tsx'],
    // plugin-kit/model-picker imports the real primitives; inline it so the
    // stub alias above still wins inside that package. Deep View is linked
    // from another workspace and must see the same React as the spec.
    server: { deps: { inline: ['@klarkxy/dsh-plugin-kit', '@klarkxy/dsh-deep-view'] } },
  },
})
