#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  bindingPath,
  buildBinding,
  buildReceipt,
  receiptPath
} from './generate-migration-assembly-receipt.mjs'

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const rootIndex = process.argv.indexOf('--root')
const root = rootIndex >= 0 ? resolve(process.argv[rootIndex + 1]) : defaultRoot
const failures = []
const migrationRoot = resolve(root, 'src/migration')

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

function count(text, pattern) {
  return [...text.matchAll(pattern)].length
}

function projectReferences(projectPath, text) {
  return [...text.matchAll(/<ProjectReference\s+Include="([^"]+)"/g)].map(match => {
    const include = match[1].replaceAll('\\', '/')
    return resolve(dirname(projectPath), include)
  })
}

function hasProjectCycle(projects) {
  const graph = new Map(projects.map(project => [project.path, project.references.filter(path => projects.some(item => item.path === path))]))
  const active = new Set()
  const visited = new Set()
  function visit(path) {
    if (active.has(path)) return true
    if (visited.has(path)) return false
    active.add(path)
    for (const target of graph.get(path) ?? []) {
      if (visit(target)) return true
    }
    active.delete(path)
    visited.add(path)
    return false
  }
  return [...graph.keys()].some(visit)
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

const migrationProject = read('src/migration/FsusBlog.Migration.csproj')
reject(!/<TargetFramework>net10\.0<\/TargetFramework>/.test(migrationProject), 'Migration TFM must be net10.0')
reject(!/<RootNamespace>FsusBlog\.Migration<\/RootNamespace>/.test(migrationProject), 'Migration root namespace is not explicit')
reject(!/<AssemblyName>FsusBlog\.Migration<\/AssemblyName>/.test(migrationProject), 'Migration assembly identity is not explicit')
reject(!/<PackageReference Include="SqlSugarCoreNoDrive"/.test(migrationProject), 'Migration provider package is missing')
const migrationReferences = [...migrationProject.matchAll(/<ProjectReference Include="([^"]+)"/g)].map(match => match[1].replaceAll('\\', '/'))
reject(migrationReferences.length !== 1 || !migrationReferences[0].endsWith('/shared/FsusBlog.Shared.csproj'), 'Migration may reference only FsusBlog.Shared')
reject(/FrameworkReference|Microsoft\.AspNetCore|FsusBlog\.Server\.csproj|FsusBlog\.Core\.csproj/.test(migrationProject), 'Migration project has a forbidden framework or application reference')

const projectFiles = [...files('src'), ...files('tests'), ...files('tools')]
  .filter(path => path.endsWith('.csproj'))
const projects = projectFiles.map(path => {
  const text = readFileSync(path, 'utf8')
  return { path, text, references: projectReferences(path, text) }
})
reject(hasProjectCycle(projects), 'project graph contains a cycle')
reject(projects.filter(project => /<AssemblyName>FsusBlog\.Migration<\/AssemblyName>/.test(project.text)).length !== 1, 'old/new migration assembly identity is registered more than once')

const serverProjectPath = join(root, 'src/backend/FsusBlog.Server.csproj')
const serverProject = read('src/backend/FsusBlog.Server.csproj')
const serverMigrationReferences = projectReferences(serverProjectPath, serverProject)
  .filter(path => path === join(root, 'src/migration/FsusBlog.Migration.csproj'))
reject(serverMigrationReferences.length !== 0, 'Server runtime must not reference Migration')

for (const project of projects.filter(item => item.path !== join(root, 'src/migration/FsusBlog.Migration.csproj'))) {
  for (const match of project.text.matchAll(/<(Compile|Content|EmbeddedResource|None)\b[^>]*\bInclude="([^"]+)"[^>]*>/g)) {
    const itemType = match[1]
    const include = match[2].replaceAll('\\', '/')
    if (include.includes('*') || include.includes('$(')) continue
    const resolved = resolve(dirname(project.path), include)
    const migrationSource = resolved === migrationRoot || resolved.startsWith(`${migrationRoot}/`)
    reject(itemType === 'Compile' && migrationSource, 'a project links or duplicates migration source outside Migration')
    reject(
      project.path === serverProjectPath
        && (migrationSource || /Infrastructure\/SchemaMigration\/(?:Definitions|Catalogs)\//.test(include))
        && (itemType === 'Compile' || /CopyToPublishDirectory/.test(match[0])),
      'Server build/publish includes legacy migration source')
  }
}

const solution = read('FsusBlog.slnx')
reject(count(solution, /<Project Path="src\/migration\/FsusBlog\.Migration\.csproj" \/>/g) !== 1, 'Migration project is not registered exactly once in the solution')
reject(count(solution, /<Project Path="tests\/migration\/FsusBlog\.Migration\.Tests\.csproj" \/>/g) !== 1, 'Migration tests are not registered exactly once in the solution')

const migrationSources = files('src/migration').filter(path => path.endsWith('.cs'))
const migrationText = migrationSources.map(path => readFileSync(path, 'utf8')).join('\n')
reject(/using\s+FsusBlog\.Server|namespace\s+FsusBlog\.Server|Microsoft\.AspNetCore|IHostedService|BackgroundService|WebApplication|TestServer/.test(migrationText), 'Migration source re-enters Server or web-host code')
const migrationRowModelPath = join(root, 'src/migration/Definitions/CommentRevisionMigrationRows.cs')
const migrationRowModel = existsSync(migrationRowModelPath) ? readFileSync(migrationRowModelPath, 'utf8') : ''
const providerMappingText = migrationSources
  .filter(path => path !== migrationRowModelPath)
  .map(path => readFileSync(path, 'utf8'))
  .join('\n')
reject(/\[(?:SugarTable|SugarColumn|SugarIndex)\b|CurrentSchemaCanonical|SchemaTableModel/.test(providerMappingText), 'Migration providers contain a duplicate current-schema field mapping')
reject(
  !migrationRowModel.includes('[SugarTable("comment")]')
    || !migrationRowModel.includes('[SugarTable("comment_revision")]')
    || (migrationRowModel.match(/\[SugarTable\(/g) ?? []).length !== 2,
  'Migration-owned source row mapping is missing or expanded beyond its two backfill tables')
reject(/TypeForwardedTo|namespace\s+FsusBlog\.Server\.Infrastructure\.SchemaMigration/.test(migrationText), 'Migration source exposes a compatibility namespace or type forwarder')

reject(existsSync(join(root, 'src/backend/Infrastructure/SchemaMigration/Definitions')), 'Legacy definitions remain in Server')
reject(existsSync(join(root, 'src/backend/Infrastructure/SchemaMigration/Catalogs')), 'Migration catalogs remain in Server')
const serverSources = files('src/backend').filter(path => path.endsWith('.cs'))
const serverText = serverSources.map(path => readFileSync(path, 'utf8')).join('\n')
reject(/namespace\s+FsusBlog\.Server\.Infrastructure\.SchemaMigration\.(?:Definitions|Catalogs)/.test(serverText), 'Server retains a legacy migration namespace at an arbitrary path')
reject(/TypeForwardedTo\s*\(\s*typeof\s*\([^)]*(?:SchemaMigration|MigrationDefinitions)/.test(serverText), 'Server re-exports migration types')
reject(/public\s+(?:sealed\s+)?(?:class|record|interface)\s+\w+[^\n{]*:\s*FsusBlog\.Migration\./.test(serverText), 'Server re-exports a Migration type through inheritance')
const migrationHashes = new Set(migrationSources.map(path => sha256(readFileSync(path))))
reject(serverSources.some(path => migrationHashes.has(sha256(readFileSync(path)))), 'Server contains a duplicate migration source at an arbitrary path')

const sharedText = files('src/shared').filter(path => path.endsWith('.cs')).map(path => readFileSync(path, 'utf8')).join('\n').toLowerCase()
reject(sharedText.includes('lastusernameupdatetime') || sharedText.includes('refreshtokenexpirytime'), 'Shared current contracts contain a legacy-only column')

const testsProject = read('tests/migration/FsusBlog.Migration.Tests.csproj')
const testReferences = [...testsProject.matchAll(/<ProjectReference Include="([^"]+)"/g)].map(match => match[1].replaceAll('\\', '/'))
reject(testReferences.length !== 1 || !testReferences[0].endsWith('/migration/FsusBlog.Migration.csproj'), 'Migration tests must reference only Migration')
const testText = files('tests/migration').filter(path => path.endsWith('.cs')).map(path => readFileSync(path, 'utf8')).join('\n')
reject(/WebApplication|TestServer|using\s+FsusBlog\.Server|namespace\s+FsusBlog\.Server|typeof\s*\([^)]*FsusBlog\.Server/.test(testText), 'Migration tests start or reference the Server web host')

const actualReceiptPath = receiptPath(root)
const actualBindingPath = bindingPath(root)
if (!existsSync(actualReceiptPath)) {
  failures.push('migration assembly receipt is missing')
} else {
  let actual
  try {
    actual = JSON.parse(readFileSync(actualReceiptPath, 'utf8'))
  } catch {
    failures.push('migration assembly receipt is not valid JSON')
  }
  if (actual) {
    reject(actual.schema !== 'fsusblog.migration-assembly-receipt.v2', 'migration assembly receipt schema is stale')
    reject(!Array.isArray(actual.sourceTransition?.files) || actual.sourceTransition.files.length === 0, 'migration assembly receipt lacks old/new source transitions')
    reject(!actual.sourceTransition?.oldContentDigest || !actual.contentDigest, 'migration assembly receipt lacks old/new content digests')
    reject(!Array.isArray(actual.testFiles) || actual.testFiles.length === 0 || !actual.testContentDigest || !actual.verificationInputDigest, 'migration assembly receipt lacks test input identity')
    reject(!Array.isArray(actual.sourceTransition?.deletedOldPaths) || actual.sourceTransition.deletedOldPaths.length === 0, 'migration assembly receipt lacks deleted old paths')
    reject(actual.sourceTransition?.deletedOldPaths?.some(path => existsSync(join(root, path))), 'a receipted retired Server source path still exists')
    reject(!Array.isArray(actual.verificationResults) || actual.verificationResults.length !== 2, 'actual independent build/test results are missing')
    reject(actual.verificationResults?.some(result => result.status !== 'passed' || result.exitCode !== 0 || result.inputDigest !== actual.verificationInputDigest), 'actual independent build/test results are failed or stale')
    const expected = buildReceipt(root, {
      previousReceipt: actual,
      verificationResults: actual.verificationResults
    })
    reject(JSON.stringify(actual) !== JSON.stringify(expected), 'migration assembly receipt content or symbol inventory is stale')
    if (!existsSync(actualBindingPath)) {
      failures.push('migration assembly generated binding manifest is missing')
    } else {
      let binding
      try {
        binding = JSON.parse(readFileSync(actualBindingPath, 'utf8'))
      } catch {
        failures.push('migration assembly generated binding manifest is not valid JSON')
      }
      reject(binding && JSON.stringify(binding) !== JSON.stringify(buildBinding(actual)), 'migration assembly binding manifest is stale or tampered')
    }
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`[migration-assembly-boundary] ${failure}`)
  process.exitCode = 1
} else {
  console.log('[migration-assembly-boundary] ok')
}
