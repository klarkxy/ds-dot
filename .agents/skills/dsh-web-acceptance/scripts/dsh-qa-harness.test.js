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
  commandSpawnInvocation,
  ensureIsolatedHome,
  formatSpawnFailure,
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
  splitCommandLine,
  terminateProcessTree,
  urlHasLaunchToken,
  waitForDshReady,
  windowsCmdInvocation,
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

function envWithoutStartupPath(env) {
  const copy = { ...env }
  delete copy.PATH
  delete copy.Path
  return JSON.stringify(copy)
}

test('buildIsolatedEnv points HOME and profile paths at the temporary home', () => {
  const temp = path.join(os.tmpdir(), 'dsh-qa-isolated-home')
  const source = {
    PATH: '/usr/bin:/home/maintainer/.local/bin',
    Path: 'C:\\Windows\\System32;C:\\Users\\maintainer\\bin',
    HOME: '/home/maintainer',
    UserProfile: 'C:\\Users\\maintainer',
    HOMEDRIVE: 'C:',
    HOMEPATH: '\\Users\\maintainer',
    APPDATA: 'C:\\Users\\maintainer\\AppData\\Roaming',
    LOCALAPPDATA: 'C:\\Users\\maintainer\\AppData\\Local',
    XDG_CONFIG_HOME: '/home/maintainer/.config',
    XDG_DATA_HOME: '/home/maintainer/.local/share',
    XDG_CACHE_HOME: '/home/maintainer/.cache',
    XDG_STATE_HOME: '/home/maintainer/.local/state',
    XDG_RUNTIME_DIR: '/run/user/1000',
    TMPDIR: '/home/maintainer/tmp',
    TEMP: 'C:\\Users\\maintainer\\AppData\\Local\\Temp',
    TMP: 'C:\\Users\\maintainer\\AppData\\Local\\Temp',
    GIT_CONFIG_GLOBAL: '/home/maintainer/.gitconfig',
    GIT_CONFIG_KEY_0: 'url.https://example.invalid/.insteadof',
    npm_config_userconfig: '/home/maintainer/.npmrc',
    SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
    KUBECONFIG: '/home/maintainer/.kube/config',
    PNPM_HOME: '/home/maintainer/Library/pnpm',
    MY_DOTFILE: '/home/maintainer/.secret-config',
    DEEPSEEK_API_KEY: 'sk-real',
    AZURE_OPENAI_API_KEY: 'azure-secret',
    AWS_SECRET_ACCESS_KEY: 'aws-secret',
    NPM_TOKEN: 'npm-secret',
    GITHUB_TOKEN: 'gh-secret',
    SESSION_COOKIE: 'cookie-secret',
    DSH_HOME: '/home/maintainer/.dsh',
    dsh_agents_home: '/home/maintainer/.agents',
    DSH_WEB_URL: 'http://127.0.0.1:3080/',
    SYSTEMROOT: 'C:\\Windows',
    COMSPEC: 'C:\\Windows\\System32\\cmd.exe',
    PATHEXT: '.EXE',
    HARMLESS: 'ok',
  }
  const env = buildIsolatedEnv(temp, ['AZURE_OPENAI_API_KEY'], source)
  assert.equal(env.HOME, temp)
  assert.equal(env.USERPROFILE, temp)
  assert.equal(env.DSH_HOME, temp)
  assert.equal(env.DSH_AGENTS_HOME, path.join(temp, 'agents-home'))
  assert.equal(isInsideDir(temp, env.DSH_AGENTS_HOME), true)
  assert.equal(env.APPDATA, path.join(temp, 'AppData', 'Roaming'))
  assert.equal(env.LOCALAPPDATA, path.join(temp, 'AppData', 'Local'))
  assert.equal(env.XDG_CONFIG_HOME, path.join(temp, '.config'))
  assert.equal(env.XDG_DATA_HOME, path.join(temp, '.local', 'share'))
  assert.equal(env.XDG_CACHE_HOME, path.join(temp, '.cache'))
  assert.equal(env.XDG_STATE_HOME, path.join(temp, '.local', 'state'))
  assert.equal(env.XDG_RUNTIME_DIR, path.join(temp, '.runtime'))
  assert.equal(env.TMP, path.join(temp, 'tmp'))
  assert.equal(env.TEMP, path.join(temp, 'tmp'))
  assert.equal(env.TMPDIR, path.join(temp, 'tmp'))
  assert.equal(env.GIT_CONFIG_NOSYSTEM, '1')
  assert.equal(env.GIT_CONFIG_GLOBAL, path.join(temp, '.gitconfig'))
  assert.equal(env.GIT_CONFIG_SYSTEM, path.join(temp, '.gitconfig-system'))
  assert.equal(env.DSH_TELEMETRY_DISABLED, '1')
  assert.equal(env.DSH_TELEMETRY_MODE, 'DISABLED')
  assert.equal(env.AZURE_OPENAI_API_KEY, 'azure-secret')
  assert.equal(env.HARMLESS, 'ok')
  assert.equal(env.PATH, '/usr/bin:/home/maintainer/.local/bin')
  assert.equal(env.Path, 'C:\\Windows\\System32;C:\\Users\\maintainer\\bin')
  assert.equal(env.SYSTEMROOT, 'C:\\Windows')
  assert.equal(env.COMSPEC, 'C:\\Windows\\System32\\cmd.exe')
  assert.equal(env.PATHEXT, '.EXE')
  for (const key of [
    'DEEPSEEK_API_KEY',
    'AWS_SECRET_ACCESS_KEY',
    'NPM_TOKEN',
    'GITHUB_TOKEN',
    'SESSION_COOKIE',
    'DSH_WEB_URL',
    'dsh_agents_home',
    'UserProfile',
    'SSH_AUTH_SOCK',
    'KUBECONFIG',
    'PNPM_HOME',
    'MY_DOTFILE',
    'GIT_CONFIG_KEY_0',
    'npm_config_userconfig',
  ]) {
    assert.equal(Object.hasOwn(env, key), false, key)
  }
  const serialized = envWithoutStartupPath(env)
  assert.equal(serialized.includes('sk-real'), false)
  assert.equal(serialized.includes('aws-secret'), false)
  assert.equal(serialized.includes('npm-secret'), false)
  assert.equal(serialized.includes('gh-secret'), false)
  assert.equal(serialized.includes('cookie-secret'), false)
  assert.equal(serialized.includes('/home/maintainer'), false)
  assert.equal(serialized.toLowerCase().includes('c:\\users\\maintainer'), false)
  assert.equal(serialized.toLowerCase().includes('c:/users/maintainer'), false)
  assert.equal(serialized.includes('insteadof'), false)
  assert.equal(serialized.includes('/run/user/1000'), false)
})

