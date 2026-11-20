// Diagnostic 2: dismiss the preview notice and report what overlays remain.
export async function run({ page, screenshot }) {
  await page.waitForTimeout(1_500)
  const count = async () => ({
    dialogs: await page.locator('[role="dialog"]').count(),
    masks: await page.locator('[class*="mask"]').count(),
    presentations: await page.locator('[role="presentation"]').count(),
  })
  const before = await count()
  await screenshot('d1-before.png')

  const proceed = page.getByRole('button', { name: /^(继续|Continue|続行|계속)$/ }).first()
  const proceedCount = await proceed.count()
  let clicked = false
  if (proceedCount > 0) {
    await proceed.click({ timeout: 10_000 }).then(() => { clicked = true }).catch(() => { clicked = false })
    await page.waitForTimeout(1_200)
  }
  await screenshot('d2-after.png')
  const after = await count()
  const maskVisible = await page.locator('[class*="mask"]').first().isVisible().catch(() => null)
  const overlay = await page.evaluate(() => {
    const node = document.querySelector('[class*="mask"]')
    if (!node) return null
    const style = getComputedStyle(node)
    return { display: style.display, opacity: style.opacity, pointerEvents: style.pointerEvents, parent: node.parentElement?.className ?? '', hidden: node.getAttribute('aria-hidden') }
  })
  console.log('DIAG2 ' + JSON.stringify({ before, proceedCount, clicked, after, maskVisible, overlay }))
}
