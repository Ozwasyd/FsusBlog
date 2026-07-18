import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '../..')
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8')

test('geometry diagnostics split the isolated FsusUI harness from archive integration', () => {
  const lane = read('tools/test/lanes/browser-geometry-motion-diagnostics.sh')
  const config = read('tests/browser-diagnostics/harness/vite.config.ts')
  const entry = read('tests/browser-diagnostics/harness/main.ts')
  const spec = read('tests/frontend/e2e/diagnostics/public-mobile-menu-harness.spec.ts')

  assert.match(lane, /diagnostics\/public-mobile-menu-harness\.spec\.ts/u)
  assert.match(lane, /acceptance\/archive-sticky-geometry\.spec\.ts/u)
  assert.doesNotMatch(lane, /acceptance\/public-mobile-menu-motion\.spec\.ts/u)
  assert.ok(
    lane.indexOf('diagnostics/public-mobile-menu-harness.spec.ts')
      < lane.indexOf('RequireReleasePreview'),
    'the isolated harness must execute before release-preview is required',
  )
  assert.match(lane, /--workers=1/u)
  assert.match(lane, /--retries=0/u)
  assert.doesNotMatch(lane, /os\.(?:availableParallelism|loadavg)|maxFailures|fullyParallel/u)
  assert.match(lane, /isolated-component-harness/u)
  assert.match(lane, /release-preview-integration/u)
  assert.match(lane, /excludes:\s*\["fsusblog-backend", "postgresql", "redis", "release-preview"\]/u)
  assert.match(lane, /CANONICAL_EVIDENCE_ROOT=.*browser-diagnostics-runtime\/geometry-motion-focus/u)
  assert.match(lane, /SUMMARY_FILE="\$CANONICAL_EVIDENCE_ROOT\/geometry-motion-focus-summary\.json"/u)
  assert.match(lane, /if \(RequireReleasePreview\); then/u)
  assert.match(lane, /infra-failure: release preview is unavailable/u)
  assert.doesNotMatch(lane, /WriteSummary[\s\S]*?\|\| true/u)

  assert.match(config, /resolveLocalFsusUiRoot/u)
  assert.match(config, /createFsusUiAliases/u)
  assert.match(entry, /ElPublicShell/u)
  assert.match(entry, /@element-plus\/components\/public-shell/u)
  assert.match(entry, /@ozwasyd\/element-plus\/dist\/public-shell-critical\.css/u)
  assert.doesNotMatch(entry, /@ozwasyd\/element-plus\/dist\/index\.css/u)
  assert.match(spec, /getComputedStyle/u)
  assert.match(spec, /reduced motion removes displacement/u)
  assert.match(spec, /toBeFocused/u)
})