test('buildIsolatedEnv redirects a Windows profile home on any host', () => {
  const temp = 'C:\\qa\\isolated-home'
  const env = buildIsolatedEnv(temp, [], {
    HOME: '/home/maintainer',
    USERPROFILE: 'C:\\Users\\maintainer',
    HOMEDRIVE: 'C:',
    HOMEPATH: '\\Users\\maintainer',
    APPDATA: 'C:\\Users\\maintainer\\AppData\\Roaming',
    LOCALAPPDATA: 'C:\\Users\\maintainer\\AppData\\Local',
    TEMP: 'C:\\Users\\maintainer\\AppData\\Local\\Temp',
    TMP: 'C:\\Users\\maintainer\\AppData\\Local\\Temp',
    PATH: 'C:\\Windows\\System32',
    SYSTEMROOT: 'C:\\Windows',
    COMSPEC: 'C:\\Windows\\System32\\cmd.exe',
    SSH_AUTH_SOCK: '\\\\.\\pipe\\openssh-ssh-agent',
    npm_config_userconfig: 'C:\\Users\\maintainer\\.npmrc',
    GIT_CONFIG_GLOBAL: 'C:\\Users\\maintainer\\.gitconfig',
  })
  assert.equal(env.HOME, temp)
  assert.equal(env.USERPROFILE, temp)
  assert.equal(env.HOMEDRIVE, 'C:')
  assert.equal(env.HOMEPATH, '\\qa\\isolated-home')
  assert.equal(env.APPDATA, 'C:\\qa\\isolated-home\\AppData\\Roaming')
  assert.equal(env.LOCALAPPDATA, 'C:\\qa\\isolated-home\\AppData\\Local')
  assert.equal(env.TEMP, 'C:\\qa\\isolated-home\\tmp')
  assert.equal(env.TMP, 'C:\\qa\\isolated-home\\tmp')
  assert.equal(env.DSH_HOME, temp)
  assert.equal(env.DSH_AGENTS_HOME, 'C:\\qa\\isolated-home\\agents-home')
  assert.equal(env.XDG_CONFIG_HOME, 'C:\\qa\\isolated-home\\.config')
  assert.equal(env.PATH, 'C:\\Windows\\System32')
  assert.equal(env.SYSTEMROOT, 'C:\\Windows')
  assert.equal(env.COMSPEC, 'C:\\Windows\\System32\\cmd.exe')
  assert.equal(Object.hasOwn(env, 'SSH_AUTH_SOCK'), false)
  assert.equal(Object.hasOwn(env, 'npm_config_userconfig'), false)
  const serialized = envWithoutStartupPath(env)
  assert.equal(serialized.toLowerCase().includes('users\\maintainer'), false)
  assert.equal(serialized.toLowerCase().includes('users/maintainer'), false)
})

