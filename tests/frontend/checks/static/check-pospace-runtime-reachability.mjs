import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import process from 'node:process'

const root = process.env.FSUSBLOG_POSPACE_REACHABILITY_ROOT
  ? path.resolve(process.env.FSUSBLOG_POSPACE_REACHABILITY_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')

const nodes = Object.freeze({
  registry: 'src/frontend/src/security/challenge-capability-registry.ts',
  executor: 'src/frontend/src/services/securityPoSpaceChallengeExecutor.ts',
  workerClient: 'src/frontend/src/services/securityPoSpaceClient.ts',
  runtime: 'src/frontend/src/services/securityPoSpaceRuntime.ts',
  worker: 'src/frontend/src/workers/security/pospace.worker.ts',
  challengeHost: 'src/frontend/src/components/security/FsusSecurityChallenge.vue',
  poSpaceHost: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
  notification: 'src/frontend/src/composables/useNotification.ts'
})

const sources = Object.fromEntries(
  Object.entries(nodes).map(([id, relative]) => [id, read(relative)])
)

const edges = Object.freeze([
  {
    from: 'registry',
    to: 'executor',
    kind: 'dynamic-import',
    pattern: /import\('@\/services\/securityPoSpaceChallengeExecutor'\)/u
  },
  {
    from: 'executor',
    to: 'workerClient',
    kind: 'static-import',
    pattern: /from '\.\/securityPoSpaceClient'/u
  },
  {
    from: 'executor',
    to: 'runtime',
    kind: 'static-import',
    pattern: /from '\.\/securityPoSpaceRuntime'/u
  },
  {
    from: 'workerClient',
    to: 'worker',
    kind: 'worker-url-import',
    pattern: /from '@\/workers\/security\/pospace\.worker\.ts\?worker&url'/u
  },
  {
    from: 'challengeHost',
    to: 'poSpaceHost',
    kind: 'static-import',
    pattern: /from '\.\/FsusPoSpaceChallenge\.vue'/u
  },
  {
    from: 'poSpaceHost',
    to: 'executor',
    kind: 'dynamic-import',
    pattern: /import\('@\/services\/securityPoSpaceChallengeExecutor'\)/u
  },
  {
    from: 'notification',
    to: 'executor',
    kind: 'dynamic-import',
    pattern: /import\(\s*'@\/services\/securityPoSpaceChallengeExecutor'\s*\)/u
  }
])

for (const edge of edges) {
  assert.match(
    sources[edge.from],
    edge.pattern,
    `${nodes[edge.from]} must keep the ${edge.kind} edge to ${nodes[edge.to]}`
  )
}

for (const hostId of ['poSpaceHost', 'notification']) {
  assert.doesNotMatch(
    sources[hostId],
    /import\s*\{\s*createPoSpaceChallengeExecutor\s*\}\s*from\s*'@\/services\/securityPoSpaceChallengeExecutor'/u,
    `${nodes[hostId]} must keep the PoSpace executor lazy instead of restoring an eager compatibility edge`
  )
}

assert.match(
  sources.executor,
  /createPoSpaceWorkerClient/u,
  'the shared executor must own PoSpace Worker client construction'
)
assert.match(
  sources.executor,
  /createPoSpaceVerifyPayload/u,
  'the shared executor must own PoSpace verify payload construction'
)

const forbiddenHostImplementations = Object.freeze([
  ['direct Worker construction', /\bnew\s+Worker\s*\(/u],
  ['Argon2 implementation import', /@noble\/hashes\/argon2|\bargon2idAsync\b/u],
  ['runtime proof solve', /\bsolvePoSpaceProof\b/u],
  ['Worker client construction', /\bcreatePoSpaceWorkerClient\b/u],
  ['verify payload construction', /\bcreatePoSpaceVerifyPayload\b/u],
  ['direct Worker URL import', /pospace\.worker\.ts\?worker/u]
])

for (const hostId of ['challengeHost', 'poSpaceHost', 'notification']) {
  for (const [label, pattern] of forbiddenHostImplementations) {
    assert.doesNotMatch(
      sources[hostId],
      pattern,
      `${nodes[hostId]} must not duplicate ${label}; use the shared executor`
    )
  }
}

assert.match(
  sources.runtime,
  /from '@noble\/hashes\/argon2\.js'/u,
  'securityPoSpaceRuntime.ts remains the single Argon2 implementation owner'
)
assert.match(
  sources.worker,
  /\bsolvePoSpaceProof\b/u,
  'the dedicated Worker must delegate solving to the canonical runtime'
)

const report = {
  check: 'pospace-runtime-reachability',
  version: 2,
  ok: true,
  nodes,
  edges: edges.map(({ from, to, kind }) => ({ from, to, kind })),
  duplicateImplementationHosts: ['challengeHost', 'poSpaceHost', 'notification']
}

console.log(JSON.stringify(report))
