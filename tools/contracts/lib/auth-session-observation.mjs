#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { digestValue } from '../../fact-extractors/lib/canonicalize.mjs'

export const observationArtifactId = 'auth-session-permission-observation'
export const observationRelativeDir = '.tmp/contracts/auth-session'
export const observationFileName = 'auth-session-permission-observation.json'
export const observationToolProject = 'tools/contracts/FsusBlog.AuthSessionObservation/FsusBlog.AuthSessionObservation.csproj'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

const fail = (message) =>
{
  throw new Error(`[auth-session-observation] ${message}`)
}

export function observationPaths(repositoryRoot = root)
{
  const directory = path.join(repositoryRoot, observationRelativeDir)
  return {
    directory,
    observationPath: path.join(directory, observationFileName),
    relativeObservationPath: `${observationRelativeDir}/${observationFileName}`
  }
}

export function sha256File(filePath)
{
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

/**
 * Produce sealed auth/session/admin-permission observation from compiled production constants.
 * Does not start a listener. Binds digests for exact-build-receipt extractors.
 */
export function produceAuthSessionObservation({
  repositoryRoot = root,
  configuration = 'Release',
  rebuild = true
} = {})
{
  const paths = observationPaths(repositoryRoot)
  mkdirSync(paths.directory, { recursive: true })

  const project = path.join(repositoryRoot, observationToolProject)
  if (!existsSync(project)) fail(`observation tool missing: ${observationToolProject}`)

  if (rebuild)
  {
    const build = spawnSync(
      'dotnet',
      ['build', project, '-c', configuration, '-v', 'minimal'],
      { cwd: repositoryRoot, encoding: 'utf8', env: process.env }
    )
    if (build.status !== 0)
    {
      fail(`dotnet build failed:\n${build.stdout}\n${build.stderr}`)
    }
  }

  const run = spawnSync(
    'dotnet',
    [
      'run',
      '--project',
      project,
      '-c',
      configuration,
      '--no-build',
      '--',
      '--output',
      paths.observationPath
    ],
    { cwd: repositoryRoot, encoding: 'utf8', env: process.env }
  )
  if (run.status !== 0)
  {
    fail(`observation host failed:\n${run.stdout}\n${run.stderr}`)
  }
  if (!existsSync(paths.observationPath))
  {
    fail('observation host did not write observation artifact')
  }

  const observation = JSON.parse(readFileSync(paths.observationPath, 'utf8'))
  const artifactDigest = sha256File(paths.observationPath)
  const receiptBody = {
    schema: 'fsusblog.auth-session-observation-build-receipt.v1',
    artifactId: observationArtifactId,
    observationPath: paths.relativeObservationPath,
    observationDigest: observation.observationDigest,
    artifactDigest,
    configuration
  }
  const receiptDigest = digestValue(receiptBody)
  const buildIdentity = {
    artifactId: observationArtifactId,
    receiptDigest,
    artifactDigest
  }
  const receiptPath = path.join(paths.directory, 'build-receipt.json')
  writeFileSync(receiptPath, `${JSON.stringify({ ...receiptBody, buildIdentity }, null, 2)}\n`)

  return {
    observation,
    observationPath: paths.observationPath,
    buildIdentity,
    receiptPath,
    receiptBody,
    buildSourcePaths: []
  }
}

export function loadProducedAuthSessionObservation(repositoryRoot = root)
{
  const paths = observationPaths(repositoryRoot)
  if (!existsSync(paths.observationPath))
  {
    fail(`missing observation artifact at ${paths.relativeObservationPath}; run produceAuthSessionObservation first`)
  }
  return JSON.parse(readFileSync(paths.observationPath, 'utf8'))
}
