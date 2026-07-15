import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const project = path.join(root, 'tools/security/FsusBlog.SecuritySourceAnalyzer/FsusBlog.SecuritySourceAnalyzer.csproj')
const policy = path.join(root, 'security/backend-source-policy.json')
const migratedSources = [
  'src/backend/Services/ArticleService.cs',
  'src/backend/Services/Authoring/AuthoringWorkflowService.cs',
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

function run(sources, noBuild = false, fixture = true) {
  return spawnSync('dotnet', [
    'run', '--project', project, '--verbosity', 'quiet',
    ...(noBuild ? ['--no-build', '--no-restore'] : []),
    '--', '--root', root, '--policy', policy,
    ...(fixture ? ['--fixture'] : []),
    ...sources.flatMap(source => ['--source', source]),
  ], { cwd: root, encoding: 'utf8' })
}

function report(result) {
  const offset = result.stdout.indexOf('{')
  assert.notEqual(offset, -1, result.stderr || result.stdout)
  return JSON.parse(result.stdout.slice(offset))
}

test('Roslyn governance rejects literal ordinals and accepts named projection access', () => {
  const positive = run(['tests/backend/Fixtures/data-reader-ordinal-analysis/positive.cs'])
  assert.equal(positive.status, 0, positive.stderr || positive.stdout)
  assert.deepEqual(report(positive).diagnostics, [])

  const negative = run(['tests/backend/Fixtures/data-reader-ordinal-analysis/negative.cs'], true)
  assert.equal(negative.status, 1, negative.stderr || negative.stdout)
  const diagnostics = report(negative).diagnostics
  assert.equal(diagnostics.length, 1)
  assert.equal(diagnostics[0].ruleId, 'FSUSBLOGDATA001')

  const migrated = run(migratedSources, true, false)
  assert.equal(migrated.status, 0, migrated.stderr || migrated.stdout)
  assert.deepEqual(report(migrated).diagnostics, [])
})
