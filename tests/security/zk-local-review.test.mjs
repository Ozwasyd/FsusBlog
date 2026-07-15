import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  REQUIRED_LOCAL_ARTIFACT_BINDINGS,
  REQUIRED_LOCAL_REVIEW_SCOPE,
  validateZkLocalReview
} from '../../tools/security/zk-local-review.mjs'

const root = path.resolve(import.meta.dirname, '..', '..')
const committedManifest = path.join(root, 'security/zk/comment-v2-local-review.manifest.json')

test('superseded v3 repository-local review cannot authorize the active v5 source', () => {
  const result = validateZkLocalReview({
    root,
    manifestPath: committedManifest,
    requireComplete: true
  })

  assert.equal(result.ok, false)
  assert.equal(result.status, 'failed')
  assert.match(result.errors.join('\n'), /SHA-256 does not match the file/)
  assert.equal(result.manifest.independent_audit_claimed, false)
  assert.equal(result.manifest.production_authorization, false)
})

test('local review rejects any independent or production authorization claim', () => {
  withReviewFixture((fixture) => {
    fixture.manifest.independent_audit_claimed = true
    fixture.manifest.production_authorization = true
  }, (fixture) => {
    const result = validateFixture(fixture)

    assert.equal(result.ok, false)
    assert.match(result.errors.join('\n'), /independent_audit_claimed=false/)
    assert.match(result.errors.join('\n'), /must not claim production authorization/)
  })
})

test('local review rejects a report changed after manifest binding', () => {
  withReviewFixture(() => {}, (fixture) => {
    writeFileSync(fixture.reportPath, '# Repository-local cryptographic review\ntampered\n')
    const result = validateFixture(fixture)

    assert.equal(result.ok, false)
    assert.match(result.errors.join('\n'), /local review report SHA-256 does not match/)
  })
})

test('local review rejects missing fuzz scope and unresolved high finding', () => {
  withReviewFixture((fixture) => {
    fixture.manifest.scope_results = fixture.manifest.scope_results
      .filter((entry) => entry.id !== 'non_canonical_field_fuzz')
    fixture.manifest.findings.high_open = 1
    fixture.manifest.findings.unresolved = 1
  }, (fixture) => {
    const result = validateFixture(fixture)

    assert.equal(result.ok, false)
    assert.match(result.errors.join('\n'), /scope result is missing: non_canonical_field_fuzz/)
    assert.match(result.errors.join('\n'), /high_open must be 0/)
    assert.match(result.errors.join('\n'), /unresolved must be 0/)
  })
})

test('local review rejects artifact bytes that drift from the manifest or release evidence', () => {
  withReviewFixture(() => {}, (fixture) => {
    const binding = fixture.manifest.artifact_bindings.r1cs_sha256
    writeFileSync(path.join(fixture.dir, binding.path), 'changed-r1cs\n')
    const result = validateZkLocalReview({
      root: fixture.dir,
      manifestPath: fixture.manifestPath,
      expectedVerifyingKeyHash: fixture.verifyingKeyHash,
      expectedBindings: { groth16_r1cs_sha256: hex('f') },
      requireComplete: true
    })

    assert.equal(result.ok, false)
    assert.match(result.errors.join('\n'), /artifact binding r1cs_sha256 SHA-256 does not match/)
    assert.match(result.errors.join('\n'), /groth16_r1cs_sha256 does not match release evidence/)
  })
})

test('local review rejects evidence paths outside the selected review root', () => {
  withReviewFixture((fixture) => {
    fixture.manifest.report.path = '../escaped-report.md'
  }, (fixture) => {
    const result = validateFixture(fixture)

    assert.equal(result.ok, false)
    assert.match(result.errors.join('\n'), /local review report must stay inside the review root/)
  })
})

function validateFixture(fixture) {
  return validateZkLocalReview({
    root: fixture.dir,
    manifestPath: fixture.manifestPath,
    expectedVerifyingKeyHash: fixture.verifyingKeyHash,
    expectedBindings: fixture.expectedBindings,
    requireComplete: true
  })
}

function withReviewFixture(mutate, run) {
  const dir = mkdtempSync(path.join(tmpdir(), 'fsusblog-zk-local-review-'))
  try {
    const verifyingKeyHash = sha256(Buffer.from('fixture-verifying-key\n'))
    const artifactBindings = {}
    const expectedBindings = {}
    for (const [index, id] of REQUIRED_LOCAL_ARTIFACT_BINDINGS.entries()) {
      const file = `artifacts/${id}.bin`
      writeFile(dir, file, id === 'verifying_key_sha256' ? 'fixture-verifying-key\n' : `${id}-${index}\n`)
      const digest = sha256(readFileSync(path.join(dir, file)))
      artifactBindings[id] = { path: file, sha256: digest }
      expectedBindings[id] = digest
    }

    const reportPath = writeFile(
      dir,
      'docs/local-review.md',
      '# Repository-local cryptographic review\n\nLocal fixture report.\n')
    const testPath = writeFile(dir, 'tests/local-review-fixture.test', 'local deterministic fixture\n')
    const manifest = {
      schema: 'fsusblog.zk.local-cryptographic-review.v1',
      circuit_id: 'fsus.anonymous.comment.v3',
      public_input_layout_version: 4,
      status: 'complete',
      review_complete: true,
      assurance_model: 'repository-local-reproducible-review',
      independent_audit_claimed: false,
      external_evidence_required: false,
      production_authorization: false,
      limitations: ['This local fixture is not an independent audit.'],
      verifying_key_hash: verifyingKeyHash,
      report: {
        path: path.relative(dir, reportPath),
        sha256: sha256(readFileSync(reportPath))
      },
      required_scope: [...REQUIRED_LOCAL_REVIEW_SCOPE],
      scope_results: REQUIRED_LOCAL_REVIEW_SCOPE.map((id) => ({
        id,
        status: 'passed',
        evidence: ['tests/local-review-fixture.test']
      })),
      findings: { critical_open: 0, high_open: 0, unresolved: 0 },
      artifact_bindings: artifactBindings,
      test_evidence: [{
        path: path.relative(dir, testPath),
        sha256: sha256(readFileSync(testPath)),
        command: 'node --test tests/local-review-fixture.test',
        covers: [...REQUIRED_LOCAL_REVIEW_SCOPE]
      }]
    }
    mutate({ dir, manifest })
    const manifestPath = writeFile(dir, 'security/local-review.json', `${JSON.stringify(manifest, null, 2)}\n`)

    run({ dir, manifest, manifestPath, reportPath, verifyingKeyHash, expectedBindings })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function writeFile(rootDirectory, relative, contents) {
  const absolute = path.join(rootDirectory, relative)
  const parent = path.dirname(absolute)
  mkdirSync(parent, { recursive: true })
  writeFileSync(absolute, contents)
  return absolute
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function hex(character) {
  return character.repeat(64)
}
