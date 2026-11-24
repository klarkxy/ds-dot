#!/usr/bin/env node
/**
 * Isolated DeepSeek Harness (dsh web) QA, screenshot, and GIF runner.
 *
 * Cross-platform (Windows / macOS / Linux, Node >= 22).
 * Uses a temporary HOME, USERPROFILE, DSH_HOME, and DSH_AGENTS_HOME, binds a free loopback port,
 * accepts only a loopback launch URL, exchanges its token for an HttpOnly
 * dsh-auth-* cookie, and drops every other cookie and web storage before
 * recording. The dsh process tree is killed and confirmed exited before
 * DSH_HOME is removed. Screenshots and GIFs are refused inside a git checkout.
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, realpathSync, statSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN|COOKIE/i
const COLOR_SCHEMES = new Set(['light', 'dark', 'no-preference'])
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

// Profile and config locations. --allow-env cannot put any of these back.
// NPM_CONFIG_* and GIT_CONFIG_* are blocked by prefix below, then the git
// files we own are written inside the temporary home.
const PROFILE_ENV_NAMES = new Set([
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
  'XDG_RUNTIME_DIR',
  'TMP',
  'TEMP',
  'TMPDIR',
  'SSH_AUTH_SOCK',
  'GIT_SSH_COMMAND',
  'GNUPGHOME',
  'DOCKER_CONFIG',
  'GH_CONFIG_DIR',
  'KUBECONFIG',
  'AWS_CONFIG_FILE',
  'AWS_SHARED_CREDENTIALS_FILE',
  'NETRC',
  'CURL_HOME',
  'COMPOSER_HOME',
  'CARGO_HOME',
  'RUSTUP_HOME',
  'BUNDLE_USER_HOME',
  'BUNDLE_USER_CONFIG',
  'GEM_HOME',
  'GEM_SPEC_CACHE',
  'PIP_CONFIG_FILE',
  'CONDARC',
  'JUPYTER_CONFIG_DIR',
  'IPYTHONDIR',
  'NODE_REPL_HISTORY',
  'HISTFILE',
  'LESSHISTFILE',
  'INPUTRC',
  'XAUTHORITY',
  'PYTHONSTARTUP',
  'PYTHONUSERBASE',
  'PNPM_HOME',
  'COREPACK_HOME',
  'GRADLE_USER_HOME',
  'NUGET_PACKAGES',
  'DOTNET_CLI_HOME',
])

// Needed to find dsh, node, and cmd. These stay even when an entry lives
// under the caller's home directory.
const STARTUP_ENV_NAMES = new Set([
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'OS',
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_ARCHITEW6432',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMW6432',
  'COMMONPROGRAMFILES',
  'COMMONPROGRAMFILES(X86)',
  'PROGRAMDATA',
  'ALLUSERSPROFILE',
  'PUBLIC',
  'DRIVERDATA',
  'NUMBER_OF_PROCESSORS',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
])

export function redactTokens(input) {
  if (typeof input !== 'string') return ''
  return input
    .replace(/((?:token|access_token|id_token)=)[^&\s#]+/gi, '$1<REDACTED>')
    .replace(/(dsh-auth-[A-Za-z0-9_-]+=)[^;\s]+/gi, '$1<REDACTED>')
    .replace(/((?:authorization|bearer)["']?\s*[:=]\s*["']?)[^\s&,"']+/gi, '$1<REDACTED>')
}

export function redactForLog(input, homeDir = os.homedir()) {
  let text = redactTokens(typeof input === 'string' ? input : String(input ?? ''))
  if (typeof homeDir === 'string' && homeDir.length > 1) {
    text = text.split(homeDir).join('<HOME>')
  }
  return text
}

function requireInteger(flag, raw, { min, max }) {
  if (typeof raw === 'number' && Number.isInteger(raw)) {
    if (raw < min || raw > max) throw new Error(`${flag} must be an integer from ${min} to ${max}.`)
    return raw
  }
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    throw new Error(`${flag} expects an integer from ${min} to ${max}.`)
  }
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${flag} must be an integer from ${min} to ${max}.`)
  }
  return value
}

export function parseArgs(argv) {
  const opts = {
    pluginDirs: [],
    patches: [],
    allowEnv: [],
    dshCmd: 'dsh',
    dshCwd: process.cwd(),
    profile: 'web',
    outDir: path.join(os.tmpdir(), `dsh-qa-artifacts-${Date.now()}`),
    scenarioPath: undefined,
    viewportWidth: 1440,
    viewportHeight: 900,
    gifWidth: 1280,
    gifFps: 12,
    locale: 'zh-CN',
    colorScheme: 'light',
    bootTimeoutMs: 45_000,
    keepTempHome: false,
    recordGif: false,
    gifName: 'acceptance.gif',
    screenshotName: 'acceptance.png',
    waitSelector: undefined,
    clickSelectors: [],
    settleMs: 1200,
    help: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`Missing value for ${arg}`)
      i += 1
      return argv[i]
    }
    if (arg === '-h' || arg === '--help') opts.help = true
    else if (arg === '--plugin') opts.pluginDirs.push(path.resolve(next()))
    else if (arg === '--patch') opts.patches.push(path.resolve(next()))
    else if (arg === '--dsh-cmd') opts.dshCmd = next()
    else if (arg === '--cwd') opts.dshCwd = path.resolve(next())
    else if (arg === '--profile') opts.profile = next()
    else if (arg === '--out-dir') opts.outDir = path.resolve(next())
    else if (arg === '--scenario') opts.scenarioPath = path.resolve(next())
    else if (arg === '--viewport') {
      const m = /^(\d+)x(\d+)$/i.exec(next())
      if (!m) throw new Error('Expected --viewport <WIDTHxHEIGHT>, e.g. 1440x900')
      opts.viewportWidth = requireInteger('--viewport width', m[1], { min: 1, max: 8192 })
      opts.viewportHeight = requireInteger('--viewport height', m[2], { min: 1, max: 8192 })
    } else if (arg === '--gif') opts.recordGif = true
    else if (arg === '--gif-name') {
      opts.recordGif = true
      opts.gifName = next()
    } else if (arg === '--gif-width') opts.gifWidth = requireInteger('--gif-width', next(), { min: 1, max: 4096 })
    else if (arg === '--gif-fps') opts.gifFps = requireInteger('--gif-fps', next(), { min: 1, max: 60 })
    else if (arg === '--screenshot-name') opts.screenshotName = next()
    else if (arg === '--locale') opts.locale = next()
    else if (arg === '--color-scheme') opts.colorScheme = next()
    else if (arg === '--wait-selector') opts.waitSelector = next()
    else if (arg === '--click') opts.clickSelectors.push(next())
    else if (arg === '--settle-ms') opts.settleMs = requireInteger('--settle-ms', next(), { min: 0, max: 120_000 })
    else if (arg === '--boot-timeout-ms') opts.bootTimeoutMs = requireInteger('--boot-timeout-ms', next(), { min: 1, max: 600_000 })
    else if (arg === '--allow-env') {
      const name = next()
      assertAllowEnvName(name)
      opts.allowEnv.push(name)
    }
    else if (arg === '--keep-temp-home') opts.keepTempHome = true
    else throw new Error(`Unknown option: ${arg}`)
  }
  if (!opts.help) validateOpts(opts)
  return opts
}

export function validateOpts(opts) {
  requireInteger('viewport width', opts.viewportWidth, { min: 1, max: 8192 })
  requireInteger('viewport height', opts.viewportHeight, { min: 1, max: 8192 })
  requireInteger('gif width', opts.gifWidth, { min: 1, max: 4096 })
  requireInteger('gif fps', opts.gifFps, { min: 1, max: 60 })
  requireInteger('settle ms', opts.settleMs, { min: 0, max: 120_000 })
  requireInteger('boot timeout', opts.bootTimeoutMs, { min: 1, max: 600_000 })
  if (!COLOR_SCHEMES.has(opts.colorScheme)) {
    throw new Error('Expected --color-scheme light, dark, or no-preference.')
  }
  if (!opts.profile || opts.profile.startsWith('-') || /[\0\r\n]/.test(opts.profile)) {
    throw new Error('Invalid --profile value.')
  }
  if (typeof opts.dshCmd !== 'string' || opts.dshCmd.trim() === '') {
    throw new Error('Invalid --dsh-cmd value.')
  }
  if (typeof opts.locale !== 'string' || opts.locale.trim() === '' || /[\0\r\n]/.test(opts.locale)) {
    throw new Error('Invalid --locale value.')
  }
  if (!opts.gifName || !opts.screenshotName) throw new Error('Output filename is empty.')
  if (!opts.outDir) throw new Error('Output directory is empty.')
}

function printHelp() {
  console.log(`Usage: node dsh-qa-harness.js [options]

Spins up an isolated DeepSeek Harness Web instance (temporary HOME,
USERPROFILE, DSH_HOME, and DSH_AGENTS_HOME, free loopback port), mounts
local plugins via link:, runs Playwright acceptance, captures screenshots
and GIFs outside the git checkout, and tears down the process tree before
removing the temporary home.

Options:
  --plugin <dir>            Link built local plugin checkout (repeatable)
  --patch <yml>             Apply extra Cordis --patch overlay (repeatable)
  --scenario <file.mjs>     Custom Playwright scenario module exporting run(ctx)
  --out-dir <dir>           Output folder outside the git checkout
  --viewport <WxH>          Browser viewport, default 1440x900
  --locale <bcp47>          Browser locale, default zh-CN
  --color-scheme <scheme>   light, dark, or no-preference (default light)
  --wait-selector <css>     CSS selector to await before default capture
  --click <css>             Click selector in sequence during default run (repeatable)
  --screenshot-name <name>  Default screenshot filename (default: acceptance.png)
  --gif                     Record interaction GIF (default: acceptance.gif)
  --gif-name <name>         Enable GIF recording and set output filename
  --gif-width <px>          Output GIF max width, default 1280
  --gif-fps <fps>           Output GIF frame rate, default 12
  --settle-ms <ms>          Final hold time in ms before ending recording (1200)
  --dsh-cmd <cmd>           Command to launch dsh (default: "dsh", or "pnpm dsh")
  --cwd <dir>               Working directory for dsh workspace (default: cwd)
  --allow-env <VAR>         Reintroduce one scrubbed variable (repeatable).
                            Cannot restore HOME, USERPROFILE, DSH_HOME,
                            DSH_AGENTS_HOME, or other profile paths.
  --boot-timeout-ms <ms>    Startup readiness timeout (default: 45000)
  --keep-temp-home          Retain temporary DSH_HOME on disk for debugging
  -h, --help                Show this help text
`)
}

export async function pickFreePort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.on('error', reject)
    srv.listen(0, host, () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(err => {
        if (err) reject(err)
        else if (!port) reject(new Error('Failed to allocate a loopback port.'))
        else resolve(port)
      })
    })
  })
}

function isBlockedProfileName(upper) {
  return upper.startsWith('DSH_')
    || upper.startsWith('NPM_CONFIG_')
    || upper.startsWith('GIT_CONFIG_')
    || PROFILE_ENV_NAMES.has(upper)
}

function assertAllowEnvName(name) {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new Error('--allow-env requires an environment variable name.')
  }
  if (isBlockedProfileName(name.toUpperCase())) {
    throw new Error(`--allow-env cannot keep ${name}; isolated home and profile paths are mandatory.`)
  }
}

function slashPath(value) {
  return String(value).replaceAll('\\', '/')
}

function usableProfileRoot(value) {
  if (typeof value !== 'string') return null
  const norm = slashPath(value).replace(/\/+$/, '')
  if (norm.length < 2 || norm === '/' || /^[A-Za-z]:$/.test(norm)) return null
  return norm
}

function profileRootsFrom(source) {
  const roots = []
  const add = value => {
    const root = usableProfileRoot(value)
    if (root && !roots.some(item => item.toLowerCase() === root.toLowerCase())) roots.push(root)
  }
  let drive = null
  let homePath = null
  for (const [key, value] of Object.entries(source)) {
    if (typeof value !== 'string') continue
    const upper = key.toUpperCase()
    if (upper === 'HOME' || upper === 'USERPROFILE' || upper === 'APPDATA' || upper === 'LOCALAPPDATA'
      || upper === 'XDG_CONFIG_HOME' || upper === 'XDG_DATA_HOME' || upper === 'XDG_CACHE_HOME'
      || upper === 'XDG_STATE_HOME' || upper === 'XDG_RUNTIME_DIR') {
      add(value)
    } else if (upper === 'HOMEDRIVE') drive = value
    else if (upper === 'HOMEPATH') homePath = value
  }
  if (drive && homePath) add(`${drive}${homePath}`)
  return roots
}

function isUnderProfileRoot(root, value) {
  const child = slashPath(value).replace(/\/+$/, '')
  if (!child) return false
  const parent = root.toLowerCase()
  const current = child.toLowerCase()
  return current === parent || current.startsWith(`${parent}/`)
}

function valueInsideRealProfile(value, roots) {
  const raw = slashPath(value).trim()
  if (raw === '~' || raw.startsWith('~/')) return true
  for (const root of roots) {
    if (isUnderProfileRoot(root, raw)) return true
    for (const part of raw.split(';')) {
      const piece = part.trim()
      if (piece && isUnderProfileRoot(root, piece)) return true
    }
  }
  return false
}

function joinHome(home, ...parts) {
  const windows = /^[A-Za-z]:[\\/]/.test(home) || (home.includes('\\') && !home.startsWith('/'))
  if (!windows) return path.join(home, ...parts)
  const base = home.replace(/[\\/]+$/, '').replaceAll('/', '\\')
  return [base, ...parts].join('\\')
}

export function windowsHomeParts(homeDir) {
  const slashed = String(homeDir).replaceAll('/', '\\')
  const match = /^([A-Za-z]:)(.*)$/.exec(slashed)
  if (!match) return { HOMEDRIVE: '', HOMEPATH: homeDir }
  let rest = match[2]
  if (!rest.startsWith('\\')) rest = `\\${rest}`
  return { HOMEDRIVE: match[1].toUpperCase(), HOMEPATH: rest }
}

export function isolatedProfileAssignments(tempHome) {
  const windows = windowsHomeParts(tempHome)
  return {
    HOME: tempHome,
    USERPROFILE: tempHome,
    HOMEDRIVE: windows.HOMEDRIVE,
    HOMEPATH: windows.HOMEPATH,
    APPDATA: joinHome(tempHome, 'AppData', 'Roaming'),
    LOCALAPPDATA: joinHome(tempHome, 'AppData', 'Local'),
    XDG_CONFIG_HOME: joinHome(tempHome, '.config'),
    XDG_DATA_HOME: joinHome(tempHome, '.local', 'share'),
    XDG_CACHE_HOME: joinHome(tempHome, '.cache'),
    XDG_STATE_HOME: joinHome(tempHome, '.local', 'state'),
    XDG_RUNTIME_DIR: joinHome(tempHome, '.runtime'),
    TMP: joinHome(tempHome, 'tmp'),
    TEMP: joinHome(tempHome, 'tmp'),
    TMPDIR: joinHome(tempHome, 'tmp'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: joinHome(tempHome, '.gitconfig'),
    GIT_CONFIG_SYSTEM: joinHome(tempHome, '.gitconfig-system'),
    DSH_HOME: tempHome,
    DSH_AGENTS_HOME: joinHome(tempHome, 'agents-home'),
  }
}

export async function ensureIsolatedHome(tempHome) {
  const profile = isolatedProfileAssignments(tempHome)
  const dirs = [
    tempHome,
    profile.DSH_AGENTS_HOME,
    profile.APPDATA,
    profile.LOCALAPPDATA,
    profile.XDG_CONFIG_HOME,
    profile.XDG_DATA_HOME,
    profile.XDG_CACHE_HOME,
    profile.XDG_STATE_HOME,
    profile.XDG_RUNTIME_DIR,
    profile.TMP,
  ]
  for (const dir of dirs) await fs.mkdir(dir, { recursive: true })
  await fs.chmod(profile.XDG_RUNTIME_DIR, 0o700).catch(() => {})
  await fs.writeFile(profile.GIT_CONFIG_GLOBAL, '', { flag: 'a' })
  await fs.writeFile(profile.GIT_CONFIG_SYSTEM, '', { flag: 'a' })
}

export function buildIsolatedEnv(tempHome, allowEnv = [], source = process.env) {
  const allow = new Set()
  for (const name of allowEnv) {
    assertAllowEnvName(name)
    allow.add(name.toUpperCase())
  }

  const roots = profileRootsFrom(source)
  const env = {}
  for (const [key, value] of Object.entries(source)) {
    if (typeof value !== 'string') continue
    const upper = key.toUpperCase()
    if (isBlockedProfileName(upper)) continue
    if (SENSITIVE_ENV_PATTERN.test(key) && !allow.has(upper)) continue
    if (!STARTUP_ENV_NAMES.has(upper) && valueInsideRealProfile(value, roots)) {
      if (allow.has(upper)) {
        throw new Error(`--allow-env cannot keep ${key}; its value is inside a real profile.`)
      }
      continue
    }
    env[key] = value
  }

  Object.assign(env, isolatedProfileAssignments(tempHome))
  env.DSH_TELEMETRY_DISABLED = '1'
  env.DSH_TELEMETRY_MODE = 'DISABLED'
  env.NO_COLOR = '1'
  return env
}

const DEFAULT_WINDOWS_PATHEXT = ['.COM', '.EXE', '.BAT', '.CMD', '.VBS', '.VBE', '.JS', '.JSE', '.WSF', '.WSH', '.MSC']

function envLookup(env, name) {
  if (!env) return undefined
  if (typeof env[name] === 'string') return env[name]
  const upper = name.toUpperCase()
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() === upper && typeof value === 'string') return value
  }
  return undefined
}

function isRegularFile(filePath) {
  try {
    return !statSync(filePath).isDirectory()
  } catch {
    return false
  }
}

function windowsPathExts(env) {
  const raw = envLookup(env, 'PATHEXT')
  if (!raw || !raw.trim()) return DEFAULT_WINDOWS_PATHEXT
  const exts = raw.split(';').map(ext => ext.trim()).filter(Boolean).map(ext => (ext.startsWith('.') ? ext : `.${ext}`))
  return exts.length > 0 ? exts : DEFAULT_WINDOWS_PATHEXT
}

export function resolveWindowsExecutable(bin, env = process.env, cwd = process.cwd()) {
  const cmd = String(bin)
  if (!cmd) return null
  const exts = windowsPathExts(env)
  const hasDir = /[\\/]/.test(cmd) || /^[A-Za-z]:/.test(cmd)
  const baseCwd = cwd || process.cwd()
  const dirs = hasDir
    ? [null]
    : [
        baseCwd,
        ...(envLookup(env, 'PATH') || '')
          .split(';')
          .map(entry => entry.trim().replace(/^"+|"+$/g, ''))
          .filter(Boolean),
      ]
  for (const dir of dirs) {
    const base = dir === null ? path.resolve(baseCwd, cmd) : path.resolve(dir, cmd)
    const ext = path.extname(base)
    if (ext && (/\.(?:exe|com|cmd|bat)$/i.test(base) || exts.some(e => e.toLowerCase() === ext.toLowerCase())) && isRegularFile(base)) {
      return base
    }
    for (const candidateExt of exts) {
      const lowerExt = candidateExt.toLowerCase()
      if (lowerExt !== candidateExt && isRegularFile(`${base}${lowerExt}`)) return `${base}${lowerExt}`
      const candidate = `${base}${candidateExt}`
      if (isRegularFile(candidate)) return candidate
    }
  }
  return null
}

function isWindowsNativeImage(bin) {
  return /\.(?:exe|com)$/i.test(String(bin))
}

function quoteWindowsArg(arg, nativeArgv) {
  const value = String(arg)
  if (/[\0\r\n]/.test(value)) {
    throw new Error('Windows command arguments cannot contain newlines or NUL.')
  }
  if (value.length === 0) return '""'
  // ( ) ! , ; = are cmd delimiters/metacharacters. Quoting them keeps one
  // argument intact when handed to cmd.exe /c. % is doubled for batch files.
  if (!/[\s"%&|<>^()!,;=]/.test(value)) return value
  let inner = value.replace(/%/g, '%%')
  if (nativeArgv) {
    // Native images are parsed by CommandLineToArgvW / the CRT: backslashes
    // immediately before any quote (internal or the closing quote) must be
    // doubled so the quote is not swallowed as an escape.
    inner = inner.replace(/(\\*)"/g, (_, slashes) => `${slashes}${slashes}""`)
    inner = inner.replace(/\\+$/, slashes => slashes + slashes)
  } else {
    inner = inner.replace(/"/g, '""')
  }
  return `"${inner}"`
}

export function quoteWindowsCmdArg(arg) {
  return quoteWindowsArg(arg, false)
}

function quoteWindowsNativeArg(arg) {
  return quoteWindowsArg(arg, true)
}

function comSpecFrom(env) {
  const value = envLookup(env, 'COMSPEC')
  if (typeof value === 'string' && value.trim()) return value
  return 'cmd.exe'
}

// Node 24 does not apply PATHEXT when shell is false, so spawn('npm') is
// ENOENT. spawn('npm.cmd') is EINVAL (CVE-2024-27980) unless shell is set.
// shell:true concatenates arguments without quoting. Build one cmd.exe /c
// argument instead, with each argv element already quoted.
export function windowsCmdInvocation(bin, args, env = process.env, cwd = undefined) {
  const argv = [bin, ...args].map(part => String(part))
  const resolved = resolveWindowsExecutable(argv[0], env, cwd)
  const quote = isWindowsNativeImage(resolved ?? argv[0]) ? quoteWindowsNativeArg : quoteWindowsCmdArg
  const inner = argv.map(quote).join(' ')
  return {
    file: comSpecFrom(env),
    args: ['/d', '/v:off', '/s', '/c', `"${inner}"`],
    windowsVerbatimArguments: true,
    windowsHide: true,
  }
}

export function commandSpawnInvocation(bin, args, env = process.env, cwd = undefined) {
  if (process.platform === 'win32') {
    const resolved = resolveWindowsExecutable(bin, env, cwd)
    if (resolved && isWindowsNativeImage(resolved)) {
      return {
        file: resolved,
        args: [...args].map(part => String(part)),
        windowsHide: true,
      }
    }
    return windowsCmdInvocation(bin, args, env, cwd)
  }
  return { file: String(bin), args: [...args].map(part => String(part)) }
}

export function formatSpawnFailure(res) {
  const error = res && res.error
  const lines = [
    `status=${res == null || res.status == null ? 'null' : res.status}`,
    `signal=${res && res.signal ? res.signal : ''}`,
  ]
  if (error) {
    const bits = [error.code, error.syscall, error.path, error.message].filter(Boolean)
    lines.push(`error=${bits.join(' ')}`)
  }
  const stderr = res && typeof res.stderr === 'string' ? res.stderr.trim() : ''
  const stdout = res && typeof res.stdout === 'string' ? res.stdout.trim() : ''
  if (stderr) lines.push(`stderr=${stderr}`)
  if (stdout) lines.push(`stdout=${stdout}`)
  return lines.join('\n')
}

// --dsh-cmd is a single string like `"C:\Program Files\nodejs\node.exe" app.js`.
// Split on unquoted whitespace only. Double quotes may open a quoted run
// mid-token (e.g. --flag="path with spaces"). Single quotes open a quoted
// run at a token boundary, or after `=` / `:` when a closing `'` exists
// (e.g. --flag='a b'), so a bare apostrophe in a path stays literal.
// Quote characters are removed; doubled quotes inside a quoted run collapse
// to one literal quote.
export function splitCommandLine(cmdString) {
  const parts = []
  let current = ''
  let started = false
  let quote = null
  for (let i = 0; i < cmdString.length; i += 1) {
    const ch = cmdString[i]
    if (quote) {
      if (ch === quote) {
        if (cmdString[i + 1] === quote) {
          current += ch
          i += 1
        } else {
          quote = null
        }
      } else {
        current += ch
      }
      continue
    }
    const prev = i > 0 ? cmdString[i - 1] : ''
    if (
      ch === '"'
      || (ch === "'" && (!started || ((prev === '=' || prev === ':') && cmdString.indexOf("'", i + 1) !== -1)))
    ) {
      quote = ch
      started = true
    } else if (/\s/.test(ch)) {
      if (started || current.length > 0) {
        parts.push(current)
        current = ''
        started = false
      }
    } else {
      current += ch
      started = true
    }
  }
  if (quote) throw new Error(`Unterminated quote in command: ${cmdString}`)
  if (started || current.length > 0) parts.push(current)
  return parts
}

function splitCommand(cmdString) {
  const parts = splitCommandLine(cmdString)
  if (!parts[0]) throw new Error('Invalid --dsh-cmd value.')
  return { bin: parts[0], prefixArgs: parts.slice(1) }
}

function spawnCrossPlatform(bin, args, options) {
  if (process.platform === 'win32') {
    const childEnv = options.env || process.env
    const lookup = { ...childEnv }
    if (!(lookup.ComSpec || lookup.COMSPEC || lookup.comspec)) {
      const parent = process.env.ComSpec || process.env.COMSPEC || process.env.comspec
      if (parent) lookup.COMSPEC = parent
    }
    const spec = commandSpawnInvocation(bin, args, lookup, options.cwd)
    return spawn(spec.file, spec.args, {
      ...options,
      shell: false,
      windowsHide: true,
      ...(spec.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    })
  }
  return spawn(bin, args, { ...options, detached: true })
}

async function runForegroundCommand(cmdString, args, options) {
  const { bin, prefixArgs } = splitCommand(cmdString)
  return new Promise((resolve, reject) => {
    const child = spawnCrossPlatform(bin, [...prefixArgs, ...args], {
      ...options,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk.toString() })
    child.stderr.on('data', chunk => { stderr += chunk.toString() })
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) resolve({ stdout, stderr })
      else {
        reject(new Error(
          `Command failed (exit ${code}): ${bin} ${[...prefixArgs, ...args].join(' ')}\n` +
          `STDOUT:\n${redactForLog(stdout)}\nSTDERR:\n${redactForLog(stderr)}`,
        ))
      }
    })
  })
}

function hasExited(child) {
  return !child || child.exitCode !== null || child.signalCode !== null
}

export async function terminateProcessTree(child, graceMs = 5000) {
  if (!child) return true
  const pid = child.pid
  if (!Number.isInteger(pid) || pid <= 0) return true

  const signalGroup = signal => {
    if (process.platform === 'win32') return
    try {
      process.kill(-pid, signal)
    } catch {
      try { child.kill(signal) } catch { /* already gone */ }
    }
  }

  if (hasExited(child)) {
    signalGroup('SIGKILL')
    return true
  }

  const exited = new Promise(resolve => {
    if (hasExited(child)) {
      resolve()
      return
    }
    child.once('exit', () => resolve())
  })

  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/T'], { stdio: 'ignore', windowsHide: true })
    } else {
      signalGroup('SIGTERM')
    }
  } catch {
    // The process can exit between the liveness check and the signal.
  }

  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise(resolve => setTimeout(() => resolve(false), graceMs)),
  ])

  if (!graceful && !hasExited(child)) {
    try {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      } else {
        signalGroup('SIGKILL')
      }
    } catch {
      // Ignore a process that disappeared while we were signalling it.
    }
    await Promise.race([
      exited,
      new Promise(resolve => setTimeout(resolve, 2000)),
    ])
  }

  return hasExited(child)
}

