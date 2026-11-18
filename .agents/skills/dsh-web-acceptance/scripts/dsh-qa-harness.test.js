import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

import {
  assertOutsideCheckouts,
  buildIsolatedEnv,
  cleanBaseUrl,
  gitToplevel,
  isInsideDir,
  isPluginOrApiUrl,
  launchUrlForCookieExchange,
  parseArgs,
  pickFreePort,
  prepareBrowserEnv,
  quoteWindowsCmdArg,
  recordingStorageState,
  redactForLog,
  releaseIsolatedHome,
  removeIsolatedHome,
  resolveArtifactPath,
  runIsolatedAcceptance,
  selectLaunchUrl,
  terminateProcessTree,
  urlHasLaunchToken,
  waitForDshReady,
} from './dsh-qa-harness.js'

function parsePackOutput(stdout) {
  const lines = stdout.split(/\n/)
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() !== '[') continue
    try {
      const value = JSON.parse(lines.slice(i).join('\n'))
      if (Array.isArray(value) && value.some(entry => Array.isArray(entry?.files))) return value
    } catch {
      // Build logs can contain other brackets.
    }
  }
  throw new Error('npm pack did not print a file list')
}

const repoRoot = path.resolve(import.meta.dirname, '../../../..')
const skillRoot = path.resolve(import.meta.dirname, '..')

function gitEnv(dir) {
  const blank = path.join(dir, 'blank-gitconfig')
  return {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: blank,
    GIT_CONFIG_SYSTEM: blank,
  }
}

async function forceKill(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  await terminateProcessTree(child, 200)
  if (child.exitCode !== null || child.signalCode !== null) return
  if (!child.pid) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  } else {
    try { process.kill(-child.pid, 'SIGKILL') } catch { try { child.kill('SIGKILL') } catch { /* gone */ } }
  }
}

test('importing the harness does not start a run', () => {
  assert.equal(typeof runIsolatedAcceptance, 'function')
})

test('node --check accepts the harness', () => {
  const res = spawnSync(process.execPath, ['--check', path.join(import.meta.dirname, 'dsh-qa-harness.js')], {
    encoding: 'utf8',
  })
  assert.equal(res.status, 0, res.stderr)
})

