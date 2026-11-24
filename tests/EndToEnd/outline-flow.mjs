import assert from 'node:assert/strict'
import { expect, openWorkspaceDialog } from './browser-authoring-fixture.mjs'
import * as loc from './role-locators.mjs'

const outlineName = 'Article outline'
const firstHeading = '中文 🧭 section'
const repeatedHeading = 'Repeated heading'
const lastHeading = 'Final e\u0301 heading'
const fencedHeading = 'This is code, not a heading'
const desktopViewport = { width: 1366, height: 900 }
const mobileViewport = { width: 375, height: 850 }
const sourceLines = [
  '导言 🧪. Cafe\u0301 with 𝄞.', '', `# ${firstHeading}`, '',
  '```markdown', `# ${fencedHeading}`, '```', '',
  `## ${repeatedHeading}`, '', 'First section body.', '',
  `## ${repeatedHeading}`, '', 'Second section body.', '', `### ${lastHeading}`, '',
]

export async function exerciseArticleOutline({ page, origin, createDraft, screenshot, observations, monitor }) {
  const raw = sourceLines.join('\r\n')
  const renderedSource = sourceLines.join('\n')
  const secondRepeat = renderedSource.lastIndexOf(`## ${repeatedHeading}`)
  const finalHeading = renderedSource.indexOf(`### ${lastHeading}`)
  const firstSection = renderedSource.indexOf(`# ${firstHeading}`)
  assert(raw.lastIndexOf(`## ${repeatedHeading}`) > secondRepeat && secondRepeat > firstSection)
  assert.notEqual(raw.normalize('NFC'), raw, 'Fixture must contain a decomposed source character')
  const first = await createDraft('Outline coordinates A', raw)
  const second = await createDraft('Outline coordinates B', raw)
  assert.notEqual(first.id, second.id)
  assert.equal(first.body, raw)
  assert.equal(second.body, raw)

  const editor = await page.context().newPage()
  monitor(editor, 'outline')
  const editPath = id => `${origin}/admin/articles/edit/${id}`
  const body = () => editor.locator('#article-body')
  const launcher = () => loc.exactButton(editor, 'Outline')
  const moreActions = () => loc.exactButton(editor, 'More actions')
  const desktop = () => loc.roleWithExactName(editor, 'complementary', outlineName)
  const mobile = () => loc.exactDialog(editor, outlineName)
  const heading = (panel, name) => loc.exactButton(panel, name)
  const current = panel => panel.locator('[aria-current="location"]')
  const editorHandles = []

  async function open(panel, compact = false) {
    if (compact) {
      await moreActions().click()
      await loc.exactMenuItem(editor, 'Outline').click()
      await expect(panel).toBeVisible()
      return
    }
    await launcher().focus()
    await editor.keyboard.press('Enter')
    await expect(panel).toBeVisible()
    await expect(launcher()).toHaveAttribute('aria-expanded', 'true')
  }

  async function expectHeadingOrder(panel) {
    const items = panel.getByRole('list').first()
    await expect(items).toBeVisible()
    assert.equal(await items.evaluate(element => element.tagName), 'OL')
    const expected = [firstHeading, repeatedHeading, repeatedHeading, lastHeading]
    const buttons = items.getByRole('button')
    await expect(buttons).toHaveCount(expected.length)
    for (const [index, name] of expected.entries()) await expect(buttons.nth(index)).toHaveAccessibleName(name)
    assert.equal(await buttons.evaluateAll(rows => rows.filter(row => row.tabIndex === 0).length), 1)
    await expect(heading(panel, fencedHeading)).toHaveCount(0)
  }

  async function expectCaret(offset, { focused = false } = {}) {
    await expect(body()).toHaveValue(renderedSource)
    await editor.waitForFunction(position => {
      const field = document.querySelector('#article-body')
      return field instanceof HTMLTextAreaElement && field.selectionStart === position && field.selectionEnd === position
    }, offset)
    if (focused) await expect(body()).toBeFocused()
  }

  async function choose(panel, choice, offset, key = 'Enter') {
    await choice.focus()
    await expect(choice).toBeFocused()
    await editor.keyboard.press(key)
    await expect(panel).toBeHidden()
    await expectCaret(offset, { focused: true })
  }

  async function dismiss(panel, from, expectedCaret, compact = false) {
    const trigger = compact ? moreActions() : launcher()
    const opener = await trigger.elementHandle()
    assert(opener)
    try {
      await from.focus()
      await editor.keyboard.press('Escape')
      await expect(panel).toBeHidden()
      await expect(trigger).toBeFocused()
      if (!compact) await expect(launcher()).toHaveAttribute('aria-expanded', 'false')
      assert.equal(await trigger.evaluate((live, before) => live === before, opener), true)
      await expectCaret(expectedCaret)
    } finally {
      await opener.dispose()
    }
  }

  try {
    await editor.setViewportSize(desktopViewport)
    await editor.goto(editPath(first.id))
    await expect(editor.locator('.el-markdown-editor')).toBeVisible()
    await expect(body()).toBeEditable()
    await expect(body()).toHaveValue(renderedSource)
    const editorA = await body().elementHandle()
    assert(editorA)
    editorHandles.push(editorA)
    const initialWidth = await body().evaluate(element => element.getBoundingClientRect().width)

    const sidebar = desktop()
    await open(sidebar)
    await expectHeadingOrder(sidebar)
    assert.equal(await body().evaluate(element => element.getBoundingClientRect().width), initialWidth)
    const repeated = heading(sidebar, repeatedHeading)
    await expect(repeated).toHaveCount(2)
    await heading(sidebar, lastHeading).focus()
    await editor.keyboard.press('Home')
    await expect(heading(sidebar, firstHeading)).toBeFocused()
    await editor.keyboard.press('ArrowDown')
    await expect(repeated.first()).toBeFocused()
    await editor.keyboard.press('ArrowDown')
    await expect(repeated.nth(1)).toBeFocused()
    await choose(sidebar, repeated.nth(1), secondRepeat)
    await open(sidebar)
    await expect(repeated.nth(1)).toHaveAttribute('aria-current', 'location')
    await expect(current(sidebar)).toHaveCount(1)
    await screenshot(editor, 'article-outline-desktop')
    await dismiss(sidebar, repeated.first(), secondRepeat)

    await editor.setViewportSize(mobileViewport)
    const drawer = mobile()
    await open(drawer, true)
    await expect(sidebar).toBeHidden()
    await expectHeadingOrder(drawer)
    await expect(heading(drawer, repeatedHeading).nth(1)).toHaveAttribute('aria-current', 'location')
    await screenshot(editor, 'article-outline-mobile')
    await dismiss(drawer, heading(drawer, firstHeading), secondRepeat, true)
    await open(drawer, true)
    await choose(drawer, heading(drawer, lastHeading), finalHeading, 'Space')
    const assertSameEditor = async (expected = true) =>
      assert.equal(await body().evaluate((live, original) => live === original, editorA), expected)
    await assertSameEditor()
    assert.equal(await editor.evaluate(() => document.documentElement.scrollWidth), mobileViewport.width)

    // Identical source bytes must not transfer the previous article's heading or editor ownership.
    await editor.setViewportSize(desktopViewport)
    await open(sidebar)
    await expect(heading(sidebar, lastHeading)).toHaveAttribute('aria-current', 'location')
    await choose(sidebar, repeated.nth(1), secondRepeat)
    await open(sidebar)
    await expect(repeated.nth(1)).toHaveAttribute('aria-current', 'location')
    const workspaceDialog = await openWorkspaceDialog(editor)
    await loc.exactLabel(workspaceDialog, 'Article ID').fill(String(second.id))
    await loc.exactButton(workspaceDialog, 'Open in other group').click()
    await expect(editor).toHaveURL(editPath(second.id))
    await expect(sidebar).toBeHidden()
    await expect(body()).toBeEditable()
    await expect(body()).toHaveValue(renderedSource)
    assert.notEqual(await body().evaluate(element => element.selectionStart), secondRepeat)
    await expect(editor.locator('.el-markdown-editor')).toHaveCount(2)
    const editorB = await body().elementHandle()
    assert(editorB)
    editorHandles.push(editorB)
    await assertSameEditor(false)

    await open(sidebar)
    await expectHeadingOrder(sidebar)
    await expect(repeated.nth(1)).not.toHaveAttribute('aria-current', 'location')
    await choose(sidebar, heading(sidebar, firstHeading), firstSection)
    assert.deepEqual(await editorA.evaluate(element => ({ connected: element.isConnected, value: element.value,
      start: element.selectionStart, end: element.selectionEnd })),
    { connected: true, value: renderedSource, start: secondRepeat, end: secondRepeat })
    await loc.exactTab(editor, `${first.title} · Preview`).click()
    await expect(editor).toHaveURL(editPath(first.id))
    await expectCaret(secondRepeat)
    await assertSameEditor()
    await expect(sidebar).toBeVisible()
    await expect(repeated.nth(1)).toHaveAttribute('aria-current', 'location')

    observations.push('The FsusUI article outline ignores fenced pseudo-headings, preserves duplicate heading order and exact CRLF/Unicode caret positions, closes the 375px drawer before transferring focus, and restores the opener on Escape without moving the caret. Byte-identical drafts keep independent active headings and retained editor instances.')
  } catch (error) {
    await screenshot(editor, 'article-outline-failed').catch(() => {})
    throw error
  } finally {
    await Promise.all(editorHandles.map(handle => handle.dispose()))
    await editor.close()
  }
}
