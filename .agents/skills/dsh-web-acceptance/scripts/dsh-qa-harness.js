#!/usr/bin/env node
/**
 * Isolated DeepSeek Harness (dsh web) QA, Screenshot & GIF Runner
 *
 * Cross-platform (Windows / macOS / Linux, Node >= 22).
 * Isolates DSH_HOME, binds a free loopback port with localhost authority,
 * exchanges the ephemeral ?token= launch URL for an HttpOnly cookie, verifies
 * zero token leakage in page URLs/logs, runs Playwright UI assertions, exports
 * PNG screenshots + two-pass palette GIFs (with Pillow / pure-JS fallbacks),
 * and tears down the process tree BEFORE deleting DSH_HOME (avoiding dsh-hmr
 * Chokidar busy-loop when profile directories vanish mid-run).
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'

const DEFAULT_SENSITIVE_ENV_PATTERNS = [
  /^DEEPSEEK_API_KEY$/i,
  /^OPENAI_API_KEY$/i,
  /^ANTHROPIC_API_KEY$/i,
  /^GEMINI_API_KEY$/i,
  /^GOOGLE_API_KEY$/i,
  /^NPM_TOKEN$/i,
  /^GITHUB_TOKEN$/i,
  /^GH_TOKEN$/i,
]

function redactTokens(input) {
  if (typeof input !== 'string') return ''
  return input.replace(/([?&]token=)[^&\s#]+/gi, '$1<REDACTED>')
}

function parseArgs(argv) {
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
      opts.viewportWidth = Number(m[1])
      opts.viewportHeight = Number(m[2])
    } else if (arg === '--gif') opts.recordGif = true
    else if (arg === '--gif-name') {
      opts.recordGif = true
      opts.gifName = next()
    } else if (arg === '--gif-width') opts.gifWidth = Number(next())
    else if (arg === '--gif-fps') opts.gifFps = Number(next())
    else if (arg === '--screenshot-name') opts.screenshotName = next()
    else if (arg === '--locale') opts.locale = next()
    else if (arg === '--color-scheme') opts.colorScheme = next()
    else if (arg === '--wait-selector') opts.waitSelector = next()
    else if (arg === '--click') opts.clickSelectors.push(next())
    else if (arg === '--settle-ms') opts.settleMs = Number(next())
    else if (arg === '--boot-timeout-ms') opts.bootTimeoutMs = Number(next())
    else if (arg === '--allow-env') opts.allowEnv.push(next())
    else if (arg === '--keep-temp-home') opts.keepTempHome = true
    else throw new Error(`Unknown option: ${arg}`)
  }
  return opts
}

function printHelp() {
  console.log(`Usage: node dsh-qa-harness.js [options]

Spins up an isolated DeepSeek Harness Web instance (temporary DSH_HOME + free
loopback port), mounts local plugins via link:, runs Playwright acceptance,
captures screenshots and high-DPI GIFs, and cleanly tears down processes before
removing DSH_HOME.

Options:
  --plugin <dir>            Link built local plugin checkout (repeatable)
  --patch <yml>             Apply extra Cordis --patch overlay (repeatable)
  --scenario <file.mjs>     Custom Playwright scenario module exporting run(ctx)
  --out-dir <dir>           Output folder (keep outside git branch!)
  --viewport <WxH>          Browser viewport, default 1440x900
  --locale <bcp47>          Browser locale, default zh-CN
  --color-scheme <scheme>   light or dark, default light
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
  --allow-env <VAR>         Keep specific API key env var in child env (repeatable)
  --boot-timeout-ms <ms>    Startup readiness timeout (default: 45000)
  --keep-temp-home          Retain temporary DSH_HOME on disk for debugging
  -h, --help                Show this help text
`)
}

export async function pickFreePort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, host, () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(err => (err ? reject(err) : resolve(port)))
    })
  })
}

function buildIsolatedEnv(tempHome, allowEnv = []) {
  const allowSet = new Set(allowEnv.map(k => k.toUpperCase()))
  const env = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue
    if (allowSet.has(k.toUpperCase())) {
      env[k] = v
      continue
    }
    if (DEFAULT_SENSITIVE_ENV_PATTERNS.some(rx => rx.test(k))) continue
    env[k] = v
  }
  env.DSH_HOME = tempHome
  env.DSH_TELEMETRY_DISABLED = '1'
  env.DSH_TELEMETRY_MODE = 'DISABLED'
  env.NO_COLOR = '1'
  return env
}

function splitCommand(cmdString) {
  const parts = cmdString.trim().split(/\s+/).filter(Boolean)
  return { bin: parts[0], prefixArgs: parts.slice(1) }
}

function spawnCrossPlatform(bin, args, options) {
  if (process.platform === 'win32') {
    return spawn(bin, args, { ...options, shell: true, windowsHide: true })
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
          `STDOUT:\n${redactTokens(stdout)}\nSTDERR:\n${redactTokens(stderr)}`
        ))
      }
    })
  })
}

export async function terminateProcessTree(child, graceMs = 5000) {
  if (!child || child.exitCode !== null) return
  const pid = child.pid
  const exited = new Promise(resolve => {
    child.once('close', () => resolve())
    child.once('exit', () => resolve())
  })

  try {
    if (process.platform === 'win32' && pid) {
      spawnSync('taskkill', ['/PID', String(pid), '/T'], { stdio: 'ignore', windowsHide: true })
    } else if (pid) {
      try {
        process.kill(-pid, 'SIGTERM')
      } catch {
        child.kill('SIGTERM')
      }
    }
  } catch {
    // Ignore if already exited
  }

  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise(resolve => setTimeout(() => resolve(false), graceMs)),
  ])

  if (!graceful && child.exitCode === null && pid) {
    try {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      } else {
        try {
          process.kill(-pid, 'SIGKILL')
        } catch {
          child.kill('SIGKILL')
        }
      }
    } catch {
      // Ignore
    }
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 2000))])
  }
}

async function readStartupLogs(tempHome) {
  const logsDir = path.join(tempHome, 'logs')
  if (!existsSync(logsDir)) return ''
  try {
    const files = (await fs.readdir(logsDir)).filter(f => f.startsWith('startup-')).sort()
    if (files.length === 0) return ''
    const latest = path.join(logsDir, files[files.length - 1])
    const body = await fs.readFile(latest, 'utf8')
    return `\n--- Startup Diagnostic (${latest}) ---\n${redactTokens(body.slice(0, 4000))}`
  } catch {
    return ''
  }
}

async function bootDshWeb({ dshCmd, dshCwd, profile, port, patches, env, bootTimeoutMs }) {
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

  const child = spawnCrossPlatform(bin, args, {
    cwd: dshCwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let combinedOut = ''
  const entryUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(async () => {
      const diag = await readStartupLogs(env.DSH_HOME)
      reject(new Error(
        `Timed out after ${bootTimeoutMs}ms waiting for "dsh web:" readiness URL.\n` +
        `Output so far:\n${redactTokens(combinedOut)}${diag}`
      ))
    }, bootTimeoutMs)

    const onChunk = chunk => {
      combinedOut += chunk.toString()
      const match = /dsh web:\s+(https?:\/\/\S+)/i.exec(combinedOut)
      if (match) {
        clearTimeout(timer)
        resolve(match[1].trim())
      }
    }

    child.stdout.on('data', onChunk)
    child.stderr.on('data', onChunk)
    child.once('error', err => {
      clearTimeout(timer)
      reject(err)
    })
    child.once('close', async code => {
      clearTimeout(timer)
      const diag = await readStartupLogs(env.DSH_HOME)
      reject(new Error(
        `dsh web exited prematurely with code ${code}.\n` +
        `Output:\n${redactTokens(combinedOut)}${diag}`
      ))
    })
  })

  return { child, entryUrl, baseUrl: publicUrl }
}

async function loadPlaywrightChromium() {
  for (const specifier of ['playwright', 'playwright-core', '@playwright/test']) {
    try {
      const mod = await import(specifier)
      if (mod.chromium) return mod.chromium
    } catch {
      // Try next
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
    'Playwright was not found. Install playwright (e.g. `pnpm dlx playwright --version` or add playwright as a devDependency / global tool) before running UI capture.'
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
      errors.push(`${attempt.label}: ${err.message.split('\n')[0]}`)
    }
  }
  throw new Error(`Unable to launch any Chromium browser:\n${errors.join('\n')}`)
}

function hasCommand(cmd, checkArgs = ['-version']) {
  const res = spawnSync(cmd, checkArgs, { stdio: 'ignore', windowsHide: true })
  return res.status === 0
}

export async function convertVideoToGifWithFfmpeg(inputVideo, outputGif, { fps = 12, width = 1280, trimStartSec = 0 } = {}) {
  const palettePath = `${outputGif}.palette.png`
  const trimArgs = trimStartSec > 0 ? ['-ss', trimStartSec.toFixed(2)] : []
  const scaleFilter = `fps=${fps},scale='min(${width},iw)':-1:flags=lanczos`

  try {
    const pass1 = spawnSync(
      'ffmpeg',
      ['-y', ...trimArgs, '-i', inputVideo, '-vf', `${scaleFilter},palettegen=stats_mode=diff:max_colors=256`, palettePath],
      { encoding: 'utf8', windowsHide: true }
    )
    if (pass1.status !== 0) {
      throw new Error(`ffmpeg palettegen failed: ${pass1.stderr}`)
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
      { encoding: 'utf8', windowsHide: true }
    )
    if (pass2.status !== 0) {
      throw new Error(`ffmpeg paletteuse failed: ${pass2.stderr}`)
    }
  } finally {
    await fs.rm(palettePath, { force: true }).catch(() => {})
  }
}

export async function convertFramesToGifFallback(frames, outputGif, { width = 1280 } = {}) {
  if (!frames || frames.length === 0) {
    throw new Error('No frames captured for fallback GIF generation.')
  }
  const manifestPath = `${outputGif}.frames.json`
  await fs.writeFile(manifestPath, JSON.stringify({ frames, outputGif, width }), 'utf8')

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
      'Neither `ffmpeg` nor Python `Pillow` is available on PATH to encode GIF. Install ffmpeg (recommended) or `pip install pillow`.'
    )
  } finally {
    await fs.rm(manifestPath, { force: true }).catch(() => {})
  }
}

function getGitHeadCommit(cwd) {
  const res = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd, encoding: 'utf8', windowsHide: true })
  return res.status === 0 ? res.stdout.trim() : null
}

function getGitTrackedDirtyFiles(cwd) {
  const res = spawnSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8', windowsHide: true })
  return res.status === 0 ? res.stdout.trim().split('\n').filter(Boolean) : []
}

export async function runIsolatedAcceptance(opts) {
  await fs.mkdir(opts.outDir, { recursive: true })
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-qa-home-'))
  const rawVideoDir = path.join(tempHome, 'raw-video')
  const framesDir = path.join(tempHome, 'frames')
  await fs.mkdir(rawVideoDir, { recursive: true })
  await fs.mkdir(framesDir, { recursive: true })

  const env = buildIsolatedEnv(tempHome, opts.allowEnv)
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
    // 1. Validate & link any local plugin checkouts into isolated DSH_HOME
    for (const pluginDir of opts.pluginDirs) {
      const pkgJsonPath = path.join(pluginDir, 'package.json')
      if (!existsSync(pkgJsonPath)) {
        throw new Error(`Plugin directory missing package.json: ${pluginDir}`)
      }
      const pkg = JSON.parse(await fs.readFile(pkgJsonPath, 'utf8'))
      if (pkg.main && !existsSync(path.join(pluginDir, pkg.main))) {
        throw new Error(
          `Built entry "${pkg.main}" missing in ${pluginDir}. Run \`pnpm build\` in the plugin checkout first.`
        )
      }
      if (pkg.exports?.['./client']?.default && !existsSync(path.join(pluginDir, pkg.exports['./client'].default))) {
        throw new Error(
          `Built client bundle "${pkg.exports['./client'].default}" missing in ${pluginDir}. Run \`pnpm build\` first.`
        )
      }
      console.log(`[dsh-qa] Linking plugin ${pkg.name} (${pluginDir}) into isolated profile "${opts.profile}"...`)
      await runForegroundCommand(
        opts.dshCmd,
        ['plugin', '--profile', opts.profile, 'add', `link:${pluginDir}`],
        { cwd: opts.dshCwd, env }
      )
    }

    // 2. Allocate free loopback port & boot isolated dsh web
    const port = await pickFreePort('127.0.0.1')
    console.log(`[dsh-qa] Booting isolated dsh web on localhost:${port} (DSH_HOME=${tempHome})...`)
    const booted = await bootDshWeb({
      dshCmd: opts.dshCmd,
      dshCwd: opts.dshCwd,
      profile: opts.profile,
      port,
      patches: opts.patches,
      env,
      bootTimeoutMs: opts.bootTimeoutMs,
    })
    dshChild = booted.child
    console.log(`[dsh-qa] Ready: ${redactTokens(booted.entryUrl)}`)

    // 3. Launch headless Chromium & exchange token before recording
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
    const authPage = await authProbeCtx.newPage()
    await authPage.goto(booted.entryUrl, { waitUntil: 'domcontentloaded' })
    await authPage.waitForURL(url => !url.searchParams.has('token'), { timeout: 15_000 })
    const storageState = await authProbeCtx.storageState()
    await authProbeCtx.close()

    // Create fresh recording context pre-authenticated via HttpOnly session cookie
    // so ?token=... NEVER appears in any recorded frame!
    const videoWidth = Math.min(opts.viewportWidth, opts.gifWidth)
    const videoHeight = Math.round(opts.viewportHeight * (videoWidth / opts.viewportWidth))
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
      diagnostics.pageErrors.push(redactTokens(err.stack || err.message || String(err)))
    })
    page.on('console', msg => {
      if (msg.type() === 'error') {
        diagnostics.consoleErrors.push(redactTokens(msg.text()))
      }
    })
    page.on('response', res => {
      const status = res.status()
      const url = res.url()
      if (status >= 400 && (url.includes('/api/') || url.includes('/plugins'))) {
        diagnostics.httpErrors.push({ status, url: redactTokens(url) })
      }
    })

    await page.goto(booted.baseUrl, { waitUntil: 'networkidle', timeout: 30_000 }).catch(async () => {
      await page.goto(booted.baseUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    })

    if (new URL(page.url()).searchParams.has('token')) {
      throw new Error('Security check failed: token query parameter is still visible in page URL.')
    }

    // Wait for DSH boot placeholder ("Loading plugins") to clear
    await page.waitForFunction(
      () => !document.body || !/loading plugins/i.test(document.body.innerText || ''),
      { timeout: 20_000 }
    ).catch(() => {})

    const uiReadyElapsedSec = Math.max(0, (Date.now() - recordStartMs) / 1000 - 0.15)

    const captureFrame = async (durationMs = 500) => {
      const framePath = path.join(framesDir, `frame-${String(capturedFrames.length).padStart(4, '0')}.png`)
      await page.screenshot({ path: framePath, fullPage: false })
      capturedFrames.push({ path: framePath, durationMs })
      return framePath
    }

    const screenshot = async (name = opts.screenshotName, screenshotOpts = {}) => {
      const outPath = path.isAbsolute(name) ? name : path.join(opts.outDir, name)
      await fs.mkdir(path.dirname(outPath), { recursive: true })
      await page.screenshot({ path: outPath, fullPage: false, ...screenshotOpts })
      screenshots.push(outPath)
      return outPath
    }

    const assertClean = () => {
      if (new URL(page.url()).searchParams.has('token')) {
        throw new Error('Token leak detected in current URL.')
      }
      if (diagnostics.pageErrors.length > 0) {
        throw new Error(`Uncaught pageerror(s):\n${diagnostics.pageErrors.join('\n')}`)
      }
      if (diagnostics.httpErrors.length > 0) {
        throw new Error(
          `HTTP error(s) on /api or /plugins:\n` +
          diagnostics.httpErrors.map(e => `${e.status} ${e.url}`).join('\n')
        )
      }
    }

    // 4. Execute custom scenario or built-in selector steps
    if (opts.scenarioPath) {
      const scenarioMod = await import(pathToFileURL(opts.scenarioPath).href)
      const fn = scenarioMod.run || scenarioMod.default
      if (typeof fn !== 'function') {
        throw new Error(`Scenario file ${opts.scenarioPath} must export an async \`run(ctx)\` function.`)
      }
      if (opts.recordGif && !ffmpegAvailable) await captureFrame(500)
      await fn({
        page,
        context,
        baseUrl: booted.baseUrl,
        outDir: opts.outDir,
        screenshot,
        captureFrame,
        assertClean,
        diagnostics,
      })
      if (opts.recordGif && !ffmpegAvailable) await captureFrame(opts.settleMs)
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

    // 5. Encode GIF if requested
    let gifPath = null
    let gifEncoder = null
    if (opts.recordGif) {
      gifPath = path.isAbsolute(opts.gifName) ? opts.gifName : path.join(opts.outDir, opts.gifName)
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

    const gitCommit = getGitHeadCommit(opts.dshCwd)
    const report = {
      ok: true,
      commit: gitCommit,
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
    console.log(`[dsh-qa] Completed! Report written to ${reportPath}`)
    if (gifPath) console.log(`[dsh-qa] GIF saved to ${gifPath} (${gifEncoder})`)
    return report
  } finally {
    // STRICT TEARDOWN ORDER:
    // 1. Close browser context & browser
    if (context) await context.close().catch(() => {})
    if (browser) await browser.close().catch(() => {})
    // 2. Terminate dsh web process tree FIRST and wait for full exit
    if (dshChild) {
      await terminateProcessTree(dshChild)
    }
    // 3. ONLY THEN remove temporary DSH_HOME (prevents dsh-hmr Chokidar CPU spin)
    if (!opts.keepTempHome) {
      await fs.rm(tempHome, { recursive: true, force: true }).catch(() => {})
    } else {
      console.log(`[dsh-qa] Retained temporary DSH_HOME at ${tempHome}`)
    }
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
if (isMain) {
  try {
    const opts = parseArgs(process.argv.slice(2))
    if (opts.help) {
      printHelp()
      process.exit(0)
    }
    await runIsolatedAcceptance(opts)
  } catch (err) {
    console.error(`[dsh-qa] ERROR: ${redactTokens(err?.stack || err?.message || String(err))}`)
    process.exit(1)
  }
}
