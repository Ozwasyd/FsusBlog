#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..'))
const packageName = 'Nethermind.MclBindings'
const packageVersion = '1.0.5'
const packageIdPath = packageName.toLowerCase()
const feasibilityPath = path.join(root, 'security/zk/comment-v2-feasibility.manifest.json')
const lockFiles = [
  'src/backend/packages.lock.json',
  'tools/security/ZkCommentV2MclFixture/packages.lock.json'
]
const requiredAssets = [
  ['linux-x64', 'runtimes/linux-x64/native/libmcl.so'],
  ['linux-arm64', 'runtimes/linux-arm64/native/libmcl.so'],
  ['osx-x64', 'runtimes/osx-x64/native/libmcl.dylib'],
  ['osx-arm64', 'runtimes/osx-arm64/native/libmcl.dylib'],
  ['win-x64', 'runtimes/win-x64/native/mcl.dll'],
  ['win-arm64', 'runtimes/win-arm64/native/mcl.dll']
]

const failures = []

function fail(message) {
  failures.push(message)
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function relative(file) {
  return path.relative(root, file).split(path.sep).join('/')
}

function findLockedDependency(lockDocument) {
  for (const frameworkDependencies of Object.values(lockDocument.dependencies ?? {})) {
    const entry = frameworkDependencies?.[packageName]
    if (entry) {
      return entry
    }
  }

  return undefined
}

function checkFeasibilityGate() {
  const feasibility = readJson(feasibilityPath)
  const mcl = (feasibility.dependency_policy?.evaluated_candidates ?? [])
    .find((entry) => entry?.name === packageName)

  if (!mcl) {
    fail(`missing ${packageName} candidate in ${relative(feasibilityPath)}`)
    return
  }

  if (mcl.version !== packageVersion) {
    fail(`${packageName} feasibility version must be ${packageVersion}`)
  }

  const gate = mcl.runtime_asset_gate ?? {}
  if (gate.package !== packageName || gate.package_version !== packageVersion) {
    fail(`${packageName} runtime_asset_gate package/version must be pinned to ${packageVersion}`)
  }

  const ridSet = new Set(Array.isArray(gate.mainstream_server_rids) ? gate.mainstream_server_rids : [])
  const assetMap = new Map((Array.isArray(gate.required_assets) ? gate.required_assets : [])
    .map((entry) => [entry?.rid, entry?.path]))

  for (const [rid, assetPath] of requiredAssets) {
    if (!ridSet.has(rid)) {
      fail(`${packageName} runtime_asset_gate.mainstream_server_rids missing ${rid}`)
    }
    if (assetMap.get(rid) !== assetPath) {
      fail(`${packageName} runtime_asset_gate.required_assets missing ${rid} -> ${assetPath}`)
    }
  }

  if (!String(gate.unsupported_runtime_note ?? '').includes('linux-musl')) {
    fail(`${packageName} runtime_asset_gate must document linux-musl/alpine as unsupported`)
  }
}

function checkLockFiles() {
  for (const lockFile of lockFiles) {
    const absolute = path.join(root, lockFile)
    if (!fs.existsSync(absolute)) {
      fail(`missing ${lockFile}`)
      continue
    }

    const entry = findLockedDependency(readJson(absolute))
    if (!entry) {
      fail(`${lockFile} does not lock ${packageName}`)
      continue
    }
    if (entry.resolved !== packageVersion) {
      fail(`${lockFile} resolves ${packageName} ${entry.resolved}; expected ${packageVersion}`)
    }
  }
}

function findPackageDirectory() {
  const configured = process.env.NUGET_PACKAGES?.trim()
  const nugetRoot = configured && configured.length > 0
    ? configured
    : path.join(os.homedir(), '.nuget', 'packages')
  const candidates = [
    path.join(nugetRoot, packageIdPath, packageVersion),
    path.join(nugetRoot, packageName, packageVersion)
  ]

  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0]
}

function checkPackageAssets() {
  const packageDir = findPackageDirectory()
  if (!fs.existsSync(packageDir)) {
    fail(`missing restored NuGet package directory ${packageDir}; run dotnet restore first`)
    return
  }

  for (const [rid, assetPath] of requiredAssets) {
    const absolute = path.join(packageDir, assetPath)
    if (!fs.existsSync(absolute)) {
      fail(`${packageName} ${packageVersion} missing native asset for ${rid}: ${absolute}`)
    }
  }
}

checkFeasibilityGate()
checkLockFiles()
checkPackageAssets()

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`[mcl-platform-assets] ${failure}`)
  }
  process.exit(1)
}

console.log(`[mcl-platform-assets] ok package=${packageName} version=${packageVersion} rids=${requiredAssets.map(([rid]) => rid).join(',')}`)