test('buildIsolatedEnv rejects allow-env overrides of home and profile variables', () => {
  const temp = path.join(os.tmpdir(), 'dsh-qa-isolated-home')
  const source = {
    HOME: '/home/maintainer',
    USERPROFILE: 'C:\\Users\\maintainer',
    MY_DOTFILE: '/home/maintainer/.secret-config',
    AZURE_OPENAI_API_KEY: 'azure-secret',
  }
  for (const name of [
    'HOME',
    'home',
    'USERPROFILE',
    'UserProfile',
    'APPDATA',
    'LOCALAPPDATA',
    'HOMEDRIVE',
    'HOMEPATH',
    'XDG_CONFIG_HOME',
    'XDG_CACHE_HOME',
    'TMP',
    'TEMP',
    'TMPDIR',
    'DSH_HOME',
    'DSH_AGENTS_HOME',
    'dsh_agents_home',
    'npm_config_userconfig',
    'GIT_CONFIG_GLOBAL',
    'SSH_AUTH_SOCK',
    'PNPM_HOME',
  ]) {
    assert.throws(() => buildIsolatedEnv(temp, [name], source), /isolated home and profile paths/, name)
    assert.throws(() => parseArgs(['--allow-env', name]), /isolated home and profile paths/, name)
  }
  assert.throws(
    () => buildIsolatedEnv(temp, ['MY_DOTFILE'], source),
    /inside a real profile/,
  )
  const allowed = buildIsolatedEnv(temp, ['AZURE_OPENAI_API_KEY'], source)
  assert.equal(allowed.AZURE_OPENAI_API_KEY, 'azure-secret')
  assert.equal(allowed.HOME, temp)
  assert.equal(allowed.USERPROFILE, temp)
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
  assert.equal(quoteWindowsCmdArg('calc()'), '"calc()"')
  assert.equal(quoteWindowsCmdArg('a!b'), '"a!b"')
  assert.throws(() => quoteWindowsCmdArg('a\nb'), /newlines or NUL/)
  assert.throws(() => quoteWindowsCmdArg('a\0b'), /newlines or NUL/)
})

test('splitCommandLine respects quoting and spaced paths', () => {
  assert.deepEqual(splitCommandLine('dsh'), ['dsh'])
  assert.deepEqual(splitCommandLine('pnpm dsh'), ['pnpm', 'dsh'])
  assert.deepEqual(
    splitCommandLine('"C:\\Program Files\\nodejs\\node.exe" C:\\tmp\\fake.mjs'),
    ['C:\\Program Files\\nodejs\\node.exe', 'C:\\tmp\\fake.mjs'],
  )
  assert.deepEqual(
    splitCommandLine('\'C:\\Program Files\\nodejs\\node.exe\' --flag'),
    ['C:\\Program Files\\nodejs\\node.exe', '--flag'],
  )
  assert.deepEqual(
    splitCommandLine('"C:\\a\\b.exe" "arg with space" tail'),
    ['C:\\a\\b.exe', 'arg with space', 'tail'],
  )
  assert.throws(() => splitCommandLine('"unterminated'), /Unterminated quote/)
})

