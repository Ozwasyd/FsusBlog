import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  checkCSharpEntrypointOwnership,
  validateCSharpEntrypointOwnershipPolicy
} from '../../tools/check-csharp-entrypoint-ownership.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const policyRelative = 'tests/governance/csharp-entrypoint-ownership.json'
const repositoryPolicy = JSON.parse(fs.readFileSync(path.join(repositoryRoot, policyRelative), 'utf8'))
const sourceLayoutPolicy = JSON.parse(fs.readFileSync(
  path.join(repositoryRoot, 'tests/governance/repository-source-layout.json'),
  'utf8'
))

function write(root, relative, content = '') {
  const file = path.join(root, relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

function fixtureRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-csharp-entrypoint-'))
  write(root, 'src/frontend/FsusBlog.Client.esproj', '<Project Sdk="Microsoft.VisualStudio.JavaScript.Sdk/1.0.0" />\n')
  write(root, 'src/backend/FsusBlog.Server.csproj', '<Project Sdk="Microsoft.NET.Sdk.Web" />\n')
  write(root, 'src/backend/Program.cs', 'Console.WriteLine("server");\n')
  write(root, policyRelative, `${JSON.stringify(repositoryPolicy, null, 2)}\n`)
  return root
}

function check(root, policy = repositoryPolicy) {
  write(root, policyRelative, `${JSON.stringify(policy, null, 2)}\n`)
  return checkCSharpEntrypointOwnership({ root, policyFile: policyRelative })
}

test('canonical repository has no C# source under the frontend project and every entrypoint is owned', () => {
  const result = checkCSharpEntrypointOwnership({ root: repositoryRoot, policyFile: policyRelative })
  assert.deepEqual(result.errors, [])
  assert.equal(result.ok, true)
  assert.equal(result.javascriptProjectRootCount, 1)
  assert.ok(result.entrypointCount >= 5)
  assert.equal(result.protocolFixtureCount, 0)
  assert.equal(fs.existsSync(path.join(repositoryRoot, 'src/frontend/Program.cs')), false)
  assert.deepEqual(sourceLayoutPolicy.languageOwnership.csharpEntrypoint, {
    policy: policyRelative,
    checker: 'tools/check-csharp-entrypoint-ownership.mjs'
  })
})

test('one scan exposes frontend C#, unowned entrypoints, fixed global output, and ownerless fixtures together', (context) => {
  const root = fixtureRoot()
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  write(root, 'src/frontend/Program.cs', 'File.WriteAllText("/tmp/fsus-frame.hex", "00");\n')
  write(root, 'src/frontend/Helper.cs', 'internal static class Helper {}\n')
  write(root, 'tools/contracts/LooseGenerator/Program.cs', 'Console.WriteLine("loose");\n')
  write(root, 'tools/contracts/LooseGenerator/Orphan.cs', 'internal static class Orphan {}\n')
  write(root, 'tests/frontend/fixtures/aeds/article-detail.frame.hex', '00\n')

  const result = check(root)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('C# source cannot live under JavaScript project root src/frontend: src/frontend/Program.cs')))
  assert.ok(result.errors.some((error) => error.includes('C# source cannot live under JavaScript project root src/frontend: src/frontend/Helper.cs')))
  assert.ok(result.errors.some((error) => error.includes('C# entrypoint has no owning project or file-based app contract: tools/contracts/LooseGenerator/Program.cs')))
  assert.ok(result.errors.some((error) => error.includes('C# source has no owning project or file-based app contract: tools/contracts/LooseGenerator/Orphan.cs')))
  assert.ok(result.errors.some((error) => error.includes('C# generator writes to fixed global output root /tmp: src/frontend/Program.cs')))
  assert.ok(result.errors.some((error) => error.includes('generated protocol fixture has no unique generator/check owner: tests/frontend/fixtures/aeds/article-detail.frame.hex')))
})

test('owned .NET generators still fail when they write fixtures to a fixed global temp path', (context) => {
  const root = fixtureRoot()
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  write(root, 'tools/contracts/Generator/Generator.csproj', '<Project Sdk="Microsoft.NET.Sdk" />\n')
  write(root, 'tools/contracts/Generator/Program.cs', 'File.WriteAllBytes(Path.Combine("/var/tmp", "frame.bin"), []);\n')

  const result = check(root)
  assert.ok(result.errors.some((error) => error.includes('fixed global output root /var/tmp: tools/contracts/Generator/Program.cs')))
  assert.ok(!result.errors.some((error) => error.includes('has no owning project')))
})

test('file-based apps require an explicit owner, dependencies, invocation, tests, output contract, and reason', () => {
  const policy = structuredClone(repositoryPolicy)
  policy.fileBasedApps = [{ path: 'tools/file-app/Program.cs' }]
  const errors = validateCSharpEntrypointOwnershipPolicy(policy)
  for (const field of ['owner', 'reason', 'invocation', 'outputContract']) {
    assert.ok(errors.some((error) => error.includes(`requires ${field}`)))
  }
  assert.ok(errors.some((error) => error.includes('requires at least one dependency declaration')))
  assert.ok(errors.some((error) => error.includes('requires at least one test')))
})

test('a fully declared file-based app is an explicit exception to project ownership', (context) => {
  const root = fixtureRoot()
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  write(root, 'tools/file-app/Program.cs', 'Console.WriteLine("owned file app");\n')
  write(root, 'tests/tools/file-app.test.mjs', 'export {}\n')
  const policy = structuredClone(repositoryPolicy)
  policy.fileBasedApps = [{
    path: 'tools/file-app/Program.cs',
    owner: 'RepositoryToolingAgent',
    reason: 'A documented file-based app fixture.',
    invocation: 'dotnet run tools/file-app/Program.cs',
    dependencyDeclarations: ['BCL only; no project or package dependencies.'],
    tests: ['tests/tools/file-app.test.mjs'],
    outputContract: 'Writes only to the caller-provided output path.'
  }]

  assert.deepEqual(check(root, policy).errors, [])
})

test('a formal fixture generator needs stable generate/check commands and exact fixture ownership', (context) => {
  const root = fixtureRoot()
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const project = 'tools/contracts/FsusBlog.AedsFixtureGenerator/FsusBlog.AedsFixtureGenerator.csproj'
  const manifest = 'tests/frontend/fixtures/aeds/manifest.json'
  const fixture = 'tests/frontend/fixtures/aeds/article-detail.frame.hex'
  write(root, project, '<Project Sdk="Microsoft.NET.Sdk" />\n')
  write(root, 'tools/contracts/FsusBlog.AedsFixtureGenerator/Program.cs', 'Console.WriteLine(args[0]);\n')
  write(root, manifest, '{}\n')
  write(root, fixture, '00\n')
  const policy = structuredClone(repositoryPolicy)
  policy.protocolFixtures.generators = [{
    id: 'aeds-contract-fixtures',
    project,
    manifest,
    fixtures: [fixture],
    generateCommand: `dotnet run --project ${project} -- generate`,
    checkCommand: `dotnet run --project ${project} -- check`
  }]

  assert.deepEqual(check(root, policy).errors, [])

  policy.protocolFixtures.generators[0].checkCommand = `dotnet run --project ${project}`
  write(root, 'tests/frontend/fixtures/aeds/article-search.frame.bin', '01')
  const drift = check(root, policy)
  assert.ok(drift.errors.some((error) => error.includes('checkCommand must invoke') && error.includes('with check')))
  assert.ok(drift.errors.some((error) => error.includes('article-search.frame.bin')))
})
