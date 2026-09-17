import test from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkOperationsLayout } from '../../tools/governance/check-operations-layout.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const sourcePolicy = path.join(repositoryRoot, 'tests/governance/operations-layout.json')
const temporaryRoots = []

function write(root, relative, contents = 'fixture\n') {
  const file = path.join(root, relative)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, contents)
}

function listFiles(root, directory = root) {
  const files = []
  for (const entry of readdirSync(directory)) {
    const absolute = path.join(directory, entry)
    if (statSync(absolute).isDirectory()) files.push(...listFiles(root, absolute))
    else files.push(path.relative(root, absolute).replaceAll(path.sep, '/'))
  }
  return files
}

function createFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'fsusblog-operations-layout-'))
  temporaryRoots.push(root)
  const policy = JSON.parse(readFileSync(sourcePolicy, 'utf8'))
  write(root, 'tests/governance/operations-layout.json', `${JSON.stringify(policy, null, 2)}\n`)
  for (const asset of policy.canonicalAssets) {
    const contents = asset === 'ops/docker/docker-compose.development-backend.yml'
      ? 'services:\n  fsusblog.server:\n    volumes:\n      - ../../:/workspace\n'
      : asset.endsWith('.json') ? '{}\n' : 'fixture\n'
    write(root, asset, contents)
  }
  write(root, '.github/CODEOWNERS', `${policy.ownership.codeowners.join('\n')}\n`)
  write(root, '.github/labeler.yml', `"area:deployment":\n${policy.ownership.deploymentLabelGlobs.map((glob) => `  - ${glob}`).join('\n')}\n`)
  return { root, policy }
}

function checkFixture(root) {
  return checkOperationsLayout({ root, files: listFiles(root) })
}

test.after(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true })
})

test('accepts the canonical repository and a minimal owned fixture', () => {
  assert.deepEqual(checkOperationsLayout({ root: repositoryRoot }).errors, [])
  const { root } = createFixture()
  assert.deepEqual(checkFixture(root).errors, [])
})

test('reports a competing deploy root and unowned operations domain together', () => {
  const { root } = createFixture()
  write(root, 'deploy/gateway.conf')
  write(root, 'ops/unknown/template.txt')
  const errors = checkFixture(root).errors
  assert.ok(errors.some((error) => error.includes('forbidden operations path exists: deploy')))
  assert.ok(errors.some((error) => error.includes('unowned operations domain: ops/unknown')))
})

test('rejects misplaced Compose, Dockerfile, gateway, policy, and executable assets', () => {
  const { root } = createFixture()
  write(root, 'misc/docker-compose.rogue.yml')
  write(root, 'misc/Server.Dockerfile')
  write(root, 'misc/production-openresty.conf')
  write(root, 'misc/zero-downtime-resource-policy.json', '{}\n')
  write(root, 'ops/docker/run.sh', '#!/usr/bin/env bash\n')
  const errors = checkFixture(root).errors
  assert.ok(errors.some((error) => error.includes('Compose definition must live under ops/')))
  assert.ok(errors.some((error) => error.includes('production Dockerfile must live under ops/docker/')))
  assert.ok(errors.some((error) => error.includes('gateway template must live under ops/gateway/')))
  assert.ok(errors.some((error) => error.includes('deployment policy must live under config/deployment/')))
  assert.ok(errors.some((error) => error.includes('executable source must stay under tools/deployment or tools/operations')))
})

test('rejects the retired local-proxy pair and stale consumer references', () => {
  const { root } = createFixture()
  write(root, 'ops/docker/docker-compose.local-proxy.yml')
  write(root, 'ops/gateway/local-release-nginx.conf')
  write(root, 'tools/caller.sh', 'compose=ops/docker/docker-compose.local-proxy.yml\n')
  const errors = checkFixture(root).errors
  assert.ok(errors.some((error) => error.includes('forbidden operations path exists: ops/docker/docker-compose.local-proxy.yml')))
  assert.ok(errors.some((error) => error.includes('forbidden operations path exists: ops/gateway/local-release-nginx.conf')))
  assert.ok(errors.some((error) => error.includes('stale operations path reference remains in tools/caller.sh')))
})

test('allows only the documented development workspace mount outside ops', () => {
  const { root } = createFixture()
  write(root, 'ops/docker/docker-compose.production.yml', 'services:\n  app:\n    volumes:\n      - ../../config:/app/config:ro\n')
  const errors = checkFixture(root).errors
  assert.ok(errors.some((error) => error.includes('crosses the operations root without an approved purpose')))

  write(root, 'ops/docker/docker-compose.production.yml', 'services: {}\n')
  assert.deepEqual(checkFixture(root).errors, [])
})

test('requires complete operations ownership and deployment labeling', () => {
  const { root, policy } = createFixture()
  write(root, '.github/CODEOWNERS', `${policy.ownership.codeowners[0]}\n`)
  write(root, '.github/labeler.yml', `"area:deployment":\n  - ${policy.ownership.deploymentLabelGlobs[0]}\n`)
  const errors = checkFixture(root).errors
  assert.ok(errors.some((error) => error.includes('.github/CODEOWNERS does not cover operations asset pattern')))
  assert.ok(errors.some((error) => error.includes('.github/labeler.yml does not cover operations asset pattern')))
})

test('fails closed when the historical local-proxy disposition is weakened', () => {
  const { root } = createFixture()
  const file = path.join(root, 'tests/governance/operations-layout.json')
  const policy = JSON.parse(readFileSync(file, 'utf8'))
  policy.historicalLocalProxy.disposition = 'retained'
  writeFileSync(file, `${JSON.stringify(policy, null, 2)}\n`)
  assert.ok(checkFixture(root).errors.some((error) => error.includes('disposition must be removed-no-supported-caller')))
})
