#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const checkerPath = path.join(repoRoot, 'tools/check-historical-residue.sh')

const violationCases = [
  {
    name: 'legacy runtime bridge names',
    expected: 'legacy runtime bridge residue detected',
    files: {
      'src/backend/Compatibility/RuntimeBridgeResidue.cs': `
namespace FsusBlog.Server.Compatibility;
internal static class RuntimeBridgeResidue
{
    private const string AuthoringPrefix = "/_fsus/internal/binary-bridge/author";
    private const string Error = "authoring_legacy_envelope_invalid";
    private static void BridgeToLegacyAuthoringEndpointAsync() {}
}
`
    }
  },
  {
    name: 'old comment-create V1 paths',
    expected: 'old comment-create V1 residue detected',
    files: {
      'src/frontend/src/api/commentV1.ts': `
export const COMMENT_V1_PATH = '/api/Comment'
export type CommentCreateRequest = { articleId: string; content: string }
export function createCommentV1(dto: CommentCreateRequest) {
  return fetch(COMMENT_V1_PATH, { method: 'POST', body: JSON.stringify(dto) })
}
`
    }
  },
  {
    name: 'old author-mode aliases',
    expected: 'old author-mode alias residue detected',
    files: {
      'src/frontend/src/components/article/AuthorModeAlias.ts': `
export const authorModeAliases = {
  authorMode: 'guest',
  defaultAuthorMode: 'incognito'
}
`
    }
  },
  {
    name: 'old UI fixture fallbacks',
    expected: 'old UI fixture fallback residue detected',
    files: {
      'tests/frontend/fixtures/legacy-ui-fixture-fallback.ts': `
export const uiFixtureFallback = 'legacy-ui-fixture-fallback'
export const fallbackComponentRoot = 'src/frontend/src/components/ui/FsusUiFallbackFixtures'
`
    }
  },
  {
    name: 'old local package type shims',
    expected: 'old local package type shim residue detected',
    files: {
      'src/frontend/src/types/fsusui-local-shim.d.ts': `
${'declare'} module '@ozwasyd/element-plus' {
  export const LocalPackageTypeShim: unknown
}
`
    }
  },
  {
    name: 'old algorithm fallback switches',
    expected: 'old algorithm fallback switch residue detected',
    files: {
      'src/backend/Infrastructure/Helpers/Security/LegacyModernAcAutomaton.cs': `
namespace FsusBlog.Server.Infrastructure.Helpers.Security;
internal sealed class LegacyModernAcAutomaton
{
    private const string LegacyFeatureSwitchName = "FsusBlog.Security.ModernAcAutomaton.UseLegacyChildRange";
    private const string LegacyFeatureEnvName = "FSUSBLOG_SECURITY_MODERN_AC_USE_LEGACY_CHILD_RANGE";
}
`
    }
  }
]

const allowedMaintenanceFixture = {
  'src/backend/Infrastructure/Operations/LegacyIdentityColdStartResetOperation.cs': `
namespace FsusBlog.Server.Infrastructure.Operations;
internal sealed class LegacyIdentityColdStartResetOperation
{
    private const string Confirmation = "FSUSBLOG_CONFIRM_IDENTITY_RESET=DELETE_LEGACY_USERS";
}
`,
  'tools/db/verify-legacy-upgrade-20260517.sh': `
#!/usr/bin/env bash
set -euo pipefail
: "\${FSUS_LEGACY_20260517_DUMP_GZ:?legacy dump required}"
`,
  'tests/backend/Fixtures/legacy-20260517-minimal.sql': `
CREATE TABLE sys_user(id bigint primary key);
`
}

function writeFiles(root, files) {
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(root, relativePath)
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
    fs.writeFileSync(absolutePath, content.trimStart())
  }
}

function runChecker(root) {
  return spawnSync('bash', [checkerPath], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      FSUSBLOG_HISTORICAL_RESIDUE_ROOT: root
    }
  })
}

function fail(message, result) {
  console.error(`[historical-residue-fixture] ${message}`)
  if (result) {
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim()
    if (output) {
      console.error(output)
    }
  }
  process.exit(1)
}

function createFixtureRoot(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `fsusblog-${name.replaceAll(/\W+/g, '-')}-`))
}

for (const testCase of violationCases) {
  const fixtureRoot = createFixtureRoot(testCase.name)
  writeFiles(fixtureRoot, testCase.files)
  const result = runChecker(fixtureRoot)
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  if (result.status === 0) {
    fail(`expected ${testCase.name} fixture to fail`, result)
  }
  if (!output.includes(testCase.expected)) {
    fail(`expected ${testCase.name} output to include "${testCase.expected}"`, result)
  }
}

const allowedRoot = createFixtureRoot('allowed-maintenance')
writeFiles(allowedRoot, allowedMaintenanceFixture)
const allowedResult = runChecker(allowedRoot)
if (allowedResult.status !== 0) {
  fail('expected identity reset and database migration maintenance fixture to pass', allowedResult)
}

console.log(`[historical-residue-fixture] ok cases=${violationCases.length}`)
