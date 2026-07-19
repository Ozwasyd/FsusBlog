import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const frontendBuildReadyMarkerSchema = 'fsusblog.local-production.frontend-build-ready.v1'

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.next-${process.pid}-${randomUUID()}`
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`)
  fs.renameSync(temporary, file)
}

export function publishFrontendBuildTerminalMarker({
  file,
  runId,
  buildLayout,
  status,
  reason,
  now = () => new Date()
}) {
  if (!['failure', 'cancelled'].includes(status)) {
    throw new Error(`invalid frontend build terminal status: ${status}`)
  }

  try {
    const existing = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (existing.schema === frontendBuildReadyMarkerSchema
      && existing.status === 'success'
      && existing.schedulerRunId === runId) {
      return { marker: existing, preserved: true }
    }
  } catch {}

  const publishedAt = now().toISOString()
  const marker = {
    schema: frontendBuildReadyMarkerSchema,
    status,
    physicalBundleId: 'build-static',
    producerStepId: 'sync-static-assets',
    schedulerRunId: runId,
    buildLayout,
    reason: String(reason ?? status),
    publishedAt,
    generatedAt: publishedAt
  }
  writeJsonAtomic(file, marker)
  return { marker, preserved: false }
}
