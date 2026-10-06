import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { digestValue, stable } from '../../../tools/fact-extractors/lib/canonicalize.mjs'
import { createReleaseManifest } from '../../../tools/release/release-manifest.mjs'
import { createCurrentRolloutFixtureBinding } from './release-rollout-evidence-fixture.mjs'

export const digest = (character) => `sha256:${character.repeat(64)}`
export const semanticDigest = (value) => `sha256:${digestValue(stable(value))}`
export const fileDigest = (file) => `sha256:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`

export function write(file, value)
{
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

export function createReadinessManifest(releaseId, commit)
{
  return createReleaseManifest({
    releaseId,
    commitSha: commit,
    imageRepository: 'ghcr.io/fsusblog/app',
    imageTag: `ghcr.io/fsusblog/app:${releaseId}`,
    imageDigest: digest('1'),
    registryDigestVerified: true,
    createdAtUtc: '2026-07-11T01:01:01.000Z',
    frontendManifestHash: digest('2'),
    wasmArtifactHash: digest('3'),
    currentSchema: createCurrentRolloutFixtureBinding(commit).currentSchema,
    dotnetVersion: '10.0.100',
    nodeVersion: '24.0.0',
    dockerVersion: '28.0.0',
    dockerfileDigest: digest('4'),
    runtimeProfile: {
      id: 'throughput-musl',
      manifestDigest: digest('5'),
      profileDigest: digest('6'),
      baseImageFamily: 'musl',
      targetRuntime: 'linux-musl-x64',
      singleFile: true,
      readyToRun: false,
      tieredPgo: true,
      quickJitForLoops: true,
      serverGc: true,
      nativeAot: false,
      threadPoolMode: 'runtime-default',
      topologyMode: 'smt-visible'
    },
    target: 'final'
  })
}
