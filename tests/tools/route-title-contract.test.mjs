import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '../..')
const frontendRoot = path.join(root, 'src/frontend')
const tsc = path.join(frontendRoot, 'node_modules/.bin/tsc')

const compileFixture = async (source) => {
  const directory = await mkdtemp(path.join(frontendRoot, '.route-title-contract-typecheck-'))
  try {
    await writeFile(path.join(directory, 'consumer.ts'), source)
    return spawnSync(tsc, [path.join(directory, 'consumer.ts'), '--ignoreConfig', '--noEmit', '--strict', '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler', '--skipLibCheck'], { cwd: frontendRoot, encoding: 'utf8' })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('route title contracts accept dedicated title keys and reject other ordinary/plural keys', async () => {
  const result = await compileFixture("import { staticRouteTitle } from '../src/router/routeTitleContract.js'\nimport type { RouteTitleContract } from '../src/router/routeTitleContract.js'\nconst valid = staticRouteTitle('common.routeTitles.login')\nvoid valid\n// @ts-expect-error unknown keys cannot become route title identity\nstaticRouteTitle('untrusted.translation.key')\n// @ts-expect-error plural keys cannot become route title identity\nstaticRouteTitle('public.archive.publishedCount')\n// @ts-expect-error an aria label is ordinary copy, not a dedicated RouteTitleKey\nstaticRouteTitle('admin.moderationReplay.inputRegionAriaLabel')\n// @ts-expect-error an action label is ordinary copy, not a dedicated RouteTitleKey\nstaticRouteTitle('common.actions.save')\n// @ts-expect-error named routes cannot omit their title contract\nconst missing: RouteTitleContract = {}\nvoid missing\n// @ts-expect-error titleKey and site-only are mutually exclusive\nconst dual: RouteTitleContract = { titleKey: 'common.routeTitles.login', titleMode: 'site-only' }\nvoid dual\n")
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
})
