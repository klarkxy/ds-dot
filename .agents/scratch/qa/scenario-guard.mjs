// Demo scenario for the Dorothy panel PR: the unsaved-edit guard on the Persona page.
// Recorded from the PR's own commit in an isolated `dsh web`; output goes outside the checkout.
export async function run({ page, screenshot, captureFrame, assertClean }) {
  const step = ms => page.waitForTimeout(ms)

  // 0. A fresh profile opens with the preview notice and a get-started modal; close both.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const dialog = page.locator('[role="dialog"]').first()
    if (!(await dialog.count())) break
    const proceed = dialog.getByRole('button', { name: /^(继续|Continue|続行|계속)$/ }).first()
    if (await proceed.count()) await proceed.click()
    else await page.keyboard.press('Escape')
    await step(800)
  }

  // 1. Open Dorothy from the sidebar.
  const entry = page.getByRole('button', { name: /^(桃乐丝|Dorothy|ドロシー)$/ }).first()
  await entry.waitFor({ state: 'visible', timeout: 30_000 })
  await entry.click()
  const chat = page.locator('.dsh-dot-chat').first()
  await chat.waitFor({ state: 'visible', timeout: 20_000 })
  await step(700)
  await captureFrame(600)
  await screenshot('00-panel.png')

  // 2. Settings drawer, then the Persona page.
  await page.locator('.dsh-dot-gear').first().click()
  await step(500)
  const tabs = page.locator('.dsh-dot-drawer-tabs button')
  await tabs.nth(1).click()
  await step(600)
  const persona = page.locator('textarea.dsh-dot-persona-text').first()
  await persona.waitFor({ state: 'visible', timeout: 15_000 })
  await persona.click()
  await persona.fill('（演示）未保存的人设草稿：回答控制在一句话内。')
  await step(700)
  await captureFrame(600)
  await screenshot('01-dirty.png')

  // 3. Switching tabs holds the request: the draft stays and the guard bar appears.
  await tabs.nth(2).click()
  await step(600)
  const bar = page.locator('.dsh-dot-unsaved-bar')
  await bar.waitFor({ state: 'visible', timeout: 5_000 })
  const results = {
    personaStillThere: await page.locator('textarea.dsh-dot-persona-text').first().isVisible(),
    dirtyDot: await page.locator('.dsh-dot-dirty-dot').first().isVisible(),
  }
  await captureFrame(700)
  await screenshot('02-guard-on-tab-switch.png')

  // 4. Keep editing puts the draft back in charge.
  await bar.locator('button').nth(0).click()
  await step(500)
  results.barClearedOnKeepEditing = (await page.locator('.dsh-dot-unsaved-bar').count()) === 0

  // 5. The header gear closes the drawer too, and it honours the same guard.
  await page.locator('.dsh-dot-gear').first().click()
  await step(600)
  await page.locator('.dsh-dot-unsaved-bar').waitFor({ state: 'visible', timeout: 5_000 })
  await captureFrame(700)
  await screenshot('03-guard-on-header-close.png')

  // 6. Discard closes the drawer and drops the draft.
  await page.locator('.dsh-dot-unsaved-bar button').nth(1).click()
  await step(900)
  results.drawerClosed = (await page.locator('.dsh-dot-chat .dsh-dot-drawer').count()) === 0
  await captureFrame(1_300)
  await screenshot('04-discarded.png')

  console.log('SCENARIO_RESULT ' + JSON.stringify(results))
  assertClean()
  return results
}
