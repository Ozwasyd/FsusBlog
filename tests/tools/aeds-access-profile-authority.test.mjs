import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'

const root = resolve(import.meta.dirname, '../..')

test('AEDS access profile authority declares required consumers and generated surfaces', async () => {
  const authority = JSON.parse(await readFile(
    resolve(root, 'src/shared/Contracts/Validation/aeds-access-profiles.json'),
    'utf8'
  ))
  assert.equal(authority.wireProtocolVersion, 2)
  assert.equal(authority.frameHeaderBytes, 16)
  assert.deepEqual(
    authority.profiles.map((profile) => profile.id),
    [
      'publicArticleListCard',
      'publicFilterArchiveItem',
      'notificationArticlePreview',
      'articleSearchRankingCandidate'
    ]
  )
  assert.deepEqual(authority.profiles[0].supportedRecordBytes, [76, 100])
  assert.deepEqual(authority.profiles[0].fallbackRecordBytes, [56])
  assert.equal(authority.profiles[0].defaultEnabled, true)

  const [csharp, typescript, cpp] = await Promise.all([
    readFile(resolve(root, 'src/core/Cache/AedsAccessProfiles.Generated.cs'), 'utf8'),
    readFile(resolve(root, 'src/frontend/src/generated/aedsAccessProfiles.ts'), 'utf8'),
    readFile(resolve(root, 'src/frontend/wasm/aeds/include/aeds_access_profiles.generated.hpp'), 'utf8')
  ])
  for (const generated of [csharp, typescript, cpp]) {
    assert.match(generated, /PublicArticleListCard|publicArticleListCard/)
    assert.match(generated, /CurrentRevisionIdOffset|currentRevisionId/)
  }
})

test('default profile is wired without changing AEDS frame authority', async () => {
  const [api, registry, transport, worker, protocol] = await Promise.all([
    readFile(resolve(root, 'src/frontend/src/api/article.ts'), 'utf8'),
    readFile(resolve(root, 'src/frontend/src/composition/binaryDecoderRegistry.ts'), 'utf8'),
    readFile(resolve(root, 'src/frontend/src/services/binaryTransport.ts'), 'utf8'),
    readFile(resolve(root, 'src/frontend/src/workers/wasmDecode.worker.ts'), 'utf8'),
    readFile(resolve(root, 'src/shared/Contracts/Validation/aeds-protocol.json'), 'utf8')
  ])
  assert.match(api, /accessProfile: AEDS_ACCESS_PROFILE\.publicArticleListCard/)
  assert.match(registry, /mapPublicArticleListCardProjection/)
  assert.match(transport, /options\.accessProfile/)
  assert.match(worker, /decodeBinaryFramePayload\(frame\.frameType, frame\.payloadView, accessProfile\)/)
  const authority = JSON.parse(protocol)
  assert.equal(authority.header.size, 16)
  assert.equal(authority.header.version, 2)
})

test('checked benchmark baseline satisfies the default-enable gate in every case', async () => {
  const baseline = JSON.parse(await readFile(
    resolve(root, 'tests/performance/aeds-access-projection-baseline.json'),
    'utf8'
  ))
  assert.equal(baseline.correctnessDigestVerified, true)
  assert.equal(baseline.gate.status, 'passed')
  assert.equal(baseline.gate.defaultEnabled, true)
  assert.equal(baseline.cases.length, 12)
  for (const entry of baseline.cases) {
    assert.ok(
      entry.allocationReductionPercent >= baseline.gate.minimumAllocationReductionPercent
      || entry.timeReductionPercent >= baseline.gate.minimumTimeReductionPercent,
      `${entry.parameters} misses the access-profile gate`
    )
    assert.ok(entry.projection.allocatedBytesPerOp < entry.canonical.allocatedBytesPerOp)
  }
})
