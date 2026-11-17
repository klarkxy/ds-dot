import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type UserConfig } from 'tsdown'

const wrapClient: NonNullable<UserConfig['plugins']>[number] = {
  name: 'wrap-dsh-client',
  // writeBundle runs after this config's files land. closeBundle also fires on
  // the host config in some tsdown runs, when client.inner is not there yet.
  writeBundle() {
    if (!existsSync('lib/client.inner.cjs') && !existsSync('lib/client.inner.js')) return
    const result = spawnSync(process.execPath, ['scripts/wrap-client.mjs', 'ds-dot'], { stdio: 'inherit' })
    if (result.status !== 0) throw new Error(`client wrap exited ${result.status ?? 'unknown'}`)
  },
}

const hostExternal = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/schemastery',
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-session-query',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-storage-domain',
  '@deepseek-ai/dsh-agent-preset-registry',
  '@deepseek-ai/dsh-user-approval',
  '@deepseek-ai/dsh-user-questions',
  '@deepseek-ai/dsh-web',
  '@deepseek-ai/dsh-tool-web',
  'zod',
  '@klarkxy/dsh-deep-view',
]

function deepViewBrowserFile(pkg: string, from: string, to: string): string | undefined {
  try {
    const widgetRequire = createRequire(fileURLToPath(import.meta.resolve('@klarkxy/dsh-deep-view/widget')))
    const resolved = widgetRequire.resolve(pkg)
    const browser = resolved.endsWith(from) ? resolved.slice(0, -from.length) + to : join(dirname(resolved), to)
    return existsSync(browser) ? browser : undefined
  } catch {
    return undefined
  }
}

const vegaCanvasBrowser = deepViewBrowserFile('vega-canvas', 'vega-canvas.node.js', 'vega-canvas.browser.js')
const vegaLoaderBrowser = deepViewBrowserFile('vega-loader', 'vega-loader.node.js', 'vega-loader.browser.js')

const richViewAlias: NonNullable<UserConfig['plugins']>[number] = {
  name: 'deep-view-browser-canvas',
  resolveId(id) {
    if (id === 'vega-canvas' && vegaCanvasBrowser) return vegaCanvasBrowser
    if (id === 'vega-loader' && vegaLoaderBrowser) return vegaLoaderBrowser
  },
}

export default defineConfig([
  {
    // Three host entries: the plugin itself, the preset row that carries dot's
    // tools, and the internal reflection preset's tool row.
    entry: { index: 'src/index.ts', tools: 'src/tools.ts', reflection: 'src/reflection.ts' },
    format: ['esm'],
    dts: true,
    clean: true,
    outDir: 'lib',
    platform: 'node',
    target: 'node22',
    sourcemap: true,
    hash: false,
    deps: {
      alwaysBundle: [
        '@klarkxy/dsh-plugin-kit/contracts',
        '@klarkxy/dsh-plugin-kit/domain',
        '@klarkxy/dsh-plugin-kit/host-rpc',
        '@klarkxy/dsh-plugin-kit/logger',
        '@klarkxy/dsh-plugin-kit/log-shared',
      ],
      neverBundle: hostExternal,
    },
    outExtensions: () => ({ dts: '.d.ts', js: '.js' }),
  },
  {
    entry: { 'client.inner': 'src/client.tsx' },
    format: ['cjs'],
    dts: false,
    clean: false,
    outDir: 'lib',
    platform: 'browser',
    target: 'es2022',
    sourcemap: true,
    hash: false,
    define: { 'process.env.NODE_ENV': '"production"' },
    outputOptions: options => ({ ...options, codeSplitting: false }),
    plugins: [richViewAlias, wrapClient],
    deps: {
      neverBundle: ['react', 'react/jsx-runtime', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
      alwaysBundle: [
        '@klarkxy/dsh-plugin-kit/official-ui',
        '@klarkxy/dsh-plugin-kit/model-menu',
        '@klarkxy/dsh-plugin-kit/model-picker',
        '@klarkxy/dsh-plugin-kit/client-logger',
        '@klarkxy/dsh-plugin-kit/log-shared',
        '@klarkxy/dsh-deep-view/widget',
        '@klarkxy/dsh-deep-view/core',
        '@klarkxy/dsh-deep-view/answers',
        '@klarkxy/dsh-deep-view/copy',
        '@klarkxy/dsh-deep-view/contracts',
        '@xyflow/react',
        'mafs',
        'maplibre-gl',
        'vega',
        'vega-embed',
        'vega-lite',
      ],
    },
    outExtensions: () => ({ dts: '.d.ts', js: '.cjs' }),
  },
])