test('windows command invocation quotes argv and does not enable shell', () => {
  const packArgs = ['pack', '--dry-run', '--ignore-scripts', '--json']
  const pack = windowsCmdInvocation('npm', packArgs, { COMSPEC: 'C:\\Windows\\System32\\cmd.exe' })
  assert.equal(pack.file, 'C:\\Windows\\System32\\cmd.exe')
  assert.deepEqual(pack.args, ['/d', '/v:off', '/s', '/c', '"npm pack --dry-run --ignore-scripts --json"'])
  assert.equal(pack.windowsVerbatimArguments, true)
  assert.equal(pack.windowsHide, true)
  assert.equal(pack.shell, undefined)

  const hostile = windowsCmdInvocation('npm', ['pack', 'a&whoami', '%TEMP%', 'say "hi"', 'C:\\Program Files (x86)\\plugin'], {
    PATH: 'C:\\Windows\\System32',
  })
  assert.equal(hostile.file, 'cmd.exe')
  assert.equal(hostile.args.length, 5)
  assert.equal(hostile.shell, undefined)
  assert.equal(
    hostile.args[4],
    '"npm pack "a&whoami" "%%TEMP%%" "say ""hi""" "C:\\Program Files (x86)\\plugin""',
  )
  assert.throws(() => windowsCmdInvocation('npm', ['pack', 'line1\nline2']), /newlines or NUL/)
})

test('commandSpawnInvocation leaves posix commands unwrapped', () => {
  const spec = commandSpawnInvocation('npm', ['pack', '--json'], { COMSPEC: 'C:\\Windows\\System32\\cmd.exe' })
  if (process.platform === 'win32') {
    assert.equal(spec.file, 'C:\\Windows\\System32\\cmd.exe')
    assert.equal(spec.args[0], '/d')
    assert.equal(spec.args[2], '/s')
    assert.equal(spec.args[3], '/c')
    assert.equal(spec.shell, undefined)
    return
  }
  assert.equal(spec.file, 'npm')
  assert.deepEqual(spec.args, ['pack', '--json'])
  assert.equal(spec.shell, undefined)
  assert.equal(spec.windowsVerbatimArguments, undefined)
})

test('formatSpawnFailure reports a command that never started', () => {
  const text = formatSpawnFailure({
    status: null,
    signal: null,
    error: Object.assign(new Error('spawnSync npm ENOENT'), {
      code: 'ENOENT',
      syscall: 'spawnSync npm',
      path: 'npm',
    }),
    stderr: '',
    stdout: '',
  })
  assert.match(text, /status=null/)
  assert.match(text, /signal=/)
  assert.match(text, /error=ENOENT spawnSync npm npm spawnSync npm ENOENT/)
  assert.equal(text.includes('stderr='), false)
  const redacted = redactForLog(formatSpawnFailure({
    status: 1,
    signal: null,
    stderr: 'failed in /home/maintainer/.npm token=launch-secret',
    stdout: '',
  }), '/home/maintainer')
  assert.match(redacted, /<HOME>\/\.npm/)
  assert.match(redacted, /token=<REDACTED>/)
  assert.equal(redacted.includes('launch-secret'), false)
  assert.equal(redacted.includes('maintainer'), false)
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
      '--dsh-cmd', `"${process.execPath}" ${script}`,
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
  const globalNpmrc = path.join(npmHome, 'npmrc-global')
  await fs.writeFile(npmrc, 'fund=false\naudit=false\n')
  await fs.writeFile(globalNpmrc, 'fund=false\naudit=false\n')
  await ensureIsolatedHome(npmHome)
  try {
    const isolated = buildIsolatedEnv(npmHome, [])
    assert.equal(isolated.HOME, npmHome)
    assert.equal(isolated.USERPROFILE, npmHome)
    const packArgs = ['pack', '--dry-run', '--ignore-scripts', '--json']
    const invocation = commandSpawnInvocation('npm', packArgs, isolated)
    assert.equal(invocation.shell, undefined)
    const res = spawnSync(invocation.file, invocation.args, {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        ...isolated,
        npm_config_cache: path.join(npmHome, 'cache'),
        npm_config_userconfig: npmrc,
        NPM_CONFIG_USERCONFIG: npmrc,
        npm_config_globalconfig: globalNpmrc,
        NPM_CONFIG_GLOBALCONFIG: globalNpmrc,
        npm_config_fund: 'false',
        npm_config_audit: 'false',
      },
      ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      ...(invocation.windowsHide ? { windowsHide: true } : {}),
    })
    const failure = redactForLog(redactForLog(formatSpawnFailure(res), npmHome))
    assert.equal(res.status, 0, failure)
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