export async function removeIsolatedHome(tempHome, { exited, keep = false } = {}) {
  if (keep || !exited) return false
  await fs.rm(tempHome, { recursive: true, force: true }).catch(() => {})
  return !existsSync(tempHome)
}

export async function releaseIsolatedHome(tempHome, child, { keep = false, graceMs = 5000 } = {}) {
  const exited = await terminateProcessTree(child, graceMs)
  const removed = await removeIsolatedHome(tempHome, { exited, keep })
  return { exited, removed, tempHome }
}

async function readStartupLogs(tempHome) {
  const logsDir = path.join(tempHome, 'logs')
  if (!existsSync(logsDir)) return ''
  try {
    const files = (await fs.readdir(logsDir)).filter(f => f.startsWith('startup-')).sort()
    if (files.length === 0) return ''
    const latest = path.join(logsDir, files[files.length - 1])
    const body = await fs.readFile(latest, 'utf8')
    return `\n--- Startup diagnostic ---\n${redactForLog(body.slice(0, 4000))}`
  } catch {
    return ''
  }
}

function cleanPrintedUrl(raw) {
  return String(raw).trim().replace(/[)\].,;>'"]+$/u, '')
}

export function launchUrlForCookieExchange(raw, expectedPort) {
  let url
  try {
    url = new URL(cleanPrintedUrl(raw))
  } catch {
    throw new Error('Refusing dsh web launch URL: not a URL.')
  }
  if (url.username || url.password) {
    throw new Error('Refusing dsh web launch URL: embedded credentials.')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Refusing dsh web launch URL: protocol must be http or https.')
  }
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error('Refusing dsh web launch URL: host is not a loopback address.')
  }
  const port = url.port || (url.protocol === 'https:' ? '443' : '80')
  if (port !== String(expectedPort)) {
    throw new Error('Refusing dsh web launch URL: port does not match the isolated listener.')
  }
  if (!url.searchParams.get('token')) {
    throw new Error('Refusing dsh web launch URL: missing token query parameter.')
  }
  url.hostname = 'localhost'
  return url.toString()
}