test('parseArgs defaults, repeats, and rejects unsafe values', () => {
  const opts = parseArgs([
    '--plugin', '.',
    '--gif-name', 'demo.gif',
    '--viewport', '800x600',
    '--allow-env', 'OPENAI_API_KEY',
    '--allow-env', 'ANTHROPIC_API_KEY',
  ])
  assert.equal(opts.recordGif, true)
  assert.equal(opts.gifName, 'demo.gif')
  assert.equal(opts.viewportWidth, 800)
  assert.equal(opts.viewportHeight, 600)
  assert.deepEqual(opts.allowEnv, ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'])
  assert.equal(opts.pluginDirs[0], path.resolve('.'))
  assert.equal(parseArgs(['--help']).help, true)
  assert.equal(parseArgs([]).outDir.startsWith(os.tmpdir()), true)
  assert.throws(() => parseArgs(['--nope']), /Unknown option/)
  assert.throws(() => parseArgs(['--gif-fps']), /Missing value/)
  assert.throws(() => parseArgs(['--gif-fps', '0']), /gif-fps/)
  assert.throws(() => parseArgs(['--gif-fps', '12;id']), /gif-fps/)
  assert.throws(() => parseArgs(['--color-scheme', 'blue']), /color-scheme/)
  assert.throws(() => parseArgs(['--viewport', 'wide']), /viewport/)
  assert.throws(() => parseArgs(['--profile', '--help']), /profile/)
})

test('buildIsolatedEnv drops real homes and secret-shaped variables', () => {
  const temp = path.join(os.tmpdir(), 'dsh-qa-isolated-home')
  const source = {
    PATH: '/usr/bin',
    HOME: '/home/maintainer',
    DEEPSEEK_API_KEY: 'sk-real',
    AZURE_OPENAI_API_KEY: 'azure-secret',
    AWS_SECRET_ACCESS_KEY: 'aws-secret',
    NPM_TOKEN: 'npm-secret',
    GITHUB_TOKEN: 'gh-secret',
    SESSION_COOKIE: 'cookie-secret',
    DSH_HOME: '/home/maintainer/.dsh',
    dsh_agents_home: '/home/maintainer/.agents',
    DSH_WEB_URL: 'http://127.0.0.1:3080/',
    HARMLESS: 'ok',
  }
  const env = buildIsolatedEnv(temp, ['AZURE_OPENAI_API_KEY'], source)
  assert.equal(env.DSH_HOME, temp)
  assert.equal(env.DSH_AGENTS_HOME, path.join(temp, 'agents-home'))
  assert.equal(isInsideDir(temp, env.DSH_AGENTS_HOME), true)
  assert.equal(env.DSH_TELEMETRY_DISABLED, '1')
  assert.equal(env.DSH_TELEMETRY_MODE, 'DISABLED')
  assert.equal(env.AZURE_OPENAI_API_KEY, 'azure-secret')
  assert.equal(env.HARMLESS, 'ok')
  assert.equal(env.PATH, '/usr/bin')
  assert.equal(env.HOME, '/home/maintainer')
  for (const key of [
    'DEEPSEEK_API_KEY',
    'AWS_SECRET_ACCESS_KEY',
    'NPM_TOKEN',
    'GITHUB_TOKEN',
    'SESSION_COOKIE',
    'DSH_WEB_URL',
    'dsh_agents_home',
  ]) {
    assert.equal(Object.hasOwn(env, key), false, key)
  }
  const serialized = JSON.stringify(env)
  assert.equal(serialized.includes('sk-real'), false)
  assert.equal(serialized.includes('aws-secret'), false)
  assert.equal(serialized.includes('npm-secret'), false)
  assert.equal(serialized.includes('gh-secret'), false)
  assert.equal(serialized.includes('cookie-secret'), false)
  assert.equal(serialized.includes('/home/maintainer/.dsh'), false)
  assert.throws(() => buildIsolatedEnv(temp, ['DSH_HOME'], source), /isolated DSH homes/)
})

test('redactForLog hides launch tokens, auth cookies, and a home directory', () => {
  const text = redactForLog(
    'open http://localhost:4123/?token=launch-secret token=bare-secret dsh-auth-abc=signed-cookie at /home/maintainer/.dsh',
    '/home/maintainer',
  )
  assert.match(text, /token=<REDACTED>/)
  assert.match(text, /dsh-auth-abc=<REDACTED>/)
  assert.match(text, /<HOME>\/\.dsh/)
  assert.equal(text.includes('launch-secret'), false)
  assert.equal(text.includes('bare-secret'), false)
  assert.equal(text.includes('signed-cookie'), false)
  assert.equal(text.includes('maintainer'), false)
})

test('launch URLs must be the loopback listener and are rewritten to localhost', () => {
  assert.equal(
    launchUrlForCookieExchange('http://127.0.0.1:4123/?token=abc-def_ghi).', 4123),
    'http://localhost:4123/?token=abc-def_ghi',
  )
  assert.equal(
    launchUrlForCookieExchange('http://[::1]:4123/?token=abc', 4123),
    'http://localhost:4123/?token=abc',
  )
  assert.equal(cleanBaseUrl('http://localhost:4123/?token=abc'), 'http://localhost:4123/')
  assert.equal(urlHasLaunchToken('http://localhost:4123/?token=abc'), true)
  assert.equal(urlHasLaunchToken('http://localhost:4123/'), false)

  const output = [
    'dsh web: listening on 127.0.0.1 over plain HTTP',
    'dsh web: http://evil.test/?token=nope',
    'dsh web: http://127.0.0.1:9/?token=other',
    'dsh web: http://127.0.0.1:4123/?token=good',
  ].join('\n')
  assert.equal(selectLaunchUrl(output, 4123), 'http://localhost:4123/?token=good')

  assert.throws(() => launchUrlForCookieExchange('http://evil.test/?token=supersecret', 80), err => {
    assert.match(err.message, /loopback/)
    assert.equal(err.message.includes('supersecret'), false)
    return true
  })
  assert.throws(() => launchUrlForCookieExchange('http://user:s3cret@localhost:4123/?token=abc', 4123), err => {
    assert.match(err.message, /credentials/)
    assert.equal(err.message.includes('s3cret'), false)
    return true
  })
  assert.throws(() => launchUrlForCookieExchange('http://localhost:4123/', 4123), /missing token/)
  assert.throws(() => launchUrlForCookieExchange('http://localhost:9/?token=abc', 4123), err => {
    assert.match(err.message, /port/)
    assert.equal(err.message.includes('abc'), false)
    return true
  })
})

test('recording state keeps only the HttpOnly dsh auth cookie', () => {
  const state = recordingStorageState({
    cookies: [
      { name: 'dsh-auth-abc', value: 'signed', httpOnly: true, domain: 'localhost', path: '/' },
      { name: 'dsh-auth-js', value: 'visible', httpOnly: false },
      { name: 'other', value: 'x', httpOnly: true },
    ],
    origins: [{ origin: 'http://localhost:4123', localStorage: [{ name: 'token', value: 'secret' }] }],
  })
  assert.equal(state.cookies.length, 1)
  assert.equal(state.cookies[0].name, 'dsh-auth-abc')
  assert.equal(state.cookies[0].httpOnly, true)
  assert.deepEqual(state.origins, [])
  assert.throws(() => recordingStorageState({ cookies: [], origins: [] }), /HttpOnly dsh-auth/)
})

test('api and plugin failures ignore unrelated URLs', () => {
  assert.equal(isPluginOrApiUrl('http://localhost/api/host.describe'), true)
  assert.equal(isPluginOrApiUrl('http://localhost/plugins/ds-dot/client.js'), true)
  assert.equal(isPluginOrApiUrl('http://localhost/ok?next=/api/secret'), false)
  assert.equal(isPluginOrApiUrl('http://localhost/not-plugins'), false)
})

test('artifact paths cannot escape the output directory or enter a checkout', () => {
  assert.equal(isInsideDir('/repo', '/repo'), true)
  assert.equal(isInsideDir('/repo', '/repo/src/a.png'), true)
  assert.equal(isInsideDir('/repo', '/tmp/a.png'), false)
  assert.equal(isInsideDir('/repo', '/repo-other/a.png'), false)
  assert.equal(resolveArtifactPath('/tmp/out', 'a.png', []), path.resolve('/tmp/out/a.png'))
  assert.throws(() => resolveArtifactPath('/tmp/out', '../secret.png', []), /escapes/)
  assert.throws(() => resolveArtifactPath('/tmp/out', '/repo/shot.png', ['/repo']), /git checkout/)
  assert.equal(resolveArtifactPath('/tmp/out', '/tmp/shot.png', ['/repo']), path.resolve('/tmp/shot.png'))
})

test('quoteWindowsCmdArg quotes cmd metacharacters', () => {
  assert.equal(quoteWindowsCmdArg('dsh'), 'dsh')
  assert.equal(quoteWindowsCmdArg(''), '""')
  assert.equal(quoteWindowsCmdArg('C:\\Program Files\\plugin'), '"C:\\Program Files\\plugin"')
  assert.equal(quoteWindowsCmdArg('a&b'), '"a&b"')
  assert.equal(quoteWindowsCmdArg('%PATH%'), '"%%PATH%%"')
})

test('prepareBrowserEnv drops Playwright debug switches', () => {
  const prevDebug = process.env.DEBUG
  const prevPw = process.env.PWDEBUG
  process.env.DEBUG = 'pw:api'
  process.env.PWDEBUG = '1'
  try {
    prepareBrowserEnv()
    assert.equal(process.env.DEBUG, undefined)
    assert.equal(process.env.PWDEBUG, undefined)
  } finally {
    if (prevDebug === undefined) delete process.env.DEBUG
    else process.env.DEBUG = prevDebug
    if (prevPw === undefined) delete process.env.PWDEBUG
    else process.env.PWDEBUG = prevPw
  }
})

test('checkout guard uses the git toplevel', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-qa-git-'))
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-qa-out-'))
  try {
    const init = spawnSync('git', ['init'], { cwd: dir, env: gitEnv(dir), encoding: 'utf8' })
    assert.equal(init.status, 0, init.stderr)
    const root = gitToplevel(dir)
    assert.ok(root)
    assert.throws(() => assertOutsideCheckouts(path.join(root, 'shot.png'), [root]), /git checkout/)
    assert.doesNotThrow(() => assertOutsideCheckouts(path.join(outside, 'shot.png'), [root]))
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
    await fs.rm(outside, { recursive: true, force: true })
  }
})

