import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import {
  resolveAuthFixtureDirectory,
  resolveAuthFixtureManifest,
  resolveFixtureNamespace,
  resolveFixtureRoot,
  resolvePublicFixtureFile
} from '../frontend/support/fixture-paths.mjs'
import { BrowserContractFailure, contractAssert } from './contract.mjs'

export const browserContractFixtureAdapterSchema = 'fsusblog.browser-contract-fixture-adapter.v1'

function decodePublicFixture(raw) {
  const values = {}
  for (const line of raw.split(/\r?\n/u)) {
    const separator = line.indexOf('\t')
    if (separator <= 0) continue
    const key = line.slice(0, separator).trim()
    const encoded = line.slice(separator + 1).trim()
    if (!key || !encoded) continue
    values[key] = Buffer.from(encoded, 'base64url').toString('utf8')
  }
  return values
}

function resolveStorageStateFile(authDirectory, descriptor, role) {
  const relative = String(descriptor?.storageStateFile ?? '').trim()
  contractAssert(relative && path.basename(relative) === relative, `${role} storage state filename is invalid`)
  const file = path.resolve(authDirectory, relative)
  contractAssert(file.startsWith(`${path.resolve(authDirectory)}${path.sep}`), `${role} storage state escapes fixture root`)
  contractAssert(existsSync(file), `${role} storage state is missing: ${relative}`)
  return file
}

async function loadPortableStorageState(file, baseUrl, role) {
  let source
  try {
    source = JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    throw new BrowserContractFailure(`${role} storage state is not valid JSON`, 'contract', {
      message: error instanceof Error ? error.message : String(error)
    })
  }

  contractAssert(Array.isArray(source?.cookies), `${role} storage state cookies are invalid`)
  contractAssert(Array.isArray(source?.origins), `${role} storage state origins are invalid`)
  const runtimeOrigin = new URL(baseUrl).origin
  const allowSecureCookies = runtimeOrigin.startsWith('https://')
  const cookies = source.cookies
    .filter((cookie) => allowSecureCookies || cookie?.secure !== true)
    .map((cookie) => {
      contractAssert(
        typeof cookie?.name === 'string' && typeof cookie?.value === 'string',
        `${role} storage state cookie is invalid`
      )
      const { domain: _domain, path: _path, url: _url, ...portable } = cookie
      return { ...portable, url: runtimeOrigin }
    })
  contractAssert(cookies.length > 0, `${role} storage state has no cookies valid for ${runtimeOrigin}`)

  return Object.freeze({
    cookies: Object.freeze(cookies),
    origins: Object.freeze(source.origins.map((origin) => ({
      ...origin,
      origin: runtimeOrigin
    })))
  })
}

export async function loadBrowserContractFixture({ env = process.env, repoRoot = process.cwd() } = {}) {
  const fixtureRoot = resolveFixtureRoot({ env, repoRoot })
  const publicFixtureFile = resolvePublicFixtureFile({ env, repoRoot })
  const authFixtureFile = resolveAuthFixtureManifest({ env, repoRoot })
  const authDirectory = resolveAuthFixtureDirectory({ env, repoRoot })

  if (!existsSync(publicFixtureFile) || !existsSync(authFixtureFile)) {
    throw new BrowserContractFailure(
      `browser contract fixture is incomplete under ${fixtureRoot}; prepare one immutable namespace before launch`,
      'contract',
      { publicFixtureFile, authFixtureFile }
    )
  }

  const publicFixture = decodePublicFixture(await readFile(publicFixtureFile, 'utf8'))
  const authFixture = JSON.parse(await readFile(authFixtureFile, 'utf8'))
  const articleId = String(publicFixture.articleId ?? '').trim()
  const articleTitle = String(publicFixture.articleTitle ?? '').trim()
  contractAssert(/^\d+$/u.test(articleId), 'browser contract public article id must be numeric')
  contractAssert(articleTitle.length > 0, 'browser contract public article title is missing')
  contractAssert(Number.isInteger(Number(authFixture.user?.id)) && Number(authFixture.user.id) > 0, 'browser contract user fixture is invalid')
  contractAssert(Number.isInteger(Number(authFixture.admin?.id)) && Number(authFixture.admin.id) > 0, 'browser contract admin fixture is invalid')

  const baseUrl = String(
    env.PLAYWRIGHT_BASE_URL
      || env.FSUSBLOG_PUBLIC_BASE_URL
      || env.FSUSBLOG_DEBUG_FRONTEND_URL
      || 'http://127.0.0.1:3000'
  ).replace(/\/+$/u, '')
  const backendUrl = String(
    env.FSUSBLOG_ACCEPTANCE_BACKEND_URL
      || env.FSUSBLOG_BASE_URL
      || env.FSUSBLOG_DEBUG_BACKEND_URL
      || 'http://127.0.0.1:7568'
  ).replace(/\/+$/u, '')

  try {
    new URL(baseUrl)
    new URL(backendUrl)
  } catch (error) {
    throw new BrowserContractFailure('browser contract fixture contains an invalid runtime URL', 'contract', {
      message: error instanceof Error ? error.message : String(error)
    })
  }

  const userStorageStateFile = resolveStorageStateFile(authDirectory, authFixture.user, 'user')
  const adminStorageStateFile = resolveStorageStateFile(authDirectory, authFixture.admin, 'admin')
  const [userStorageState, adminStorageState] = await Promise.all([
    loadPortableStorageState(userStorageStateFile, baseUrl, 'user'),
    loadPortableStorageState(adminStorageStateFile, baseUrl, 'admin')
  ])

  return Object.freeze({
    schema: browserContractFixtureAdapterSchema,
    namespace: resolveFixtureNamespace(env),
    root: fixtureRoot,
    generatedAt: String(authFixture.generatedAt ?? publicFixture.generatedAt ?? ''),
    baseUrl,
    backendUrl,
    testSession: String(env.FSUSBLOG_TEST_SESSION ?? '').trim() || null,
    publicArticle: Object.freeze({ id: articleId, title: articleTitle }),
    category: Object.freeze({
      id: String(publicFixture.categoryId ?? '').trim(),
      name: String(env.FSUSBLOG_PLAYWRIGHT_CATEGORY_NAME ?? 'Acceptance Category')
    }),
    capabilities: Object.freeze({
      webAuthnRegistration: authFixture.capabilities?.webAuthnRegistration === true
    }),
    user: Object.freeze({
      id: Number(authFixture.user.id),
      storageStateFile: userStorageStateFile,
      storageState: userStorageState
    }),
    admin: Object.freeze({
      id: Number(authFixture.admin.id),
      storageStateFile: adminStorageStateFile,
      storageState: adminStorageState
    })
  })
}

export function fixtureReceiptView(fixture, repoRoot = process.cwd()) {
  const relative = (value) => path.relative(repoRoot, value).replaceAll(path.sep, '/')
  return {
    schema: fixture.schema,
    namespace: fixture.namespace,
    generatedAt: fixture.generatedAt,
    publicArticleId: fixture.publicArticle.id,
    categoryId: fixture.category.id,
    userId: fixture.user.id,
    adminId: fixture.admin.id,
    capabilities: fixture.capabilities,
    root: relative(fixture.root),
    userStorageState: relative(fixture.user.storageStateFile),
    adminStorageState: relative(fixture.admin.storageStateFile)
  }
}
