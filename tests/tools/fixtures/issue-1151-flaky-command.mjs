#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const scenario = process.argv[2]
const attempt = Number(process.env.FSUSBLOG_FLAKY_ATTEMPT ?? 1)
const evidenceFile = process.env.FSUSBLOG_FLAKY_ATTEMPT_EVIDENCE
const artifactDirectory = process.env.FSUSBLOG_FLAKY_ATTEMPT_ARTIFACT_DIR

if (!scenario || !evidenceFile || !artifactDirectory) {
  console.error('missing flaky fixture arguments')
  process.exit(2)
}

fs.mkdirSync(artifactDirectory, { recursive: true })
const artifact = path.join(artifactDirectory, `fixture-attempt-${attempt}.json`)
fs.writeFileSync(artifact, `${JSON.stringify({ scenario, attempt })}\n`)

function finish({ status, testIds, failureClass = null, failureKind = null, structured = false }) {
  const evidence = {
    schema: 'fsusblog.ci.flaky-attempt.v1',
    testIds,
    failureClass,
    failureKind,
    artifacts: [artifact]
  }
  if (structured) console.error(`FSUSBLOG_FLAKY_ATTEMPT:${JSON.stringify(evidence)}`)
  else fs.writeFileSync(evidenceFile, `${JSON.stringify(evidence)}\n`)
  process.exit(status)
}

switch (scenario) {
  case 'success':
    finish({ status: 0, testIds: ['fixture:success'] })
    break
  case 'contract-crash':
    finish({ status: 1, testIds: ['contract:login'], failureClass: 'infra', failureKind: 'browser-process-crash' })
    break
  case 'diagnostic-crash-then-pass':
    finish(attempt === 1
      ? { status: 1, testIds: ['visual:home'], failureClass: 'infra', failureKind: 'browser-process-crash' }
      : { status: 0, testIds: ['visual:home'] })
    break
  case 'structured-crash-then-pass':
    finish(attempt === 1
      ? { status: 1, testIds: ['visual:structured'], failureClass: 'browser-process-crash', structured: true }
      : { status: 0, testIds: ['visual:structured'], structured: true })
    break
  case 'diagnostic-assertion':
    finish({ status: 1, testIds: ['visual:article'], failureClass: 'product', failureKind: 'visual-mismatch' })
    break
  case 'diagnostic-disconnect':
    finish({ status: 1, testIds: ['visual:article'], failureClass: 'infra', failureKind: 'browser-disconnect' })
    break
  case 'unstable-topology':
    finish({
      status: 1,
      testIds: [attempt === 1 ? 'visual:first' : 'visual:second'],
      failureClass: 'infra',
      failureKind: 'browser-process-crash'
    })
    break
  default:
    console.error(`unknown scenario: ${scenario}`)
    process.exit(2)
}