export function selectLaunchUrl(output, expectedPort) {
  const re = /dsh web:\s+(https?:\/\/\S+)/gi
  for (const match of String(output).matchAll(re)) {
    try {
      return launchUrlForCookieExchange(match[1], expectedPort)
    } catch {
      // A later line may be the real loopback launch URL.
    }
  }
  return null
}

export function cleanBaseUrl(launchUrl) {
  const url = new URL(launchUrl)
  url.search = ''
  url.hash = ''
  url.pathname = '/'
  return url.toString()
}

export function recordingStorageState(storageState) {
  const cookies = (storageState?.cookies ?? []).filter(cookie =>
    cookie
    && typeof cookie.name === 'string'
    && cookie.name.startsWith('dsh-auth-')
    && cookie.httpOnly === true
    && typeof cookie.value === 'string'
    && cookie.value.length > 0,
  )
  if (cookies.length === 0) {
    throw new Error('Auth exchange did not set an HttpOnly dsh-auth-* cookie. Refusing to record.')
  }
  return { cookies, origins: [] }
}

export function isPluginOrApiUrl(raw) {
  try {
    const pathname = new URL(raw).pathname
    return pathname === '/api' || pathname.startsWith('/api/')
      || pathname === '/plugins' || pathname.startsWith('/plugins/')
  } catch {
    return false
  }
}

