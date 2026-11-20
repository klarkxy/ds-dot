// Diagnostic: what does the isolated profile show before any interaction?
export async function run({ page, screenshot }) {
  await page.waitForTimeout(2_000)
  await screenshot('diag-start.png')
  const text = await page.locator('body').innerText().catch(() => '')
  const dialogs = await page.locator('[role="dialog"]').count()
  const presentations = await page.locator('[role="presentation"]').count()
  const buttons = await page.locator('button').evaluateAll(nodes => nodes.slice(0, 40).map(node => (node.getAttribute('aria-label') || node.textContent || '').trim().slice(0, 40)))
  console.log('DIAG ' + JSON.stringify({ dialogs, presentations, buttons, text: text.slice(0, 1_500) }))
}
