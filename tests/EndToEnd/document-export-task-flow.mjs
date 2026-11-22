import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { decodeFrame } from '../../src/Contracts/aeds.ts'
import { decodeDocumentExportTask } from '../../src/Contracts/document-export-tasks.ts'
import { FrameType, WireHeaders, WireRoutes } from '../../src/Contracts/wire.generated.ts'
import { waitForPathResponse } from './response-wait-fixture.mjs'

export async function exerciseDocumentExportTasks(page, article, revision, visibleBody, pdfEnabled) {
  const open = async () => {
    const summary = page.getByText('Document export tasks', { exact: true })
    if (!await summary.isVisible()) await page.getByRole('button', { name: 'Inspector', exact: true }).click()
    await summary.click()
    const panel = page.getByRole('region', { name: 'Document export tasks', exact: true })
    await panel.getByText(`Source revision ${revision}`, { exact: true }).waitFor()
    return panel
  }
  const receipt = (route) => waitForPathResponse(page, () => route, 'POST')
  const download = async (panel, label, format) => {
    const entry = panel.getByRole('listitem').filter({ hasText: `${label} · Revision ${revision}` })
    await entry.getByText('Ready', { exact: true }).waitFor()
    const incoming = receipt(WireRoutes.DocumentExportDownload)
    const fileReady = page.waitForEvent('download')
    await entry.getByRole('button', { name: 'Download export', exact: true }).click()
    const response = await incoming
    assert.equal(response.status(), 200)
    assert.equal(response.headers()['cache-control'], 'private, no-store')
    assert.equal(response.headers()['x-content-type-options'], 'nosniff')
    const file = await fileReady
    assert.equal(file.suggestedFilename(), `article.${format}`)
    const bytes = await readFile(await file.path())
    assert.deepEqual(bytes, await response.body())
    return { bytes, digest: createHash('sha256').update(bytes).digest('hex') }
  }
  async function create(panel, format) {
    const incoming = receipt(WireRoutes.DocumentExportCreate)
    await panel.getByRole('button', { name: 'Create export task', exact: true }).click()
    const response = await incoming
    assert.equal(response.status(), 200)
    assert(await response.request().headerValue(WireHeaders.CurrentSession))
    const task = decodeDocumentExportTask(decodeFrame(await response.body(), FrameType.DocumentExportTask).payload)
    assert.deepEqual([task.article, task.revision, task.sourceRevision, task.format], [article, revision, revision, format])
    assert(['queued', 'running', 'succeeded'].includes(task.status))
  }

  let panel = await open()
  await panel.getByText('No export tasks for this article.', { exact: true }).waitFor()
  await create(panel, 'html')
  await panel.getByText('Ready', { exact: true }).waitFor()
  const reload = waitForPathResponse(page, () => WireRoutes.DocumentExportTaskList.replace('{id:int}', String(article)))
  await page.reload()
  panel = await open()
  assert.equal((await reload).status(), 200)
  const html = await download(panel, 'HTML', 'html')
  assert(html.bytes.toString('utf8').includes(visibleBody))

  let pdfDigest
  if (pdfEnabled) {
    await panel.getByRole('combobox', { name: 'Export format' }).click()
    await page.getByRole('option', { name: 'PDF', exact: true }).click()
    await create(panel, 'pdf')
    const pdf = await download(panel, 'PDF', 'pdf')
    assert.equal(pdf.bytes.subarray(0, 5).toString('ascii'), '%PDF-')
    pdfDigest = pdf.digest
  }
  await page.getByText('Document export tasks', { exact: true }).click()
  return { htmlDigest: html.digest, pdfDigest }
}
