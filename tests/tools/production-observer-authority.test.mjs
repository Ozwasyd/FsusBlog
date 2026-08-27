import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { digestCanonical } from '../../tools/test-fixtures/receipt/canonical.mjs'
import { observeAotGeneration } from '../../tools/test-fixtures/observers/aot-generation.mjs'
import { sealDocument } from '../../tools/test-runtime/contract.mjs'
import {
  productionObserverAuthoritySchema,
  publishProductionObserverAuthority,
  readProductionObserverAuthority
} from '../../tools/test-runtime/production-observer-authority.mjs'
import {
  createProductionReceiptRuntimeConfigPort,
  createProductionReceiptRuntimeTopologyPort,
  createProductionReceiptAbsencePort,
  createProductionReceiptUnavailablePort
} from '../../tools/test-runtime/production-receipt-observer-ports.mjs'
import { runtimeIdentity } from './support/runtime-state-fixture.mjs'

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

function sessionReceipt(identity, root) {
  return sealDocument({
    schema: 'fsusblog.runtime-execution-session.v1',
    status: 'ready',
    identity,
    immutableInputsDigest: digestCanonical({ immutable: true }),
    domains: ['fixture.runtime-config'],
    ownedRoot: root,
    handleDigest: digestCanonical({ handles: true }),
    lifecycleEventCount: 1
  })
}

function container(id, image) {
  return {
    id,
    kind: 'container',
    imageId: `sha256:${image.repeat(64)}`,
    serviceVersion: 'test',
    ports: [{ containerPort: id === 'postgres' ? '5432/tcp' : '6379/tcp', hostIp: '127.0.0.1', hostPort: '5000' }],
    resourceLimits: { nanoCpus: 1_000_000_000, memory: 1024, pidsLimit: 8 }
  }
}

test('production observer projector seals config/topology and ports reject ambient or tampered authority', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-observer-authority-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const identity = runtimeIdentity({ runId: 'authority-run', sessionId: 'authority-session' })
  const sessionFile = path.join(root, 'session.json')
  const environmentFile = path.join(root, 'authority.env')
  const keyFile = path.join(root, 'fingerprint.key')
  const serviceFile = path.join(root, 'services.json')
  const outputFile = path.join(root, 'observer-authority.json')
  write(sessionFile, sessionReceipt(identity, root))
  write(keyFile, Buffer.alloc(32, 9))
  write(environmentFile, [
    'FSUSBLOG_TEST_NAMESPACE=authority-run',
    'FSUSBLOG_TEST_RUN_ID=authority-run',
    'FSUSBLOG_DEBUG_BACKEND_PORT=5101',
    'FSUSBLOG_DEBUG_FRONTEND_PORT=5102',
    'FSUSBLOG_RELEASE_PREVIEW_PORT=5103',
    'FSUSBLOG_DEBUG_BACKEND_URL=http://127.0.0.1:5101',
    'FSUSBLOG_DEBUG_FRONTEND_URL=http://127.0.0.1:5102',
    'FSUSBLOG_RELEASE_PREVIEW_URL=http://127.0.0.1:5103',
    'Jwt__SecretKey=never-emit-this-secret'
  ].join('\n') + '\n')
  const services = [container('postgres', 'a'), container('redis', 'b')]
  write(serviceFile, {
    schema: 'fsusblog.test-execution-envelope-services.v1',
    qualificationEligible: true,
    producerId: 'bootstrap',
    runId: identity.runId,
    planned: { services },
    actual: { services },
    admission: 'planned-actual-exact'
  })
  const authority = publishProductionObserverAuthority({
    phase: 'ready', outputFile, sessionReceiptFile: sessionFile,
    environmentFile, fingerprintKeyFile: keyFile, serviceEnvelopeFile: serviceFile
  })
  assert.equal(authority.schema, productionObserverAuthoritySchema)
  assert.equal(JSON.stringify(authority).includes('never-emit-this-secret'), false)
  assert.equal(authority.domains['artifact.public-aot-overlay'].status, 'absent')
  const configPort = createProductionReceiptRuntimeConfigPort({ authorityFile: outputFile, identity })
  const config = await configPort.readResolvedConfig({ handle: { namespace: 'authority-run' } })
  assert.equal(config.readonly, true)
  assert.equal(config.envelopeDigest, identity.envelopeDigest)
  assert.match(config.secrets[0].protectedValue.fingerprint, /^hmac-sha256:/u)
  const topologyRecord = authority.domains['runtime.backend-process'].topology
  const topologyPort = createProductionReceiptRuntimeTopologyPort({ authorityFile: outputFile, identity })
  const topology = await topologyPort.readOwnedTopology({ handle: {
    owner: { domain: 'runtime.backend-process' }, namespace: 'authority-run',
    plannedTopologyDigest: topologyRecord.plannedTopologyDigest
  } })
  assert.deepEqual(topology.services.map(({ role }) => role), ['postgres', 'redis'])
  const unavailable = createProductionReceiptUnavailablePort({
    authorityFile: outputFile, identity, domain: 'artifact.public-aot-overlay', kind: 'aot-generation'
  })
  assert.equal((await unavailable.readAuthority()).status, 'absent')
  const absencePort = createProductionReceiptAbsencePort({ authorityFile: outputFile, identity })
  const absentAot = await observeAotGeneration({
    domain: 'artifact.public-aot-overlay', identity,
    context: {
      handles: {
        'artifact.public-aot-overlay': {
          owner: { ...identity, domain: 'artifact.public-aot-overlay' },
          catalogDigest: identity.catalogDigest,
          namespace: 'authority-run',
          observationStatus: 'absent',
          absenceAuthorityDigest: authority.contentDigest
        }
      },
      ports: { absence: absencePort }
    }
  })
  assert.equal(absentAot.semantic.observationStatus, 'absent')
  const tampered = JSON.parse(fs.readFileSync(outputFile, 'utf8'))
  tampered.phase = 'tampered'
  write(outputFile, tampered)
  assert.throws(() => readProductionObserverAuthority(outputFile, identity), /contentDigest mismatch/)
})

