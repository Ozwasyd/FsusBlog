import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const generatedPath = path.join(root, 'docs/schema-migrations/data-reader-projections.json')
const literalOrdinal = /\b[A-Za-z_][A-Za-z0-9_]*\.(?:Get(?:Boolean|Byte|Char|DateTime|Decimal|Double|FieldValue|Float|Guid|Int16|Int32|Int64|String|Value)|IsDBNull)\(\s*[0-9]+\s*\)/gu
const migratedServices = [
  'src/backend/Services/ArticleService.CacheAndInvalidation.cs',
  'src/backend/Services/ArticleService.LifecycleAndReadModels.cs',
  'src/backend/Services/ArticleService.cs',
  'src/backend/Services/Authoring/AuthoringAnalyticsReadService.cs',
  'src/backend/Services/Authoring/AuthoringAssetLibraryService.cs',
  'src/backend/Services/Authoring/AuthoringModerationWorkflowService.cs',
  'src/backend/Services/Background/ArticleMutationOutboxDispatcher.cs',
  'src/backend/Services/Background/ScheduledPublishWorker.cs',
  'src/backend/Services/CommentService.cs',
  'src/backend/Services/NotificationStream/MessageCenterService.cs',
  'src/backend/Services/Security/AdminPrincipalService.cs',
  'src/backend/Services/Security/AdminSessionValidationService.cs',
  'src/backend/Services/Security/BlacklistService.cs',
  'src/backend/Services/Security/CommentAnonymousNullifierService.cs',
  'src/backend/Services/Security/PasskeyService.cs',
  'src/backend/Services/Security/RecoveryKeyService.cs',
  'src/backend/Services/Security/SecurityPolicySnapshotService.cs',
  'src/backend/Services/Security/UserSessionValidationService.cs',
  'src/backend/Services/StatsService.cs',
  'src/backend/Services/UserService.cs',
]

test('generated projection schema is current and covers all 20 migrated services', async () => {
  const generated = spawnSync('node', ['tools/schema/generate-data-reader-projection-schema.mjs'], {
    cwd: root,
    encoding: 'utf8',
  })
  assert.equal(generated.status, 0, generated.stderr)
  const committed = await readFile(generatedPath, 'utf8')
  assert.equal(generated.stdout, committed)

  const schema = JSON.parse(committed)
  assert.equal(schema.sourceFileCount, 20)
  assert.equal(schema.projections.length, 20)
  assert.deepEqual(schema.projections.map(projection => projection.path), migratedServices)
  assert.ok(schema.projections.every(projection => projection.columns.length > 0))
  assert.ok(schema.projections.every(projection => projection.columns.every(column => column.accessors.length > 0)))
})

test('backend services contain no literal data-reader ordinal', async () => {
  const schema = JSON.parse(await readFile(generatedPath, 'utf8'))
  for (const projection of schema.projections) {
    const source = await readFile(path.join(root, projection.path), 'utf8')
    assert.deepEqual(source.match(literalOrdinal) ?? [], [], projection.path)
  }
})
