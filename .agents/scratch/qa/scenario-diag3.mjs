// Diagnostic 3: dump the onboarding dialogs so the demo scenario can close them reliably.
export async function run({ page, screenshot }) {
  await page.waitForTimeout(1_500)
  const dump = async label => {
    const dialog = page.locator('[role="dialog"]').first()
    if (!(await dialog.count())) return { label, dialog: null }
    const html = await dialog.evaluate(node => node.outerHTML.replace(/\s+/g, ' ').slice(0, 2_000))
    return { label, html }
  }
  const steps = []
  // First dialog: the preview notice.
  const proceed = page.getByRole('button', { name: /^(继续|Continue|続行|계속)$/ }).first()
  if (await proceed.count()) { await proceed.click(); await page.waitForTimeout(900) }
  steps.push(await dump('after-continue'))

  // Second dialog: the get-started modal; try Escape, then its close button.
  await page.keyboard.press('Escape')
  await page.waitForTimeout(700)
  steps.push(await dump('after-escape'))
  if (await page.locator('[role="dialog"]').count()) {
    const labelled = await page.locator('[role="dialog"] button[aria-label]').evaluateAll(nodes => nodes.map(node => ({ label: node.getAttribute('aria-label'), cls: node.className.slice(0, 60) })))
    steps.push({ label: 'labelled-buttons', labelled })
    await screenshot('d3-second-dialog.png')
  }
  console.log('DIAG3 ' + JSON.stringify(steps))
}
