#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { digestValue } from '../../fact-extractors/lib/canonicalize.mjs'

export const runtimeRoleArtifactId = 'runtime-role-observation'
export const runtimeRoleProject = 'tools/contracts/FsusBlog.RuntimeRoleObservation/FsusBlog.RuntimeRoleObservation.csproj'
export const runtimeRoleObservationRelative = '.tmp/contracts/runtime-role/runtime-role-observation.json'

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

export function produceRuntimeRoleObservation({ repositoryRoot, rebuild = true } = {})
{
  if (!repositoryRoot) throw new Error('runtime-role producer requires repositoryRoot')
  const output = path.join(repositoryRoot, runtimeRoleObservationRelative)
  mkdirSync(path.dirname(output), { recursive: true })
  const project = path.join(repositoryRoot, runtimeRoleProject)
  if (!existsSync(project)) throw new Error(`runtime-role project missing: ${runtimeRoleProject}`)
  if (rebuild)
  {
    const build = spawnSync('dotnet', ['build', project, '-c', 'Release', '-v', 'minimal'], {
      cwd: repositoryRoot, encoding: 'utf8'
    })
    if (build.status !== 0) throw new Error(`runtime-role build failed:\n${build.stdout}\n${build.stderr}`)
  }
  const run = spawnSync('dotnet', ['run', '--project', project, '-c', 'Release', '--no-build', '--', '--output', output], {
    cwd: repositoryRoot, encoding: 'utf8'
  })
  if (run.status !== 0) throw new Error(`runtime-role observation failed:\n${run.stdout}\n${run.stderr}`)
  const bytes = readFileSync(output)
  const artifactDigest = sha256(bytes)
  const receiptBody = {
    schema: 'fsusblog.runtime-role-observation-build-receipt.v1',
    artifactId: runtimeRoleArtifactId,
    artifactPath: runtimeRoleObservationRelative,
    artifactDigest,
    configuration: 'Release'
  }
  const buildIdentity = {
    artifactId: runtimeRoleArtifactId,
    artifactDigest,
    receiptDigest: digestValue(receiptBody)
  }
  const receiptPath = path.join(path.dirname(output), 'build-receipt.json')
  writeFileSync(receiptPath, `${JSON.stringify({ ...receiptBody, buildIdentity }, null, 2)}\n`)
  return { observation: JSON.parse(bytes), output, receiptPath, buildIdentity }
}