test('startup timeout kills the child and removes the temporary home', async () => {
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-qa-out-'))
  const script = path.join(out, 'fake-dsh.mjs')
  await fs.writeFile(script, "console.log('token=supersecret')\nsetInterval(() => {}, 1000)\n")
  const before = new Set((await fs.readdir(os.tmpdir())).filter(name => name.startsWith('dsh-qa-home-')))
  try {
    const opts = parseArgs([
      '--cwd', out,
      '--out-dir', out,
      '--boot-timeout-ms', '500',
      '--dsh-cmd', `${process.execPath} ${script}`,
    ])
    await assert.rejects(() => runIsolatedAcceptance(opts), err => {
      assert.match(err.message, /timed out|launch URL/i)
      assert.equal(err.message.includes('supersecret'), false)
      return true
    })
    const leaked = (await fs.readdir(os.tmpdir())).filter(name => name.startsWith('dsh-qa-home-') && !before.has(name))
    assert.deepEqual(leaked, [])
  } finally {
    await fs.rm(out, { recursive: true, force: true })
  }
})

test('refuses an in-checkout output directory before starting dsh', async () => {
  const opts = parseArgs(['--cwd', repoRoot, '--out-dir', repoRoot, '--boot-timeout-ms', '500'])
  await assert.rejects(() => runIsolatedAcceptance(opts), /git checkout/)
})

