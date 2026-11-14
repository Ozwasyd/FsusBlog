import assert from 'node:assert/strict'

export async function exerciseCanvasReferences({ page, origin, createDraft, screenshot, observations }) {
  const viewportBefore = page.viewportSize()
  const title = `Canvas reference history ${Date.now()}`
  const articleTitle = 'Source coordinates <title-literal>'
  const sourceBody = '# Planning heading ^planning\n\nA paragraph with <tag> ^detail\n\n' +
    'Duplicate first ^twice\n\nDuplicate second ^twice\n'
  const article = await createDraft(articleTitle, sourceBody)
  const button = name => page.getByRole('button', { name, exact: true })
  const outline = () => page.getByRole('region', { name: 'Canvas outline' })
  const viewport = () => page.getByRole('region', { name: 'Interactive Canvas Viewport' })
  const preview = () => page.getByRole('region', { name: 'Canvas reference preview' })
  const resolved = () => preview().getByRole('status').filter({ hasText: 'Reference resolved.' })

  async function add(kind, anchor, pinned) {
    await button('Add reference').click()
    const dialog = page.getByRole('dialog', { name: 'Add node' })
    await dialog.getByLabel('Reference type').selectOption(kind)
    await dialog.getByLabel('Article ID', { exact: true }).fill(String(article.id))
    await dialog.getByLabel('Anchor ID').fill(anchor)
    if (pinned) await dialog.getByLabel('Pinned revision (optional)').fill(String(pinned))
    await dialog.getByRole('button', { name: 'Save node', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    const nodeName = kind === 'heading-reference' ? 'Heading' : 'Block'
    await outline().getByRole('button', { name: `${nodeName} reference ${article.id}`, exact: true }).first().waitFor()
  }

  try {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto(origin + '/user/manage/canvas')
    await button('New Canvas').click()
    const create = page.getByRole('dialog', { name: 'New Canvas' })
    await create.getByLabel('Canvas title').fill(title)
    await create.getByRole('button', { name: 'Save Canvas', exact: true }).click()
    const heading = page.getByRole('heading', { name: title, exact: true })
    await heading.waitFor()
    await button('Outline').click()

    await add('heading-reference', 'planning')
    await outline().getByRole('button', { name: `Heading reference ${article.id}`, exact: true }).click()
    await preview().getByRole('button', { name: 'Resolve reference', exact: true }).click()
    await resolved().waitFor()
    await preview().getByRole('heading', { name: /Source coordinates/ }).waitFor()
    await preview().getByText(`Resolved revision ${article.revision}`, { exact: true }).waitFor()
    await preview().getByText(/Planning heading/).waitFor()

    await add('block-reference', 'twice')
    await outline().getByRole('button', { name: `Block reference ${article.id}`, exact: true }).click()
    assert.equal(await resolved().count(), 0)
    await preview().getByRole('button', { name: 'Resolve reference', exact: true }).click()
    await preview().getByRole('status').filter({ hasText: 'The anchor is ambiguous at this revision.' }).waitFor()
    assert.equal(await preview().getByText(/Duplicate (first|second)/).count(), 0)

    // Switch the same page to the compact viewport, then select the actual spatial node.
    await page.setViewportSize({ width: 375, height: 850 })
    await add('block-reference', 'detail', article.revision)
    await button('Outline').click()
    await viewport().getByRole('button', { name: /Article #\d+ · detail · Revision/ }).click()
    await preview().getByRole('button', { name: 'Resolve reference', exact: true }).click()
    await resolved().waitFor()
    await preview().getByText(`Pinned revision ${article.revision}`, { exact: true }).waitFor()
    await preview().getByText(/A paragraph with ‹tag›/).waitFor()
    assert.equal(await preview().locator('tag, title-literal').count(), 0)
    await screenshot(page, 'canvas-reference-mobile')

    await button('Zoom in').click()
    await page.waitForFunction(() => {
      const region = document.querySelector('[aria-label="Canvas reference preview"]')
      return region && !region.textContent.includes('Reference resolved.')
    })
    await page.reload()
    await heading.waitFor()
    assert.equal(await preview().count(), 0)
    observations.push('Canvas resolves a heading and a pinned block through the author-only reference API, reports ambiguity, and clears previews after viewport changes and reload.')
  } catch (error) {
    await screenshot(page, 'canvas-reference-failed').catch(() => {})
    throw error
  } finally {
    if (viewportBefore) await page.setViewportSize(viewportBefore)
  }
}
