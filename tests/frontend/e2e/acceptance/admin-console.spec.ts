import path from 'node:path'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { expect, test } from '@playwright/test'
import type { Page, StorageState } from '@playwright/test'
import {
  DESKTOP_VIEWPORT,
  MOBILE_VIEWPORT,
  adminName,
  adminPassword,
  captureStorageState,
  openAuditedPage,
  prewarmDevRuntime,
  assertElementHitTarget,
  assertElementInViewport,
  assertNoHorizontalOverflow,
  assertResponsiveLayoutContract,
  assertSectionsDoNotOverlap,
  assertTableLayout,
  assertToastInViewport,
  expectAnyToastText,
  fixtures,
  expectRouteAndShell,
  settlePage,
  waitForAppReady
} from '../../support/playwright/acceptance-shared'
import { encodeAedsFrame, readAedsResponse } from '../../support/aeds-envelope.mjs'
import { resolveTestSession, testSessionHeaders } from '../../support/playwright/testSession'
import { encodeAuthoringJsonRequest, mapAuthoringJsonFromPayload } from '../../../../src/frontend/src/adapters/binary/authoringAdapter'
import { FrameType } from '../../../../src/frontend/wasm/web/protocol/frame'

const createdArticleTitle = `Acceptance Article ${Date.now()}`
const articleCoverFixturePath = path.resolve(process.cwd(), '../../tests/frontend/fixtures/assets/article-cover-16x9.png')
const acceptanceBackendUrl = process.env.FSUSBLOG_ACCEPTANCE_BACKEND_URL
  || process.env.FSUSBLOG_BASE_URL
  || process.env.FSUSBLOG_DEBUG_BACKEND_URL
  || 'http://127.0.0.1:7568'
