import { assertStatus, readFrame } from './response-status-fixture.mjs'
import { exactText, roleWithExactName } from './role-locators.mjs'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { decodeDocumentExportTask } from '../../src/Contracts/document-export-tasks.ts'
import { FrameType, WireHeaders, WireRoutes } from '../../src/Contracts/wire.generated.ts'
import { waitForPathResponse } from './response-wait-fixture.mjs'

export async function exerciseDocumentExportTasks(page, article, revision, visibleBody, pdfEnabled) {
  const open = async () => {
    const summary = exactText(page, 'Document export tasks')
    if (!await summary.isVisible()) await roleWithExactName(page, 'button', 'Inspector').click()
    await summary.click()
    const panel = roleWithExactName(page, 'region', 'Document export tasks')
    await exactText(panel, `Source revision ${revision}`).waitFor()
    return panel
  }
  const receipt = (route) => waitForPathResponse(page, () => route, 'POST')
  const download = async (panel, label, format) => {
    const entry = panel.getByRole('listitem').filter({ hasText: `${label} · Revision ${revision}` })
    await exactText(entry, 'Ready').waitFor()
    const incoming = receipt(WireRoutes.DocumentExportDownload).then(async response => {
      assertStatus(response, 200)
      assert.equal(response.headers()['cache-control'], 'private, no-store')
      assert.equal(response.headers()['x-content-type-options'], 'nosniff')
      return await response.body()
    })
    const fileReady = page.waitForEvent('download')
    const [expected, file] = await Promise.all([incoming, fileReady, roleWithExactName(entry, 'button', 'Download export').click()])
    assert.equal(file.suggestedFilename(), `article.${format}`)
    const bytes = await readFile(await file.path())
    assert.deepEqual(bytes, expected)
    return { bytes, digest: createHash('sha256').update(bytes).digest('hex') }
  }
  async function create(panel, format) {
    const incoming = receipt(WireRoutes.DocumentExportCreate)
    await roleWithExactName(panel, 'button', 'Create export task').click()
    const response = await incoming
    assert(await response.request().headerValue(WireHeaders.CurrentSession))
    const task = await readFrame(response, FrameType.DocumentExportTask, decodeDocumentExportTask)
    assert.deepEqual([task.article, task.revision, task.sourceRevision, task.format], [article, revision, revision, format])
    assert(['queued', 'running', 'succeeded'].includes(task.status))
  }

  let panel = await open()
  await exactText(panel, 'No export tasks for this article.').waitFor()
  await create(panel, 'html')
  await exactText(panel, 'Ready').waitFor()
  const reload = waitForPathResponse(page, () => WireRoutes.DocumentExportTaskList.replace('{id:int}', String(article)))
  await page.reload()
  panel = await open()
  assertStatus(await reload, 200)
  const html = await download(panel, 'HTML', 'html')
  assert(html.bytes.toString('utf8').includes(visibleBody))

  let pdfDigest
  if (pdfEnabled) {
    await panel.getByRole('combobox', { name: 'Export format' }).click()
    await roleWithExactName(page, 'option', 'PDF').click()
    await create(panel, 'pdf')
    const pdf = await download(panel, 'PDF', 'pdf')
    assert.equal(pdf.bytes.subarray(0, 5).toString('ascii'), '%PDF-')
    pdfDigest = pdf.digest
  }
  await exactText(page, 'Document export tasks').click()
  return { htmlDigest: html.digest, pdfDigest }
}
