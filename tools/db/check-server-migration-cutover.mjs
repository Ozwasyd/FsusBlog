#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const rootIndex = process.argv.indexOf('--root')
const root = rootIndex >= 0 ? resolve(process.argv[rootIndex + 1]) : defaultRoot
const failures = []

function read(path) {
  const fullPath = join(root, path)
  if (!existsSync(fullPath)) {
    failures.push(`missing required path: ${path}`)
    return ''
  }
  return readFileSync(fullPath, 'utf8')
}

function files(directory) {
  const fullPath = join(root, directory)
  if (!existsSync(fullPath)) return []
  return readdirSync(fullPath, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && !entry.parentPath.split('/').some(part => part === 'bin' || part === 'obj'))
    .map(entry => join(entry.parentPath, entry.name))
}

function reject(condition, message) {
  if (condition) failures.push(message)
}

const serverProject = read('src/backend/FsusBlog.Server.csproj')
reject(/FsusBlog\.Migration\.csproj/.test(serverProject), 'explicit Server→Migration project reference')
reject(existsSync(join(root, 'src/backend/GlobalUsings.Migration.cs')), 'Server global using re-imports Migration')

const serverSources = files('src/backend').filter(path => path.endsWith('.cs')).map(path => readFileSync(path, 'utf8')).join('\n')
reject(/using\s+FsusBlog\.Migration|namespace\s+FsusBlog\.Migration|FsusBlog\.Migration\./.test(serverSources), 'Server source imports Migration types')
reject(/AddSingleton<\s*ISchemaMigrationRegistry/.test(serverSources), 'Server DI still registers migration registry')
reject(/new\s+SchemaMigrationRegistry\s*\(/.test(serverSources), 'Server constructs migration registry')
reject(!/class\s+CurrentSchemaStartupVerifier/.test(serverSources), 'current schema startup verifier is missing')
reject(!/schema_current_mismatch/.test(serverSources), 'fail-closed current schema mismatch contract is missing')
reject(/Type\.GetType\s*\(\s*"[^"]*FsusBlog\.Migration/.test(serverSources), 'Server reflects Migration by string')

const assemblyInfo = read('src/migration/Properties/AssemblyInfo.cs')
reject(/InternalsVisibleTo\("FsusBlog\.Server"\)/.test(assemblyInfo), 'Migration InternalsVisibleTo Server remains')

if (failures.length > 0) {
  for (const failure of failures) console.error(`[server-migration-cutover] ${failure}`)
  process.exitCode = 1
} else {
  console.log('[server-migration-cutover] ok')
}