const acceptanceFrontendOrigin = new URL(process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3000').origin
const acceptancePgContainer = process.env.FSUSBLOG_PG_CONTAINER || ''
const acceptanceRedisContainer = process.env.FSUSBLOG_REDIS_CONTAINER || process.env.FSUSBLOG_REDIS_CONTAINER_NAME || ''
const execFileAsync = promisify(execFile)
let adminStorageStatePromise: Promise<Awaited<ReturnType<typeof captureStorageState>>> | null = null
const localAuthFixtureSecret = process.env.FSUSBLOG_LOCAL_AUTH_FIXTURE_SECRET
  || process.env.fsus__localAuthFixtureSecret
  || 'local-development-auth-fixture-secret-change-before-shared-use-2026'

const cookieHeaderFromStorageState = (state: StorageState): string =>
  state.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ')

const runtimeCacheKey = (key: string): string => {
  const session = resolveTestSession()
  return session ? `e2e:${session}:${key}` : key
}

const installAdminSensitiveProof = async (page: Page, _state?: StorageState): Promise<void> => {
  const proofToken = await page.evaluate(async (secret) => {
    const response = await fetch('/api/local/auth-fixture/admin-sensitive-proof', {
      cache: 'no-store',
      credentials: 'include',
      method: 'POST',
      headers: {
        'X-Fsus-Local-Auth-Fixture-Secret': secret
      }
    })
    if (!response.ok) {
      throw new Error(`admin sensitive proof fixture failed: ${response.status}`)
    }

    const body = await response.json() as { action?: string, proofToken?: string }
    const token = body.proofToken?.trim()
    if (body.action !== 'admin-sensitive' || !token) {
      throw new Error('admin sensitive proof fixture returned an invalid token')
    }

    return token
  }, localAuthFixtureSecret)
  await page.evaluate((token) => {
    ;(window as Window & { __FSUSBLOG_ADMIN_SENSITIVE_PROOF_TOKEN__?: string }).__FSUSBLOG_ADMIN_SENSITIVE_PROOF_TOKEN__ = token
  }, proofToken)
}

const serverDraftPath = (draftKey: string): string => `/api/binary/author/drafts/${encodeURIComponent(draftKey)}`

const assertLocalAcceptanceBackend = (): void => {
  const url = new URL(acceptanceBackendUrl)
  if (!['localhost', '127.0.0.1', '::1'].includes(url.hostname)) {
    throw new Error('admin acceptance cleanup may only replay cookies against a local backend')
  }
}

const assertLocalAcceptancePgContainer = (): void => {
  if (!/^fsusblog-(?:dev|test|ci)(?:[-_.a-zA-Z0-9]*)$/.test(acceptancePgContainer)) {
    throw new Error('FSUSBLOG_PG_CONTAINER must name a dev/test/ci fixture container for acceptance reset SQL')
  }
}

const assertLocalAcceptanceRedisContainer = (): void => {
  if (!/^fsusblog-(?:dev|test|ci)(?:[-_.a-zA-Z0-9]*)$/.test(acceptanceRedisContainer)) {
    throw new Error('FSUSBLOG_REDIS_CONTAINER must name a dev/test/ci fixture container for acceptance reset cache')
  }
}

const discardServerDraft = async (state: StorageState, draftKey: string): Promise<void> => {
  assertLocalAcceptanceBackend()
  await fetch(`${acceptanceBackendUrl}${serverDraftPath(draftKey)}`, {
    method: 'DELETE',
    headers: {
      Accept: 'application/octet-stream',
      Origin: acceptanceFrontendOrigin,
      Cookie: cookieHeaderFromStorageState(state),
      ...testSessionHeaders()
    }
  })
}

const readServerDraftTitle = async (state: StorageState, draftKey: string): Promise<string | null> => {
  assertLocalAcceptanceBackend()
  const response = await fetch(`${acceptanceBackendUrl}${serverDraftPath(draftKey)}`, {
    headers: {
      Accept: 'application/octet-stream',
      Origin: acceptanceFrontendOrigin,
      Cookie: cookieHeaderFromStorageState(state),
      ...testSessionHeaders()
    }
  })
  if (!response.ok) {
    return null
  }

  const draft = await readAuthoringJsonResponse<{ title?: string | null }>(response)
  return draft?.title ?? null
}

const resetLocalAcceptanceUserStatus = async (username: string): Promise<void> => {
  if (process.env.FSUSBLOG_RESET_SECURITY_TEST_STATE === '0') {
    return
  }

  const normalizedHandle = username.trim().toLowerCase()
  const accountSubjectHash = createHash('sha256')
    .update(`fsus:account-subject:v1:anonymous_account:${normalizedHandle}`, 'utf8')
    .digest('hex')

  try {
    assertLocalAcceptancePgContainer()
    await execFileAsync('docker', [
      'exec',
      acceptancePgContainer,
      'psql',
      '-U',
      'fsusblog',
      '-d',
      'fsusblog',
      '-c',
      `UPDATE sys_user SET status = 0, banreason = NULL WHERE public_handle = '${username.replace(/'/g, "''")}'`
    ], { timeout: 5000 })
  } catch {
    // Non-local environments may not use the developer docker container name.
  }

  try {
    assertLocalAcceptanceRedisContainer()
    await execFileAsync('docker', [
      'exec',
      acceptanceRedisContainer,
      'redis-cli',
      'DEL',
      `fsus:sec:blacklist-user:account:${accountSubjectHash}`,
      runtimeCacheKey(`fsus:sec:blacklist-user:account:${accountSubjectHash}`),
      `account:state:${accountSubjectHash}`,
      runtimeCacheKey(`account:state:${accountSubjectHash}`)
    ], { timeout: 5000 })
  } catch {
    // Non-local environments may not use the developer docker container name.
  }
}

const postAuthorPreview = async (payload: unknown, state?: StorageState): Promise<Response> => fetch(`${acceptanceBackendUrl}/api/binary/author/preview`, {
  method: 'POST',
  headers: {
    Accept: 'application/octet-stream',
    'Content-Type': 'application/octet-stream',
    Origin: acceptanceFrontendOrigin,
    'X-Fsus-Device-Fp': 'acceptance-private-preview',
    ...(state ? { Cookie: cookieHeaderFromStorageState(state) } : {})
  },
  body: encodeAedsFrame(FrameType.ArticlePreviewRequest, encodeAuthoringJsonRequest(payload))
})

const readAuthoringJsonResponse = async <T = unknown>(response: Response): Promise<T> => {
  const decoded = await readAedsResponse(response)
  if (decoded && typeof decoded === 'object' && 'payload' in decoded && decoded.payload instanceof Uint8Array) {
    return mapAuthoringJsonFromPayload<T>(decoded.payload)
  }

  return decoded as T
}

const markdownEditor = (page: Page) => page
  .getByRole('textbox', { name: 'Markdown 正文编辑区' })
  .or(page.getByPlaceholder('写下正文，支持 Markdown 内容...'))
  .or(page.getByPlaceholder('从这里开始写正文。'))
  .first()

const articleTitleInput = (page: Page) => page
  .getByPlaceholder(/写下文章标题|在此键入博文标题/u)
  .first()

async function ensureArticleCategorySelected(page: Page): Promise<void> {
  const visibleAcceptanceCategory = page.getByText('Acceptance Category', { exact: true }).first()
  if (await visibleAcceptanceCategory.isVisible().catch(() => false)) {
    return
  }

  const categoryInput = page.getByPlaceholder('选择分类').first()
  await categoryInput.click()
  const acceptanceOption = page.getByRole('option', { name: 'Acceptance Category' })
  if (await acceptanceOption.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await acceptanceOption.click()
    return
  }

  await page.locator('.el-select-dropdown__item:visible, [role="option"]:visible').first().click()
}

async function ensureInspectorSectionOpen(page: Page, sectionLabel: string, visibleLocator: Locator): Promise<void> {
  if (await visibleLocator.isVisible().catch(() => false)) {
    return
  }

  const sidebar = page.getByRole('complementary', { name: '文章检查器' })
  await sidebar.getByRole('button', { name: new RegExp(sectionLabel) }).first().click()
  await expect(visibleLocator).toBeVisible()
}

for (const viewport of [
  { name: 'desktop', size: DESKTOP_VIEWPORT },
  { name: 'mobile', size: MOBILE_VIEWPORT }
]) {
  test.describe(`admin console acceptance (${viewport.name})`, () => {
    test.use({ viewport: viewport.size })
    test.describe.configure({ timeout: 360_000 })

    let storageState: Awaited<ReturnType<typeof captureStorageState>>

    test.beforeAll(async ({ browser }) => {
      adminStorageStatePromise ??= (async () => {
        await prewarmDevRuntime(browser)
        return await captureStorageState(browser, adminName, adminPassword, '/user/manage')
      })()
      storageState = await adminStorageStatePromise
    })

    test('visible admin routes render cleanly', async ({ browser }) => {
      const expectations = [
        {
          path: '/user/manage',
          expectedUrl: '/user/manage',
          label: 'manage-dashboard',
          selectors: [
            (page) => page.locator('main .account-page-title'),
            (page) => page.getByText('回收站状态', { exact: false })
          ]
        },
        {
          path: '/user/manage/article/list',
          expectedPathname: '/user/manage/article/list',
          label: 'manage-article-list',
          selectors: [
            (page) => page.getByRole('button', { name: '写新文章' }),
            (page) => page.locator('.blog-scroll-x-safe .el-table')
          ]
        },
        {
          path: '/user/manage/article/trash',
          expectedUrl: '/user/manage/article/trash',
          label: 'manage-trash',
          selectors: [
            (page) => page.getByRole('heading', { name: '回收站' }),
            (page) => page.locator('main')
          ]
        },
        {
          path: '/user/manage/category',
          expectedUrl: '/user/manage/category',
          label: 'manage-category',
          selectors: [
            (page) => page.getByRole('heading', { name: '分类管理' }),
            (page) => page.getByRole('button', { name: '新增分类' })
          ]
        },
        {
          path: '/user/manage/tag',
          expectedUrl: '/user/manage/tag',
          label: 'manage-tag',
          selectors: [
            (page) => page.getByRole('heading', { name: '标签管理' }),
            (page) => page.getByRole('button', { name: '创建标签' })
          ]
        },
        {
          path: '/user/manage/settings',
          expectedUrl: '/user/manage/settings',
          label: 'manage-settings',
          selectors: [
            (page) => page.getByText('SEO 配置', { exact: false }),
            (page) => page.getByText('页面编辑', { exact: false })
          ]
        },
        {
          path: '/user/manage/users',
          expectedUrl: '/user/manage/users',
          label: 'manage-users',
          selectors: [
            (page) => page.getByRole('heading', { name: '用户管理' }),
            (page) => page.getByRole('button', { name: '查询' })
          ]
        },
        {
          path: '/user/manage/messages',
          expectedUrl: '/user/manage/messages',
          label: 'manage-message-center',
          selectors: [
            (page) => page.getByText('站内信中心', { exact: false }),
            (page) => page.getByText('发送系统消息', { exact: false })
          ]
        }
      ]

      const session = await openAuditedPage(browser, storageState)
      try {
        for (const route of expectations) {
          await expectRouteAndShell(session.page, session.audit, route)
          await assertResponsiveLayoutContract(session.page, route.label)
        }
      } finally {
        await session.close()
      }
    })

    test('audit log facet summary supports quick filter URL toggle', async ({ browser }) => {
      const session = await openAuditedPage(browser, storageState)
      try {
        await session.page.goto('/user/manage/audit', { waitUntil: 'domcontentloaded' })
        await waitForAppReady(session.page)
        await settlePage(session.page)

        await expect(session.page.getByRole('list', { name: '动作 facet 过滤' })).toBeVisible()
        await expect(session.page.getByRole('list', { name: '结果 facet 过滤' })).toBeVisible()
        await expect(session.page.getByRole('list', { name: '严重度 facet 过滤' })).toBeVisible()

        const actionButtons = session.page.getByRole('list', { name: '动作 facet 过滤' }).getByRole('button')
        await expect(actionButtons.first()).toBeVisible()
        await actionButtons.first().click()

        await expect
          .poll(() => session.page.evaluate(() => new URL(location.href).searchParams.get('action')))
          .not.toBeNull()
        await expect(session.page.getByRole('list', { name: '动作 facet 过滤' }).getByRole('button', { pressed: true }).first()).toBeVisible()

        await session.page.getByRole('list', { name: '动作 facet 过滤' }).getByRole('button', { pressed: true }).first().click()
        await expect
          .poll(() => session.page.evaluate(() => new URL(location.href).searchParams.get('action')))
          .toBeNull()

        await assertNoHorizontalOverflow(session.page)
      } finally {
        await session.close()
      }
    })

    test('dashboard, article write and admin workbench actions stay usable', async ({ browser }) => {
      await discardServerDraft(storageState, 'fsus:article-draft:create')
      const session = await openAuditedPage(browser, storageState)
      try {
        const articleTitle = `${createdArticleTitle} ${viewport.name}`
        const privatePreviewBoundaryTitle = `Private Preview Boundary ${Date.now()} ${viewport.name}`
        const privatePreviewPayload = {
          draftKey: 'fsus:article-draft:create',
          articleId: null,
          title: privatePreviewBoundaryTitle,
          content: '## Private Boundary\n\nPreview-only markdown body.',
          summary: 'Private preview boundary summary',
          coverImageUrl: null,
          categoryId: 1,
          tagIds: [],
          clientRevision: `preview-${Date.now()}`,
          status: 0,
          scheduledPublishAt: null
        }
        const anonymousPreviewResponse = await postAuthorPreview(privatePreviewPayload)
        expect([401, 403, 404], 'anonymous preview request should be denied').toContain(anonymousPreviewResponse.status)
        const adminPreviewResponse = await postAuthorPreview(privatePreviewPayload, storageState)
        expect(adminPreviewResponse.ok, 'admin private preview request should succeed').toBe(true)
        const adminPreviewEnvelope = await readAuthoringJsonResponse<{ html?: string }>(adminPreviewResponse)
        expect(adminPreviewEnvelope?.html, 'private preview html should carry preview-only marker').toContain('data-preview-only="true"')
        for (const publicPath of ['/feed/rss.xml', '/sitemap.xml']) {
          const publicResponse = await fetch(`${acceptanceBackendUrl}${publicPath}`)
          const publicText = await publicResponse.text()
          expect(publicText, `${publicPath} should not expose private preview title`).not.toContain(privatePreviewBoundaryTitle)
        }

        const start = session.audit.checkpoint()
        await session.page.goto('/user/manage', { waitUntil: 'domcontentloaded' })
        await waitForAppReady(session.page)
        await settlePage(session.page)
        await expect(session.page.getByText('评论审核')).toBeVisible()

        const analyticsPanel = session.page.locator('.dashboard-analytics-grid, .dashboard-analytics').first()
        const operationsPanel = session.page.locator('.dashboard-operations-panel, [data-testid=\"dashboard-operations-panel\"]').first()
        if (await analyticsPanel.count() && await operationsPanel.count()) {
          await assertSectionsDoNotOverlap([
            { locator: analyticsPanel, label: 'dashboard analytics' },
            { locator: operationsPanel, label: 'dashboard operations' }
          ])
        }
        await assertNoHorizontalOverflow(session.page)
        await assertResponsiveLayoutContract(session.page, 'manage-dashboard')

        const routeStart = session.audit.checkpoint()
        await session.page.goto('/user/manage/article/write', { waitUntil: 'domcontentloaded' })
        await waitForAppReady(session.page)
        await settlePage(session.page)
        const discardDraftButton = session.page.getByRole('button', { name: '丢弃服务端草稿' })
        if (await discardDraftButton.isVisible().catch(() => false)) {
          await discardDraftButton.click()
          await expect(discardDraftButton).not.toBeVisible()
        }

        await articleTitleInput(session.page).fill(articleTitle)
        await markdownEditor(session.page).fill('## Acceptance\n\n这是一篇自动验收生成的博文，用于验证发布主链。')
        await ensureArticleCategorySelected(session.page)
        await session.page.getByRole('button', { name: '预览' }).click()
        const previewResponsePromise = session.page.waitForResponse((response) => {
          const request = response.request()
          const url = new URL(response.url())
          return request.method() === 'POST' && url.pathname === '/api/binary/author/preview'
        })
        await session.page.getByRole('button', { name: '生成私有预览', exact: true }).click()
        const previewResponse = await previewResponsePromise
        expect(previewResponse.ok(), 'private preview request should succeed').toBe(true)
        const privatePreviewFrame = session.page.frameLocator('iframe[title="私有预览渲染结果"]').first()
        await expect(privatePreviewFrame.locator('article[data-preview-only="true"]')).toBeVisible()
        await expect(privatePreviewFrame.locator('h2')).toContainText('Acceptance')
        const publishSidebar = session.page.getByRole('complementary', { name: '文章检查器' })
        void articleCoverFixturePath
        const uploadedCoverUrl: string | null = null
        await ensureInspectorSectionOpen(session.page, '发布', publishSidebar.locator('input[name="articleStatus"]').first())
        const submitButton = session.page.getByRole('button', { name: /发布文章|立即发布|确认更新/ }).first()
        await assertElementHitTarget(session.page, submitButton, 'article publish button')
        await assertResponsiveLayoutContract(session.page, 'manage-article-write')
        const prepublishResponsePromise = session.page.waitForResponse((response) => {
          const request = response.request()
          const url = new URL(response.url())
          return request.method() === 'POST' && url.pathname === '/api/binary/author/prepublish-check'
        })
        const createArticleResponsePromise = session.page.waitForResponse((response) => {
          const request = response.request()
          const url = new URL(response.url())
          return request.method() === 'POST' && url.pathname === '/api/binary/admin/article'
        })
        await submitButton.click()
        const prepublishResponse = await prepublishResponsePromise
        expect(prepublishResponse.ok(), 'prepublish SEO check should succeed before confirmation').toBe(true)
        await expect(session.page.getByLabel('发布前警告跳过确认')).toBeVisible()
        await session.page.locator('textarea[placeholder*="说明本次接受"]').fill('Acceptance publishes without a hand-written summary for this smoke article.')
        await session.page.getByRole('dialog', { name: '发布确认' })
          .getByRole('button', { name: /发布文章|确认发布/ })
          .click()
        const createArticleResponse = await createArticleResponsePromise
        expect(createArticleResponse.ok(), 'article create request should succeed').toBe(true)
        const createArticlePayload = await readAedsResponse(createArticleResponse)
        const createdArticleId = Number(createArticlePayload?.id)
        expect(createdArticleId, 'created article id should be returned').toBeGreaterThan(0)
        await expect(session.page).toHaveURL(/\/user\/manage\/article\/list(?:\?.*)?$/)
        const createdArticleRow = session.page.locator('.blog-scroll-x-safe .el-table').getByText(articleTitle, { exact: false }).first()
        await expect
          .poll(async () => {
            const toastTexts = await session.page.locator('.el-message').allTextContents()
            const hasExpectedToast = toastTexts.some((text) => /博文已上线发布|文章已保存，但公开页缓存同步失败/.test(text))
            const hasCreatedArticle = await createdArticleRow.isVisible().catch(() => false)
            return hasExpectedToast || hasCreatedArticle
          }, { message: 'article publish should surface either a success/warning toast or the created article row' })
          .toBe(true)
        if (await session.page.locator('.el-message').count()) {
          const toastTexts = await session.page.locator('.el-message').allTextContents()
          if (toastTexts.some((text) => /博文已上线发布|文章已保存，但公开页缓存同步失败/.test(text))) {
            await assertToastInViewport(session.page)
          }
        }
        await session.page.goto(`/user/manage/article/edit/${createdArticleId}`, { waitUntil: 'domcontentloaded' })
        await expect(session.page).toHaveURL(/\/user\/manage\/article\/edit\/\d+$/)
        await waitForAppReady(session.page)
        await settlePage(session.page)
        if (uploadedCoverUrl) {
          const persistedCoverPreview = session.page.locator('img[alt="当前头图预览"]').first()
          await expect(persistedCoverPreview).toBeVisible()
          await expect(persistedCoverPreview).toHaveAttribute('src', uploadedCoverUrl)
        }
        if (viewport.size.width >= 640) {
          const firstVersionButton = session.page.getByRole('button', { name: /版本 1 ·/ })
          await ensureInspectorSectionOpen(session.page, '版本', firstVersionButton)
          const updatedArticleTitle = `${articleTitle} revision`
          const updatedArticleBody = '## Acceptance\n\n这是一篇自动验收生成的修订版本，用于验证历史版本比较与回滚。'
          await articleTitleInput(session.page).fill(updatedArticleTitle)
          await markdownEditor(session.page).fill(updatedArticleBody)
          const updateResponsePromise = session.page.waitForResponse((response) => {
            const request = response.request()
            const url = new URL(response.url())
            return request.method() === 'PUT' && url.pathname === `/api/binary/admin/article/${createdArticleId}`
          })
          const updateSubmitButton = session.page.getByRole('button', { name: /更新文章|确认更新/ }).first()
          await assertElementHitTarget(session.page, updateSubmitButton, 'article update button')
          await updateSubmitButton.click()
          const updateDialog = session.page.getByRole('dialog', { name: '更新确认' })
          const updateWarningReason = updateDialog.locator('textarea[placeholder*="说明本次接受"]')
          if (await updateWarningReason.isVisible().catch(() => false)) {
            await updateWarningReason.fill('Acceptance keeps the generated article without a cover image for this smoke update.')
          }
          await updateDialog.getByRole('button', { name: /更新文章|确认更新/ }).click()
          const updateResponse = await updateResponsePromise
          expect(updateResponse.ok(), 'article update request should succeed').toBe(true)
          await expect(session.page).toHaveURL(/\/user\/manage\/article\/list(?:\?.*)?$/)

          await session.page.goto(`/user/manage/article/edit/${createdArticleId}`, { waitUntil: 'domcontentloaded' })
          await waitForAppReady(session.page)
          await settlePage(session.page)
          await ensureInspectorSectionOpen(session.page, '版本', session.page.getByRole('button', { name: /版本 2 ·/ }))
          await session.page.getByRole('button', { name: /版本 1 ·/ }).click()
          await expect(session.page.getByText(/正文长度/)).toBeVisible()
          await installAdminSensitiveProof(session.page, storageState)
          const rollbackResponsePromise = session.page.waitForResponse((response) => {
            const request = response.request()
            const url = new URL(response.url())
            return request.method() === 'POST'
              && url.pathname.startsWith(`/api/binary/author/articles/${createdArticleId}/revisions/`)
              && url.pathname.endsWith('/rollback')
          })
          await session.page.getByRole('button', { name: '回滚到此版本' }).click()
          await session.page.getByRole('button', { name: '确认回滚' }).click()
          const rollbackResponse = await rollbackResponsePromise
          expect(rollbackResponse.ok(), 'article revision rollback request should succeed').toBe(true)
          await expectAnyToastText(session.page, /已回滚到版本 1/, 3_000).catch(() => {})
          await expect(articleTitleInput(session.page)).toHaveValue(articleTitle)
        }
        session.audit.assertCleanSince(routeStart, 'admin-article-write')

        session.audit.assertCleanSince(start, 'admin-dashboard-and-article')
      } finally {
        await session.close()
      }
    })

    test('category, tag, settings, users and admin message center support main actions', async ({ browser }) => {
      const session = await openAuditedPage(browser, storageState)
      try {
        const start = session.audit.checkpoint()
        const accountStatusAction = () => session.page.getByRole('button', { name: /变更匿名账号状态：binaryuser/ }).first()
        const readAccountStatusActionText = async () => (await accountStatusAction().textContent() ?? '').replace(/\s+/g, '')
        const installAdminSensitiveProofForSession = async () => installAdminSensitiveProof(session.page, storageState)
        const clickStatusToggle = async () => {
          const button = accountStatusAction()
          if (viewport.size.width < 640) {
            await button.evaluate((element) => {
              ;(element as HTMLButtonElement).click()
            })
            return
          }

          await button.click()
        }

        await session.page.goto('/user/manage/category', { waitUntil: 'domcontentloaded' })
        await waitForAppReady(session.page)
        await settlePage(session.page)
        const categoryName = `acc-cat-${Date.now().toString().slice(-6)}`
        await session.page.getByRole('button', { name: '新增分类' }).click()
        await session.page.getByLabel('分类名称').fill(categoryName)
        await session.page.getByRole('button', { name: /确认提交/ }).click()
        await expectAnyToastText(session.page, /全站新分类已同步|分类已保存，但列表同步失败/)
        const categoryTable = session.page
          .locator('section', { hasText: '分类列表' })
          .locator('.el-table')
          .first()
        await assertTableLayout(session.page, categoryTable)
        await session.page.goto('/user/manage/tag', { waitUntil: 'domcontentloaded' })
        await waitForAppReady(session.page)
        await settlePage(session.page)
        const tagName = `acc-tag-${Date.now().toString().slice(-6)}`
        await session.page.getByRole('button', { name: /新增标签|创建标签/ }).click()
        await session.page.getByPlaceholder('标签名称（如：Vue3）').fill(tagName)
        await session.page.getByRole('button', { name: /保存变更/ }).click()
        await expectAnyToastText(session.page, /标签创建成功|标签已保存，但列表同步失败/)
        const tagTable = session.page
          .locator('section', { hasText: '标签列表' })
          .locator('.el-table')
          .first()
        await assertTableLayout(session.page, tagTable)
        await session.page.goto('/user/manage/settings', { waitUntil: 'domcontentloaded' })
        await waitForAppReady(session.page)
        await settlePage(session.page)
        const siteSaveButton = session.page.getByRole('button', { name: /保存同步|保存中/ }).first()
        await expect(siteSaveButton).toBeVisible()
        if (await siteSaveButton.isEnabled()) {
          await assertElementHitTarget(session.page, siteSaveButton, 'settings save button')
          await siteSaveButton.click()
          await expectAnyToastText(session.page, /SEO 配置同步成功/)
          await assertToastInViewport(session.page)
        } else {
          await expect(siteSaveButton).toBeDisabled()
        }
        await session.page.goto('/user/manage/users', { waitUntil: 'domcontentloaded' })
        await waitForAppReady(session.page)
        await settlePage(session.page)
        const accountSearch = session.page.getByLabel('搜索账号标识')
          .or(session.page.getByPlaceholder('搜账号 ID / public handle...'))
          .or(session.page.getByPlaceholder('搜用户名...'))
          .first()
        await accountSearch.fill('binaryuser')
        await session.page.getByRole('button', { name: '查询' }).click()
        const userTable = session.page.locator('.user-table').first()
        if (viewport.size.width < 640) {
          await expect(session.page.locator('.user-mobile-card, .user-resource-list-item').first()).toBeVisible()
          await assertElementHitTarget(session.page, session.page.getByRole('button', { name: '查询' }), 'mobile user search button')
          await assertElementHitTarget(session.page, accountStatusAction(), 'mobile user status button')
        } else {
          await assertTableLayout(session.page, userTable, session.page.locator('.el-pagination').first())
          await resetLocalAcceptanceUserStatus('binaryuser')
          await session.page.getByRole('button', { name: '查询' }).click()
          await expect
            .poll(readAccountStatusActionText, {
              message: 'target account status action should be visible after search',
              timeout: 30_000
            })
            .toMatch(/封禁|解封/)
          if ((await readAccountStatusActionText()).includes('解封')) {
            await installAdminSensitiveProofForSession()
            await clickStatusToggle()
            await session.page.getByRole('button', { name: '立即解封' }).click()
            await expect
              .poll(readAccountStatusActionText, {
                message: 'precondition should place target account into ban-ready state',
                timeout: 30_000
              })
              .toContain('封禁')
          }
          await installAdminSensitiveProofForSession()
          await clickStatusToggle()
          const banReasonCombobox = session.page.getByRole('combobox', { name: '封禁原因' })
          await expect(banReasonCombobox).toBeVisible()
          await banReasonCombobox.click()
          await session.page.getByRole('option', { name: '发布违规内容' }).click()
          await session.page.locator('input[name="banConfirmAccountLabel"], input[name="banConfirmUsername"], input[placeholder*="binaryuser"]').first().fill('binaryuser')
          const banDialog = session.page.getByRole('dialog', { name: '账号封禁处理' })
          const confirmBanButton = banDialog.getByRole('button', { name: /确认封禁|安全校验中/ })
          await expect(confirmBanButton).toBeEnabled()
          const banStatusResponse = session.page.waitForResponse((response) =>
            response.url().includes('/api/binary/admin/users/status')
            && response.request().method() === 'PUT'
          )
          await confirmBanButton.click()
          await expect((await banStatusResponse).ok()).toBe(true)
          await expect(banDialog).toBeHidden()
          await session.page.getByRole('button', { name: '查询' }).click()
          await expect
            .poll(readAccountStatusActionText, {
              message: 'ban action should switch row into unban state',
              timeout: 30_000
            })
            .toContain('解封')
          await installAdminSensitiveProofForSession()
          await clickStatusToggle()
          const unbanStatusResponse = session.page.waitForResponse((response) =>
            response.url().includes('/api/binary/admin/users/status')
            && response.request().method() === 'PUT'
          )
          await session.page.getByRole('button', { name: '立即解封' }).click()
          await expect((await unbanStatusResponse).ok()).toBe(true)
          await session.page.getByRole('button', { name: '查询' }).click()
          await expect
            .poll(readAccountStatusActionText, {
              message: 'unban action should restore ban entry point',
              timeout: 30_000
            })
            .toContain('封禁')
          await session.page.getByRole('button', { name: '查询' }).click()
          await clickStatusToggle()
          await session.page.getByRole('button', { name: '取消' }).click()
        }
        await session.page.goto('/user/manage/messages', { waitUntil: 'domcontentloaded' })
        await waitForAppReady(session.page)
        await settlePage(session.page)
        const composePanel = session.page.locator('.admin-message-center__system-panel', { hasText: '发送系统消息' }).first()
        await composePanel.scrollIntoViewIfNeeded()
        await expect(composePanel).toBeVisible()
        await composePanel.getByLabel('目标账号 ID', { exact: true }).fill('1')
        await composePanel.getByLabel('主题', { exact: true }).fill(`Acceptance 系统消息 ${Date.now()}`)
        await composePanel.getByLabel('内容', { exact: true }).fill('这是一条管理员控制台自动验收消息。')
        await composePanel.getByRole('button', { name: '发送系统消息' }).click()
        await expect(composePanel.getByLabel('目标账号 ID', { exact: true })).toHaveValue('')
        await expect(composePanel.getByLabel('主题', { exact: true })).toHaveValue('')
        await expect(composePanel.getByLabel('内容', { exact: true })).toHaveValue('')

        session.audit.assertCleanSince(start, 'admin-management-flows')
      } finally {
        await session.close()
      }
    })

    test('mobile drawer, write draft and quick taxonomy actions stay usable', async ({ browser }) => {
      test.skip(viewport.size.width >= 640, 'mobile-only layout guard')

      const editDraftKey = `fsus:article-draft:edit:${fixtures.articleId}`
      await discardServerDraft(storageState, editDraftKey)
      const session = await openAuditedPage(browser, storageState)
      try {
        const start = session.audit.checkpoint()
        await session.page.goto('/user/manage/article/write', { waitUntil: 'domcontentloaded' })
        await waitForAppReady(session.page)
        await settlePage(session.page)
        await assertNoHorizontalOverflow(session.page, 8)

        const mobileNavTrigger = session.page.getByRole('button', { name: /打开账户导航/ })
        await assertElementHitTarget(session.page, mobileNavTrigger, 'mobile account navigation trigger')
        await mobileNavTrigger.click()
        const mobileNavigation = session.page.getByRole('dialog', { name: '账户导航' })
        await expect(mobileNavigation).toBeVisible()
        await expect(mobileNavigation.getByText('互动')).toBeVisible()
        const mobileUserLink = mobileNavigation.getByRole('link', { name: /用户/ }).first()
        await assertElementHitTarget(session.page, mobileUserLink, 'mobile user navigation link')
        await mobileUserLink.click()
        await expect(session.page).toHaveURL(/\/user\/manage\/users$/)
        await waitForAppReady(session.page)
        await settlePage(session.page)
        await assertNoHorizontalOverflow(session.page, 8)

        await session.page.goto(`/user/manage/article/edit/${fixtures.articleId}`, { waitUntil: 'domcontentloaded' })
        await waitForAppReady(session.page)
        await settlePage(session.page)
        await session.page.evaluate((key) => {
          localStorage.removeItem(key)
        }, editDraftKey)
        await discardServerDraft(storageState, editDraftKey)
        const draftTitle = `Mobile Draft ${Date.now()}`
        const draftBody = '## 本地缓存\n\n移动端草稿恢复测试内容。'
        const draftSaveResponse = session.page.waitForResponse((response) =>
          response.url().includes('/api/binary/author/drafts')
          && response.request().method() === 'POST'
        )
        await articleTitleInput(session.page).fill(draftTitle)
        await markdownEditor(session.page).fill(draftBody)
        await expect
          .poll(async () => await session.page.evaluate((key) => Boolean(localStorage.getItem(key)), editDraftKey), {
            message: 'article draft should be written to localStorage',
            timeout: 10_000
          })
          .toBe(true)
        await expect((await draftSaveResponse).ok()).toBe(true)
        await expect
          .poll(async () => await readServerDraftTitle(storageState, editDraftKey), {
            message: 'article draft should be written to server draft storage',
            timeout: 30_000
          })
          .toBe(draftTitle)
        await session.page.evaluate((key) => localStorage.removeItem(key), editDraftKey)
        await session.page.reload({ waitUntil: 'domcontentloaded' })
        await waitForAppReady(session.page)
        await settlePage(session.page)
        await expect(session.page.getByRole('button', { name: '恢复服务端草稿' })).toBeVisible()
        await session.page.getByRole('button', { name: '恢复服务端草稿' }).click()
        await expect(articleTitleInput(session.page)).toHaveValue(draftTitle)
        await expect(markdownEditor(session.page)).toHaveValue(draftBody)
        await session.page.evaluate((key) => {
          localStorage.removeItem(key)
        }, editDraftKey)
        await discardServerDraft(storageState, editDraftKey)

        const categoryName = `qw-cat-${Date.now().toString().slice(-6)}`
        const tagName = `qw-tag-${Date.now().toString().slice(-6)}`
        await session.page.getByRole('button', { name: '新建分类' }).click()
        await session.page.getByLabel('分类名称').fill(categoryName)
        await session.page.getByRole('button', { name: '创建并选中' }).click()
        await expectAnyToastText(session.page, /分类已创建并选中/)
        await session.page.getByRole('button', { name: '新建标签' }).click()
        await session.page.getByLabel('标签名称').fill(tagName)
        await session.page.getByRole('button', { name: '创建并关联' }).click()
        await expectAnyToastText(session.page, /标签已创建并关联/)
        await assertNoHorizontalOverflow(session.page, 8)

        session.audit.assertCleanSince(start, 'mobile-navigation-draft-taxonomy')
      } finally {
        await session.close()
      }
    })
  })
}
