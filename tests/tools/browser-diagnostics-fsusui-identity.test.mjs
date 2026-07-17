import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  LOCAL_FSUSUI_IDENTITY_SCHEMA,
  resolveLocalFsusUiIdentity,
} from '../browser-diagnostics/local-fsusui-identity.mjs'

const root = path.resolve(import.meta.dirname, '../..')
const pinnedCommit = 'b967712bcb9dfc13babd49006451a46e2dcc4771'

function git(repository, ...args) {
  return execFileSync('git', ['-C', repository, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function write(repository, relativePath, contents) {
  const target = path.join(repository, relativePath)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, contents)
}

function createFixture(t) {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusui-identity-'))
  t.after(() => fs.rmSync(repository, { recursive: true, force: true }))
  git(repository, 'init', '--quiet', '--initial-branch=main')
  git(repository, 'config', 'user.name', 'FsusBlog fixture')
  git(repository, 'config', 'user.email', 'fixture@fsus.blog')
  write(repository, '.gitignore', 'vue/packages/theme-chalk/dist/\n')
  write(repository, 'vue/packages/element-plus/index.ts', 'export const version = "fixture"\n')
  write(repository, 'vue/packages/icons-vue/src/index.ts', 'export const FixtureIcon = {}\n')
  write(repository, 'vue/packages/components/public-shell/index.ts', 'export { default as ElPublicShell } from "./src/public-shell.vue"\n')
  write(repository, 'vue/packages/components/public-shell/src/public-shell.vue', '<template><main>fixture</main></template>\n')
  write(repository, 'vue/packages/utils/index.ts', 'export const withInstall = (value) => value\n')
  git(repository, 'add', '.')
  git(repository, 'commit', '--quiet', '-m', 'fixture')
  write(repository, 'vue/packages/theme-chalk/dist/index.css', ':root{--fixture:1}\n')
  write(repository, 'vue/packages/theme-chalk/dist/el-public-shell-critical.css', '.shell{display:grid}\n')
  write(repository, 'vue/packages/theme-chalk/dist/el-fsus-theme.css', '.shell{color:CanvasText}\n')
  return { repository, commit: git(repository, 'rev-parse', 'HEAD') }
}

test('workflow exports and checks out the exact pinned FsusUI identity', () => {
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/browser-diagnostics.yml'), 'utf8')
  const qualityGate = fs.readFileSync(path.join(root, '.github/workflows/quality-gate.yml'), 'utf8')
  assert.match(
    workflow,
    new RegExp(`FSUSBLOG_LOCAL_FSUSUI_EXPECTED_COMMIT: ${pinnedCommit}`, 'u'),
  )
  assert.match(workflow, /ref: \$\{\{ env\.FSUSBLOG_LOCAL_FSUSUI_EXPECTED_COMMIT \}\}/u)
  assert.match(workflow, /repository: Ozwasyd\/FsusUI[\s\S]*?token: \$\{\{ secrets\.GITHUB_PACKAGES_TOKEN \}\}[\s\S]*?persist-credentials: false/u)
  assert.match(workflow, /node tests\/browser-diagnostics\/local-fsusui-identity\.mjs/u)
  assert.match(qualityGate, /repository: Ozwasyd\/FsusUI[\s\S]*?token: \$\{\{ secrets\.GITHUB_PACKAGES_TOKEN \}\}[\s\S]*?persist-credentials: false/u)
})

test('local FsusUI identity is stable, path-independent and binds source plus generated theme dist', (t) => {
  const first = createFixture(t)
  const second = createFixture(t)
  const firstIdentity = resolveLocalFsusUiIdentity({
    root: first.repository,
    expectedCommit: first.commit,
  })
  const repeatedIdentity = resolveLocalFsusUiIdentity({
    env: {
      FSUSBLOG_LOCAL_FSUSUI_ROOT: first.repository,
      FSUSBLOG_LOCAL_FSUSUI_EXPECTED_COMMIT: first.commit,
    },
  })
  const secondIdentity = resolveLocalFsusUiIdentity({
    root: second.repository,
    expectedCommit: second.commit,
  })

  assert.deepEqual(repeatedIdentity, firstIdentity)
  assert.equal(firstIdentity.schema, LOCAL_FSUSUI_IDENTITY_SCHEMA)
  assert.equal(firstIdentity.commit, first.commit)
  assert.equal(firstIdentity.expectedCommit, first.commit)
  assert.equal(firstIdentity.worktreeState, 'clean')
  assert.equal(firstIdentity.source.fileCount, 5)
  assert.equal(firstIdentity.themeDist.fileCount, 3)
  assert.match(firstIdentity.source.sha256, /^sha256:[0-9a-f]{64}$/u)
  assert.match(firstIdentity.themeDist.sha256, /^sha256:[0-9a-f]{64}$/u)
  assert.match(firstIdentity.contentDigest, /^sha256:[0-9a-f]{64}$/u)
  assert.equal(secondIdentity.source.sha256, firstIdentity.source.sha256)
  assert.equal(secondIdentity.themeDist.sha256, firstIdentity.themeDist.sha256)

  write(first.repository, 'vue/packages/theme-chalk/dist/el-fsus-theme.css', '.shell{color:Highlight}\n')
  const rebuiltIdentity = resolveLocalFsusUiIdentity({
    root: first.repository,
    expectedCommit: first.commit,
  })
  assert.equal(rebuiltIdentity.source.sha256, firstIdentity.source.sha256)
  assert.notEqual(rebuiltIdentity.themeDist.sha256, firstIdentity.themeDist.sha256)
  assert.notEqual(rebuiltIdentity.contentDigest, firstIdentity.contentDigest)
})

test('local FsusUI identity rejects dirty, unpinned and incomplete inputs', (t) => {
  const fixture = createFixture(t)
  assert.throws(
    () => resolveLocalFsusUiIdentity({ root: fixture.repository, expectedCommit: '0'.repeat(40) }),
    /does not match expected commit/u,
  )

  write(fixture.repository, 'vue/packages/components/public-shell/index.ts', 'dirty\n')
  assert.throws(
    () => resolveLocalFsusUiIdentity({ root: fixture.repository, expectedCommit: fixture.commit }),
    /worktree must be clean/u,
  )
  git(fixture.repository, 'checkout', '--quiet', '--', 'vue/packages/components/public-shell/index.ts')
  write(fixture.repository, 'untracked.txt', 'untracked\n')
  assert.throws(
    () => resolveLocalFsusUiIdentity({ root: fixture.repository, expectedCommit: fixture.commit }),
    /worktree must be clean/u,
  )

  fs.rmSync(path.join(fixture.repository, 'untracked.txt'))
  fs.rmSync(path.join(fixture.repository, 'vue/packages/theme-chalk/dist/index.css'))
  assert.throws(
    () => resolveLocalFsusUiIdentity({ root: fixture.repository, expectedCommit: fixture.commit }),
    /identity input is missing/u,
  )
  assert.throws(
    () => resolveLocalFsusUiIdentity({ root: fixture.repository }),
    /must be a full lowercase Git commit/u,
  )
})