test('removeIsolatedHome waits for a confirmed exit', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-qa-home-'))
  await fs.writeFile(path.join(dir, 'marker'), 'x')
  assert.equal(await removeIsolatedHome(dir, { exited: false, keep: false }), false)
  assert.equal(existsSync(path.join(dir, 'marker')), true)
  assert.equal(await removeIsolatedHome(dir, { exited: true, keep: true }), false)
  assert.equal(existsSync(dir), true)
  assert.equal(await removeIsolatedHome(dir, { exited: true, keep: false }), true)
  assert.equal(existsSync(dir), false)
})

test('terminateProcessTree stops a detached process', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: 'ignore',
  })
  try {
    assert.equal(await terminateProcessTree(child, 300), true)
  } finally {
    await forceKill(child)
  }
})

test('terminateProcessTree escalates when SIGTERM is ignored', { skip: process.platform === 'win32' }, async () => {
  const child = spawn(process.execPath, ['-e', `
    process.on('SIGTERM', () => {})
    console.log('ready')
    setInterval(() => {}, 1000)
  `], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('child did not become ready')), 3000)
      child.stdout.on('data', chunk => {
        if (!String(chunk).includes('ready')) return
        clearTimeout(timer)
        resolve()
      })
      child.once('exit', code => {
        clearTimeout(timer)
        reject(new Error(`child exited before ready (${code})`))
      })
    })
    const started = Date.now()
    assert.equal(await terminateProcessTree(child, 200), true)
    assert.ok(Date.now() - started >= 150)
    assert.ok(child.exitCode !== null || child.signalCode !== null)
  } finally {
    await forceKill(child)
  }
})

