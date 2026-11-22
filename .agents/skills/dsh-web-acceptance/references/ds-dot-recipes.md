# DSH Sidebar & Plugin UI Acceptance Recipes (`ds-dot` Example)

This reference provides concrete Playwright scenario templates (`--scenario`) for verifying DeepSeek Harness (`dsh web`) plugins and recording PR-ready GIFs without touching live user state.

## 1. Plugin Sidebar Panel & Composer Acceptance (`ds-dot` / Dorothy)

Save a temporary scenario file outside the git branch (for example `<temp-dir>/qa-dot.mjs`) and pass `--scenario <file> --gif`:

```js
export async function run({ page, screenshot, captureFrame, assertClean }) {
  // 1. Open Dorothy from the left sidebar
  const sidebarEntry = page.getByRole('button', { name: /Dorothy|桃乐丝|ドロシー/i }).first()
  await sidebarEntry.waitFor({ state: 'visible', timeout: 15_000 })
  await sidebarEntry.click()

  // 2. Wait for the scoped plugin root (.dsh-dot-chat) to mount
  const chatRoot = page.locator('.dsh-dot-chat').first()
  await chatRoot.waitFor({ state: 'visible', timeout: 10_000 })
  await page.waitForTimeout(500)
  await captureFrame(600)
  await screenshot('01-dot-panel-open.png')

  // 3. Verify slash quick-actions menu inside the composer
  const composer = chatRoot.locator('textarea, [contenteditable="true"], input[type="text"]').first()
  await composer.click()
  await composer.fill('/')
  await page.waitForTimeout(450)
  await captureFrame(700)
  await screenshot('02-dot-slash-menu.png')

  // 4. Open Settings or Tasks view inside Dorothy's panel and hold for final GIF frame
  const tasksTab = page.getByRole('button', { name: /Tasks|任务|タスク/i }).first()
  if (await tasksTab.isVisible().catch(() => false)) {
    await tasksTab.click()
    await page.waitForTimeout(600)
    await captureFrame(900)
    await screenshot('03-dot-tasks-view.png')
  }

  // 5. Fail fast if any uncaught exception, /api 4xx/5xx, or ?token= leak occurred
  assertClean()
}
```

Run from the plugin checkout after `pnpm build`:

```sh
node <skill-dir>/scripts/dsh-qa-harness.js \
  --plugin . \
  --scenario <temp-dir>/qa-dot.mjs \
  --viewport 1440x900 \
  --locale zh-CN \
  --gif-name dot-ui-check.gif \
  --out-dir <temp-dir>/dsh-dot-qa
```

## 2. Multi-Locale & Theme Sweep (`zh`, `en`, `ja` + `light` / `dark`)

When a frontend PR modifies `src/ui-copy.ts`, `locale/*.json`, or theme-sensitive CSS variables, run short isolated sweeps across locales and color schemes:

```sh
for loc in zh-CN en-US ja-JP; do
  node <skill-dir>/scripts/dsh-qa-harness.js \
    --plugin . \
    --locale "$loc" \
    --wait-selector ".dsh-dot-chat" \
    --click "button:has-text('Dorothy'), button:has-text('桃乐丝'), button:has-text('ドロシー')" \
    --screenshot-name "dot-${loc}-light.png" \
    --out-dir "<temp-dir>/${loc}"
done
```

For dark mode verification, pass `--color-scheme dark`.

## 3. PR Body Requirements Checklist (`ds-dot` `CONTRIBUTING.md`)

When preparing a pull request touching `src/**/*.tsx` (non-spec), `src/ui-copy.ts`, `locale/*.json`, or `icon.svg`:

1. Record the real running `dsh web` interface built from the PR's exact `HEAD` commit (`git rev-parse --short HEAD`). Never substitute a static screenshot, HTML mockup, or synthetic animation for a frontend PR GIF.

2. Cover both the user action (click, input, toggle, drawer navigation) and the resulting UI state on screen, pausing `1.0s - 1.5s` on the end state so reviewers can read it clearly.

3. Confirm zero secrets appear on screen: isolated `DSH_HOME`, no `?token=` in any address bar, no API keys in Settings, and no personal file paths or session titles.

4. Keep `.gif` and `.png` files out of the git branch (`git status --porcelain` must stay clean). Upload or embed the external image URL in the PR body and explicitly state the commit SHA recorded (for example: `Recorded on commit a1b2c3d in isolated dsh web`).
