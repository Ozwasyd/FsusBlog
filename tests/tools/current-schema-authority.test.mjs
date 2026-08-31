import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { validateCurrentSchemaAuthority } from '../../tools/db/check-current-schema-authority.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const canonicalRelative = 'src/backend/Infrastructure/SchemaMigration/CurrentSchemaCanonicalModel.cs'
const inspectorRelative = 'src/backend/Infrastructure/SchemaMigration/SchemaModelInspector.cs'
const materializerRelative = 'src/backend/Infrastructure/Testing/CurrentSchemaTestMaterializer.cs'

function mutatedRepository(mutate) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-current-schema-authority-'))
  for (const relative of [canonicalRelative, inspectorRelative]) {
    const target = path.join(temporary, relative)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(path.join(root, relative), target)
  }
  mutate(temporary)
  return temporary
}

test('current schema authority has one canonical extractor, three adapters and one verifier', () => {
  assert.deepEqual(validateCurrentSchemaAuthority(root), [])
})

test('current schema authority rejects migration catalog input and fixture reconstruction', () => {
  for (const mutation of [
    'SchemaMigrationRegistry registry = new();',
    'string expected = File.ReadAllText("tests/Fixtures/current-schema.json");'
  ]) {
    const temporary = mutatedRepository((repository) => {
      fs.appendFileSync(path.join(repository, canonicalRelative), `\n${mutation}\n`)
    })
    assert.notDeepEqual(validateCurrentSchemaAuthority(temporary), [])
  }
})

test('current schema authority rejects a hand-written inventory or second generator', () => {
  const handWritten = mutatedRepository((repository) => {
    const target = path.join(repository, 'src/backend/Services/SecondSchemaInventory.cs')
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, 'var table = new SchemaTableModel("manual", [], []);\n')
  })
  assert.ok(validateCurrentSchemaAuthority(handWritten).some((error) => error.includes('hand-written')))

  const secondGenerator = mutatedRepository((repository) => {
    const target = path.join(repository, 'src/backend/Services/SecondSchemaGenerator.cs')
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, 'var model = CurrentSchemaCanonicalAuthority.Extract(entityTypes);\n')
  })
  assert.ok(validateCurrentSchemaAuthority(secondGenerator).some((error) => error.includes('second current schema producer')))
})

test('test current schema materializer remains explicit, canonical and pre-runtime', () => {
  const materializer = fs.readFileSync(path.join(root, materializerRelative), 'utf8')
  const program = fs.readFileSync(path.join(root, 'src/backend/Program.cs'), 'utf8')
  const bootstrap = fs.readFileSync(path.join(root, 'tools/bootstrap-acceptance-env.sh'), 'utf8')

  assert.doesNotMatch(materializer, /SchemaMigration(?:Registry|Manifest|Descriptor)|GetDescriptors\s*\(/u)
  assert.doesNotMatch(materializer, /CurrentSchemaCanonicalAuthority\.Extract\s*\(/u)
  assert.match(materializer, /inspector\.BuildCanonicalModel\(entityTypes\)/u)
  assert.match(materializer, /current_schema_materializer_test_environment_required/u)
  assert.match(materializer, /current_schema_materializer_opt_in_required/u)
  assert.match(materializer, /current_schema_materializer_loopback_required/u)
  assert.match(materializer, /current_schema_materializer_public_search_path_required/u)
  assert.match(materializer, /current_schema_materializer_public_schema_not_empty/u)
  assert.match(materializer, /ValidateAssemblySourceCommit\(options\.SourceCommit\)/u)
  assert.match(materializer, /ValidateServiceEnvelope\([\s\S]*options\.RunId/u)
  assert.match(materializer, /BeginTranAsync\(\)[\s\S]*InitTables\([\s\S]*verifier\.RunAsync[\s\S]*AtomicWrite\([\s\S]*CommitTranAsync\(\)/u)
  assert.match(materializer, /RollbackTranAsync\(\)/u)
  assert.match(materializer, /File\.Move\(temporaryPath, fullPath, overwrite: true\)/u)

  const inspector = fs.readFileSync(path.join(root, inspectorRelative), 'utf8')
  assert.match(inspector, /owning_constraint\.conindid = index_meta\.indexrelid[\s\S]*owning_constraint\.contype = 'p'/u)

  const commandRoute = program.indexOf('CurrentSchemaTestMaterializationCommandLine.IsRequested(args)')
  const serveParser = program.indexOf('OnlineSchemaMigrationCommandLine.Parse(args)')
  assert.ok(commandRoute >= 0 && commandRoute < serveParser)
  assert.match(program, /exceptionCode\.StartsWith\("current_schema_"/u)

  const databaseServices = bootstrap.indexOf("RunBootstrapParallel 'database services and backend producer'")
  const materialization = bootstrap.indexOf('MaterializeCurrentSchemaForTestRuntime\n', databaseServices)
  const runtimeApplications = bootstrap.indexOf("RunBootstrapParallel 'runtime applications'", materialization)
  assert.ok(databaseServices >= 0 && materialization > databaseServices && runtimeApplications > materialization)
  assert.match(bootstrap, /ASPNETCORE_ENVIRONMENT=Test[\s\\]*\n[\s\S]*FSUSBLOG_CURRENT_SCHEMA_TEST_MATERIALIZATION=1/u)
  assert.match(bootstrap, /ConnectionStrings__DefaultConnection="\$\{POSTGRES_CONNECTION\};Search Path=public"/u)
  assert.match(bootstrap, /--service-envelope "\$EXECUTION_SERVICE_ENVELOPE_FILE"/u)
})