test('production observer authority rejects cross-session and planned/actual service drift', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-observer-reject-'))
  try {
    const identity = runtimeIdentity({ runId: 'reject-run', sessionId: 'reject-session' })
    const sessionFile = path.join(root, 'session.json')
    const environmentFile = path.join(root, 'authority.env')
    const keyFile = path.join(root, 'fingerprint.key')
    const serviceFile = path.join(root, 'services.json')
    write(sessionFile, sessionReceipt(identity, root))
    write(keyFile, Buffer.alloc(32, 3))
    write(environmentFile, [
      'FSUSBLOG_TEST_NAMESPACE=reject-run', 'FSUSBLOG_TEST_RUN_ID=reject-run',
      'FSUSBLOG_DEBUG_BACKEND_PORT=5201', 'FSUSBLOG_DEBUG_FRONTEND_PORT=5202', 'FSUSBLOG_RELEASE_PREVIEW_PORT=5203',
      'FSUSBLOG_DEBUG_BACKEND_URL=http://127.0.0.1:5201',
      'FSUSBLOG_DEBUG_FRONTEND_URL=http://127.0.0.1:5202',
      'FSUSBLOG_RELEASE_PREVIEW_URL=http://127.0.0.1:5203'
    ].join('\n') + '\n')
    write(serviceFile, {
      schema: 'fsusblog.test-execution-envelope-services.v1', qualificationEligible: true,
      runId: identity.runId, admission: 'planned-actual-exact',
      planned: { services: [container('postgres', 'a')] }, actual: { services: [container('redis', 'b')] }
    })
    assert.throws(() => publishProductionObserverAuthority({
      phase: 'ready', outputFile: path.join(root, 'out.json'), sessionReceiptFile: sessionFile,
      environmentFile, fingerprintKeyFile: keyFile, serviceEnvelopeFile: serviceFile
    }), /planned\/actual exact/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
