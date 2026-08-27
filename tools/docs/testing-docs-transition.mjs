import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const testingDocsTransitionPath = 'artifacts/change-contract/testing-docs-transition.json'

function digestText(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function exactKeys(value, expected) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort())
}

export function validateTestingDocsTransitionReceipt(receipt, { sourceText, current, rendered }) {
  const errors = []
  if (!exactKeys(receipt, ['schema', 'issue', 'source', 'output'])) {
    return ['transition receipt must contain exactly schema, issue, source, and output']
  }
  if (receipt.schema !== 'fsusblog.testing-docs-transition.v1') {
    errors.push('transition receipt schema is invalid')
  }
  if (!/^#[1-9][0-9]*$/u.test(receipt.issue ?? '')) {
    errors.push('transition receipt issue must be a GitHub issue reference')
  }
  if (!exactKeys(receipt.source, ['path', 'sha256'])) {
    errors.push('transition receipt source must contain exactly path and sha256')
  } else {
    if (receipt.source.path !== 'tests/matrix.yml') {
      errors.push('transition receipt source path must be tests/matrix.yml')
    }
    if (receipt.source.sha256 !== digestText(sourceText)) {
      errors.push('transition receipt source digest does not match tests/matrix.yml')
    }
  }
  if (!exactKeys(receipt.output, ['path', 'currentSha256', 'expectedSha256'])) {
    errors.push('transition receipt output must contain exactly path, currentSha256, and expectedSha256')
  } else {
    if (receipt.output.path !== 'docs/testing.generated.md') {
      errors.push('transition receipt output path must be docs/testing.generated.md')
    }
    if (receipt.output.currentSha256 !== digestText(current)) {
      errors.push('transition receipt current output digest does not match docs/testing.generated.md')
    }
    if (receipt.output.expectedSha256 !== digestText(rendered)) {
      errors.push('transition receipt expected output digest does not match the rendered matrix')
    }
    if (receipt.output.currentSha256 === receipt.output.expectedSha256) {
      errors.push('transition receipt cannot authorize an already synchronized output')
    }
  }
  return errors
}

export function testingDocsTransitionStatus({ root, outFile, current, rendered }) {
  const transitionFile = path.join(root, testingDocsTransitionPath)
  if (outFile !== path.join(root, 'docs/testing.generated.md') || !fs.existsSync(transitionFile)) {
    return { present: false, errors: [] }
  }
  try {
    const sourceText = fs.readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8')
    const receipt = JSON.parse(fs.readFileSync(transitionFile, 'utf8'))
    return {
      present: true,
      errors: validateTestingDocsTransitionReceipt(receipt, { sourceText, current, rendered })
    }
  } catch (error) {
    return {
      present: true,
      errors: [
        `cannot parse ${testingDocsTransitionPath}: ${error instanceof Error ? error.message : String(error)}`
      ]
    }
  }
}