export function urlHasLaunchToken(raw) {
  try {
    return new URL(raw).searchParams.has('token')
  } catch {
    return /[?&#]token=/i.test(String(raw))
  }
}

function spawnDshWeb({ dshCmd, dshCwd, profile, port, patches, env }) {
  const { bin, prefixArgs } = splitCommand(dshCmd)
  const publicUrl = `http://localhost:${port}/`
  const args = [
    ...prefixArgs,
    '--profile', profile,
    ...patches.flatMap(p => ['--patch', p]),
    '--no-open',
    '--host', '127.0.0.1',
    '--port', String(port),
    '--public-url', publicUrl,
    '--trusted-host', `localhost:${port}`,
    '--trusted-host', 'localhost',
  ]
  return spawnCrossPlatform(bin, args, {
    cwd: dshCwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

export function waitForDshReady(child, { port, bootTimeoutMs, tempHome }) {
  return new Promise((resolve, reject) => {
    let combined = ''
    let settled = false
    let timer

    function finish(error, value) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.stdout?.off('data', onChunk)
      child.stderr?.off('data', onChunk)
      child.off('error', onError)
      child.off('close', onClose)
      // Drop the raw launch log once the redacted error or selected URL is built.
      combined = ''
      if (error) reject(error)
      else resolve(value)
    }

    function onChunk(chunk) {
      if (settled) return
      combined += chunk.toString()
      const selected = selectLaunchUrl(combined, port)
      if (selected) {
        finish(null, selected)
        return
      }
      if (combined.length > 200_000) combined = combined.slice(-200_000)
    }

    function onError(err) {
      finish(err)
    }

    async function onClose(code) {
      const diag = tempHome ? await readStartupLogs(tempHome) : ''
      finish(new Error(
        `dsh web exited prematurely with code ${code}.\nOutput:\n${redactForLog(combined)}${diag}`,
      ))
    }

    timer = setTimeout(() => {
      void (async () => {
        const diag = tempHome ? await readStartupLogs(tempHome) : ''
        finish(new Error(
          `Timed out after ${bootTimeoutMs}ms waiting for a loopback "dsh web:" launch URL.\n` +
          `Output so far:\n${redactForLog(combined)}${diag}`,
        ))
      })()
    }, bootTimeoutMs)

    if (!child.stdout || !child.stderr) {
      finish(new Error('dsh web was started without pipes, so its launch URL cannot be read.'))
      return
    }
    child.stdout.on('data', onChunk)
    child.stderr.on('data', onChunk)
    child.once('error', onError)
    child.once('close', onClose)
  })
}

async function loadPlaywrightChromium() {
  for (const specifier of ['playwright', 'playwright-core', '@playwright/test']) {
    try {
      const mod = await import(specifier)
      if (mod.chromium) return mod.chromium
    } catch {
      // Try the next installed package.
    }
  }
  const cwdRequirePaths = [
    path.join(process.cwd(), 'node_modules', 'playwright', 'index.mjs'),
    path.join(process.cwd(), 'node_modules', 'playwright-core', 'index.mjs'),
  ]
  for (const candidate of cwdRequirePaths) {
    if (existsSync(candidate)) {
      const mod = await import(pathToFileURL(candidate).href)
      if (mod.chromium) return mod.chromium
    }
  }
  throw new Error(
    'Playwright was not found. Install playwright before running UI capture.',
  )
}

async function launchBrowserWithFallback(chromium) {
  const attempts = [
    { label: 'bundled-chromium', opts: { headless: true } },
    { label: 'msedge', opts: { headless: true, channel: 'msedge' } },
    { label: 'chrome', opts: { headless: true, channel: 'chrome' } },
  ]
  const errors = []
  for (const attempt of attempts) {
    try {
      const browser = await chromium.launch(attempt.opts)
      return { browser, channelUsed: attempt.label }
    } catch (err) {
      errors.push(`${attempt.label}: ${String(err.message || err).split('\n')[0]}`)
    }
  }
  throw new Error(`Unable to launch any Chromium browser:\n${errors.join('\n')}`)
}

export function prepareBrowserEnv() {
  delete process.env.PWDEBUG
  if (process.env.DEBUG && /playwright|pw:/i.test(process.env.DEBUG)) delete process.env.DEBUG
}

function hasCommand(cmd, checkArgs = ['-version']) {
  const res = spawnSync(cmd, checkArgs, { stdio: 'ignore', windowsHide: true })
  return res.status === 0
}

export async function convertVideoToGifWithFfmpeg(inputVideo, outputGif, { fps = 12, width = 1280, trimStartSec = 0 } = {}) {
  const safeFps = requireInteger('gif fps', fps, { min: 1, max: 60 })
  const safeWidth = requireInteger('gif width', width, { min: 1, max: 4096 })
  if (!Number.isFinite(trimStartSec) || trimStartSec < 0) {
    throw new Error('GIF trim start must be a non-negative number.')
  }
  const palettePath = `${outputGif}.palette.png`
  const trimArgs = trimStartSec > 0 ? ['-ss', trimStartSec.toFixed(2)] : []
  const scaleFilter = `fps=${safeFps},scale='min(${safeWidth},iw)':-1:flags=lanczos`

  try {
    const pass1 = spawnSync(
      'ffmpeg',
      ['-y', ...trimArgs, '-i', inputVideo, '-vf', `${scaleFilter},palettegen=stats_mode=diff:max_colors=256`, palettePath],
      { encoding: 'utf8', windowsHide: true },
    )
    if (pass1.status !== 0) {
      throw new Error(`ffmpeg palettegen failed: ${redactForLog(pass1.stderr || '')}`)
    }
    const pass2 = spawnSync(
      'ffmpeg',
      [
        '-y',
        ...trimArgs,
        '-i', inputVideo,
        '-i', palettePath,
        '-lavfi', `${scaleFilter} [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
        '-loop', '0',
        outputGif,
      ],
      { encoding: 'utf8', windowsHide: true },
    )
    if (pass2.status !== 0) {
      throw new Error(`ffmpeg paletteuse failed: ${redactForLog(pass2.stderr || '')}`)
    }
  } finally {
    await fs.rm(palettePath, { force: true }).catch(() => {})
  }
}

export async function convertFramesToGifFallback(frames, outputGif, { width = 1280 } = {}) {
  if (!frames || frames.length === 0) {
    throw new Error('No frames captured for fallback GIF generation.')
  }
  const safeWidth = requireInteger('gif width', width, { min: 1, max: 4096 })
  const manifestPath = `${outputGif}.frames.json`
  await fs.writeFile(manifestPath, JSON.stringify({ frames, outputGif, width: safeWidth }), 'utf8')

  const pyScript = `
import json, sys
from PIL import Image

cfg = json.load(open(sys.argv[1], 'r', encoding='utf-8'))
frames_meta = cfg['frames']
out_path = cfg['outputGif']
max_w = int(cfg['width'])

pil_frames = []
durations = []
for item in frames_meta:
    im = Image.open(item['path']).convert('RGB')
    if im.width > max_w:
        new_h = max(1, round(im.height * (max_w / im.width)))
        im = im.resize((max_w, new_h), Image.Resampling.LANCZOS)
    q = im.quantize(colors=256, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.NONE)
    pil_frames.append(q)
    durations.append(max(40, int(item.get('durationMs', 500))))

pil_frames[0].save(
    out_path,
    save_all=True,
    append_images=pil_frames[1:],
    duration=durations,
    loop=0,
    optimize=True,
)
`
  try {
    for (const pyBin of ['python3', 'python']) {
      const res = spawnSync(pyBin, ['-c', pyScript, manifestPath], { encoding: 'utf8', windowsHide: true })
      if (res.status === 0 && existsSync(outputGif)) return { encoder: `${pyBin}:Pillow` }
    }
    throw new Error(
      'Neither ffmpeg nor Python Pillow is available on PATH to encode GIF. Install ffmpeg (recommended) or pip install pillow.',
    )
  } finally {
    await fs.rm(manifestPath, { force: true }).catch(() => {})
  }
}

function getGitHeadCommit(cwd) {
  const res = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  })
  return res.status === 0 ? res.stdout.trim() : null
}

export function gitToplevel(cwd) {
  if (!cwd || !existsSync(cwd)) return null
  const res = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  })
  if (res.status !== 0) return null
  const root = res.stdout.trim()
  return root || null
}

export function isInsideDir(parent, target) {
  const root = path.resolve(parent)
  const resolved = path.resolve(target)
  const rel = path.relative(root, resolved)
  if (rel === '') return true
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return false
  return true
}

export function checkoutRootsFor(opts) {
  const roots = []
  for (const cwd of [opts.dshCwd, ...(opts.pluginDirs || [])]) {
    const top = gitToplevel(cwd)
    if (top && !roots.includes(top)) roots.push(top)
  }
  return roots
}

export function assertOutsideCheckouts(target, roots) {
  for (const root of roots) {
    if (root && isInsideDir(root, target)) {
      throw new Error(`Refusing to write QA output inside the git checkout (${root}). Pass --out-dir outside the repository.`)
    }
  }
}

export function resolveArtifactPath(outDir, name, checkoutRoots = []) {
  const outRoot = path.resolve(outDir)
  const resolved = path.isAbsolute(name) ? path.resolve(name) : path.resolve(outRoot, name)
  if (!path.isAbsolute(name)) {
    const rel = path.relative(outRoot, resolved)
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      throw new Error('Refusing an output filename that escapes the output directory.')
    }
  }
  assertOutsideCheckouts(resolved, checkoutRoots)
  return resolved
}

function getGitTrackedDirtyFiles(cwd) {
  const res = spawnSync('git', ['status', '--porcelain'], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  })
  return res.status === 0 ? res.stdout.trim().split('\n').filter(Boolean) : []
}

function clientBundleRelative(pkg) {
  const client = pkg.exports?.['./client']
  if (typeof client === 'string') return client
  if (client && typeof client === 'object') {
    if (typeof client.default === 'string') return client.default
    if (typeof client.import === 'string') return client.import
  }
  return null
}

async function closeQuietly(closable) {
  if (!closable) return
  await Promise.race([
    closable.close().catch(() => {}),
    new Promise(resolve => setTimeout(resolve, 10_000)),
  ])
}

export async function runIsolatedAcceptance(opts) {
  validateOpts(opts)
  const checkoutRoots = checkoutRootsFor(opts)
  assertOutsideCheckouts(opts.outDir, checkoutRoots)
  await fs.mkdir(opts.outDir, { recursive: true })
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-qa-home-'))
  let dshChild = null
  let browser = null
  let context = null

  const diagnostics = {
    pageErrors: [],
    consoleErrors: [],
    httpErrors: [],
  }
  const capturedFrames = []
  const screenshots = []

  try {
    try {
      const rawVideoDir = path.join(tempHome, 'raw-video')
      const framesDir = path.join(tempHome, 'frames')
      await ensureIsolatedHome(tempHome)
      await fs.mkdir(rawVideoDir, { recursive: true })
      await fs.mkdir(framesDir, { recursive: true })
      const env = buildIsolatedEnv(tempHome, opts.allowEnv)

      for (const pluginDir of opts.pluginDirs) {
        const pkgJsonPath = path.join(pluginDir, 'package.json')
        if (!existsSync(pkgJsonPath)) {
          throw new Error(`Plugin directory missing package.json: ${pluginDir}`)
        }
        const pkg = JSON.parse(await fs.readFile(pkgJsonPath, 'utf8'))
        if (typeof pkg.main === 'string' && !existsSync(path.join(pluginDir, pkg.main))) {
          throw new Error(
            `Built entry "${pkg.main}" missing in ${pluginDir}. Run \`pnpm build\` in the plugin checkout first.`,
          )
        }
        const clientEntry = clientBundleRelative(pkg)
        if (clientEntry && !existsSync(path.join(pluginDir, clientEntry))) {
          throw new Error(
            `Built client bundle "${clientEntry}" missing in ${pluginDir}. Run \`pnpm build\` first.`,
          )
        }
        console.log(`[dsh-qa] Linking plugin ${pkg.name} into isolated profile "${opts.profile}".`)
        await runForegroundCommand(
          opts.dshCmd,
          ['plugin', '--profile', opts.profile, 'add', `link:${pluginDir}`],
          { cwd: opts.dshCwd, env },
        )
      }

      const port = await pickFreePort('127.0.0.1')
      console.log(`[dsh-qa] Booting isolated dsh web on localhost:${port}.`)
      dshChild = spawnDshWeb({
        dshCmd: opts.dshCmd,
        dshCwd: opts.dshCwd,
        profile: opts.profile,
        port,
        patches: opts.patches,
        env,
      })
      const launchUrl = await waitForDshReady(dshChild, {
        port,
        bootTimeoutMs: opts.bootTimeoutMs,
        tempHome,
      })
      const baseUrl = cleanBaseUrl(launchUrl)
      console.log(`[dsh-qa] Ready: ${redactTokens(launchUrl)}`)

      prepareBrowserEnv()
      const chromium = await loadPlaywrightChromium()
      const launched = await launchBrowserWithFallback(chromium)
      browser = launched.browser

      const ffmpegAvailable = hasCommand('ffmpeg', ['-version'])
      const authProbeCtx = await browser.newContext({
        viewport: { width: opts.viewportWidth, height: opts.viewportHeight },
        deviceScaleFactor: 2,
        locale: opts.locale,
        colorScheme: opts.colorScheme,
      })
      try {
        const authPage = await authProbeCtx.newPage()
        await authPage.goto(launchUrl, { waitUntil: 'domcontentloaded' })
        await authPage.waitForURL(url => !url.searchParams.has('token'), { timeout: 15_000 })
        if (urlHasLaunchToken(authPage.url())) {
          throw new Error('Security check failed: token query parameter is still visible after auth exchange.')
        }
        const storageState = recordingStorageState(await authProbeCtx.storageState())
        await authProbeCtx.close()

        const videoWidth = Math.min(opts.viewportWidth, opts.gifWidth)
        const videoHeight = Math.max(1, Math.round(opts.viewportHeight * (videoWidth / opts.viewportWidth)))
        context = await browser.newContext({
          storageState,
          viewport: { width: opts.viewportWidth, height: opts.viewportHeight },
          deviceScaleFactor: 2,
          locale: opts.locale,
          colorScheme: opts.colorScheme,
          ...(opts.recordGif && ffmpegAvailable
            ? { recordVideo: { dir: rawVideoDir, size: { width: videoWidth, height: videoHeight } } }
            : {}),
        })

        const page = await context.newPage()
        const recordStartMs = Date.now()

        page.on('pageerror', err => {
          diagnostics.pageErrors.push(redactForLog(err.stack || err.message || String(err)))
        })
        page.on('console', msg => {
          if (msg.type() === 'error') diagnostics.consoleErrors.push(redactForLog(msg.text()))
        })
        page.on('response', res => {
          const status = res.status()
          const url = res.url()
          if (status >= 400 && isPluginOrApiUrl(url)) {
            diagnostics.httpErrors.push({ status, url: redactForLog(url) })
          }
        })

        await page.goto(baseUrl, { waitUntil: 'networkidle', timeout: 30_000 }).catch(async () => {
          await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
        })

        if (urlHasLaunchToken(page.url())) {
          throw new Error('Security check failed: token query parameter is still visible in page URL.')
        }

        await page.waitForFunction(
          () => !document.body || !/loading plugins/i.test(document.body.innerText || ''),
          { timeout: 20_000 },
        ).catch(() => {})

        const uiReadyElapsedSec = Math.max(0, (Date.now() - recordStartMs) / 1000 - 0.15)

        const captureFrame = async (durationMs = 500) => {
          const framePath = path.join(framesDir, `frame-${String(capturedFrames.length).padStart(4, '0')}.png`)
          await page.screenshot({ path: framePath, fullPage: false })
          capturedFrames.push({ path: framePath, durationMs })
          return framePath
        }

        const screenshot = async (name = opts.screenshotName, screenshotOpts = {}) => {
          const outPath = resolveArtifactPath(opts.outDir, name, checkoutRoots)
          await fs.mkdir(path.dirname(outPath), { recursive: true })
          await page.screenshot({ path: outPath, fullPage: false, ...screenshotOpts })
          screenshots.push(outPath)
          return outPath
        }

        const assertClean = () => {
          if (urlHasLaunchToken(page.url())) throw new Error('Token leak detected in current URL.')
          if (diagnostics.pageErrors.length > 0) {
            throw new Error(`Uncaught pageerror(s):\n${diagnostics.pageErrors.join('\n')}`)
          }
          if (diagnostics.httpErrors.length > 0) {
            throw new Error(
              `HTTP error(s) on /api or /plugins:\n` +
              diagnostics.httpErrors.map(e => `${e.status} ${e.url}`).join('\n'),
            )
          }
        }

        if (opts.scenarioPath) {
          const scenarioMod = await import(pathToFileURL(opts.scenarioPath).href)
          const fn = scenarioMod.run || scenarioMod.default
          if (typeof fn !== 'function') {
            throw new Error(`Scenario file ${opts.scenarioPath} must export an async run(ctx) function.`)
          }
          if (opts.recordGif && !ffmpegAvailable) await captureFrame(500)
          await fn({
            page,
            context,
            baseUrl,
            outDir: opts.outDir,
            screenshot,
            captureFrame,
            assertClean,
            diagnostics,
          })
          if (opts.recordGif && !ffmpegAvailable) await captureFrame(opts.settleMs)
          assertClean()
        } else {
          if (opts.waitSelector) {
            await page.locator(opts.waitSelector).first().waitFor({ state: 'visible', timeout: 15_000 })
          }
          if (opts.recordGif && !ffmpegAvailable) await captureFrame(600)
          for (const sel of opts.clickSelectors) {
            await page.locator(sel).first().click()
            await page.waitForTimeout(550)
            if (opts.recordGif && !ffmpegAvailable) await captureFrame(600)
          }
          await page.waitForTimeout(opts.settleMs)
          await screenshot(opts.screenshotName)
          if (opts.recordGif && !ffmpegAvailable) await captureFrame(opts.settleMs)
          assertClean()
        }

        await page.waitForTimeout(opts.settleMs)
        const video = page.video()
        await context.close()
        context = null

        let gifPath = null
        let gifEncoder = null
        if (opts.recordGif) {
          gifPath = resolveArtifactPath(opts.outDir, opts.gifName, checkoutRoots)
          await fs.mkdir(path.dirname(gifPath), { recursive: true })
          if (ffmpegAvailable && video) {
            const webmPath = await video.path()
            await convertVideoToGifWithFfmpeg(webmPath, gifPath, {
              fps: opts.gifFps,
              width: opts.gifWidth,
              trimStartSec: uiReadyElapsedSec,
            })
            gifEncoder = 'ffmpeg:palettegen+paletteuse'
          } else {
            const fb = await convertFramesToGifFallback(capturedFrames, gifPath, { width: opts.gifWidth })
            gifEncoder = fb.encoder
          }
        }

        const report = {
          ok: true,
          commit: getGitHeadCommit(opts.dshCwd),
          browserChannel: launched.channelUsed,
          viewport: `${opts.viewportWidth}x${opts.viewportHeight}`,
          locale: opts.locale,
          colorScheme: opts.colorScheme,
          outDir: opts.outDir,
          screenshots,
          gifPath,
          gifEncoder,
          diagnostics,
          gitDirtyEntries: getGitTrackedDirtyFiles(opts.dshCwd),
        }
        const reportPath = path.join(opts.outDir, 'qa-report.json')
        await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8')
        console.log(`[dsh-qa] Completed. Report written to ${reportPath}`)
        if (gifPath) console.log(`[dsh-qa] GIF saved to ${gifPath} (${gifEncoder})`)
        return report
      } finally {
        await authProbeCtx.close().catch(() => {})
      }
    } catch (err) {
      throw new Error(redactForLog(err?.stack || err?.message || String(err)))
    }
  } finally {
    await closeQuietly(context)
    context = null
    await closeQuietly(browser)
    browser = null
    const released = await releaseIsolatedHome(tempHome, dshChild, { keep: opts.keepTempHome })
    if (!released.exited) {
      console.error(`[dsh-qa] Left temporary DSH_HOME in place because dsh is still running: ${tempHome}`)
    } else if (opts.keepTempHome) {
      console.log(`[dsh-qa] Retained temporary DSH_HOME at ${tempHome}`)
    } else if (!released.removed) {
      console.error(`[dsh-qa] Could not delete temporary DSH_HOME at ${tempHome}`)
    }
  }
}

function invokedAsCli() {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url))
  }
}

if (invokedAsCli()) {
  try {
    const opts = parseArgs(process.argv.slice(2))
    if (opts.help) {
      printHelp()
      process.exit(0)
    }
    await runIsolatedAcceptance(opts)
  } catch (err) {
    console.error(`[dsh-qa] ERROR: ${redactForLog(err?.stack || err?.message || String(err))}`)
    process.exit(1)
  }
}