test('releaseIsolatedHome deletes the home only after the process exits', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-qa-home-'))
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: 'ignore',
  })
  try {
    const released = await releaseIsolatedHome(dir, child, { keep: false, graceMs: 300 })
    assert.equal(released.exited, true)
    assert.equal(released.removed, true)
    assert.equal(existsSync(dir), false)
  } finally {
    await forceKill(child)
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('waitForDshReady rewrites a loopback launch URL', async () => {
  const child = spawn(process.execPath, ['-e', [
    "console.log('noise token=supersecret')",
    "console.log('dsh web: http://127.0.0.1:4123/?token=launch-secret')",
    'setInterval(() => {}, 1000)',
  ].join('\n')], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  try {
    const url = await waitForDshReady(child, { port: 4123, bootTimeoutMs: 3000 })
    assert.equal(url, 'http://localhost:4123/?token=launch-secret')
  } finally {
    await forceKill(child)
  }
})

test('waitForDshReady redacts tokens when startup fails', async () => {
  const child = spawn(process.execPath, ['-e', [
    "console.log('dsh web: http://evil.test/?token=supersecret')",
    'setInterval(() => {}, 1000)',
  ].join('\n')], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  try {
    await assert.rejects(
      () => waitForDshReady(child, { port: 4123, bootTimeoutMs: 1500 }),
      err => {
        assert.match(err.message, /<REDACTED>/)
        assert.equal(err.message.includes('supersecret'), false)
        return true
      },
    )
  } finally {
    await forceKill(child)
  }
})

test('pickFreePort resolves in a process whose only work is the bind', () => {
  const harness = pathToFileURL(path.join(import.meta.dirname, 'dsh-qa-harness.js')).href
  const script = `
    import { pickFreePort } from ${JSON.stringify(harness)}
    const port = await pickFreePort()
    if (!Number.isInteger(port) || port <= 0) process.exit(2)
    process.stdout.write(String(port))
  `
  const res = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    encoding: 'utf8',
    timeout: 10_000,
  })
  assert.equal(res.status, 0, res.stderr)
  assert.match(res.stdout, /^\d+$/)
})

test('skill files do not carry absolute personal paths or credential material', async () => {
  const files = [
    path.join(skillRoot, 'SKILL.md'),
    path.join(skillRoot, 'references', 'ds-dot-recipes.md'),
    path.join(skillRoot, 'scripts', 'dsh-qa-harness.js'),
  ]
  for (const file of files) {
    const text = await fs.readFile(file, 'utf8')
    assert.equal(/\/tmp\//.test(text), false, file)
    assert.equal(/\/home\/[A-Za-z0-9._-]+/.test(text), false, file)
    assert.equal(/\/Users\/[A-Za-z0-9._-]+/.test(text), false, file)
    assert.equal(/\bsk-[A-Za-z0-9]{8,}/.test(text), false, file)
    assert.equal(/\bghp_[A-Za-z0-9]/.test(text), false, file)
  }
  const manifest = JSON.parse(await fs.readFile(path.join(import.meta.dirname, 'package.json'), 'utf8'))
  assert.equal(manifest.type, 'module')
  assert.equal(manifest.private, true)
})

test('published package files do not include the agent skill', async () => {
  const pkg = JSON.parse(await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8'))
  assert.ok(Array.isArray(pkg.files))
  for (const entry of pkg.files) assert.equal(String(entry).includes('.agents'), false, entry)

  const npmHome = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-qa-npm-'))
  const npmrc = path.join(npmHome, 'npmrc')
  await fs.writeFile(npmrc, 'fund=false\naudit=false\n')
  try {
    const res = spawnSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        ...buildIsolatedEnv(npmHome, []),
        HOME: npmHome,
        USERPROFILE: npmHome,
        npm_config_cache: path.join(npmHome, 'cache'),
        npm_config_userconfig: npmrc,
        NPM_CONFIG_USERCONFIG: npmrc,
        npm_config_fund: 'false',
        npm_config_audit: 'false',
      },
    })
    assert.equal(res.status, 0, redactForLog(res.stderr))
    const packed = parsePackOutput(res.stdout)
    const names = packed.flatMap(entry => (entry.files || []).map(file => file.path || file.name || ''))
    assert.ok(names.length > 0)
    for (const name of names) {
      assert.equal(name === '.agents' || name.startsWith('.agents/') || name.includes('/.agents/'), false, name)
    }
  } finally {
    await fs.rm(npmHome, { recursive: true, force: true })
  }
})
