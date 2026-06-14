import path from 'node:path'
import { execFile } from 'node:child_process'
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
import { readAedsResponse } from '../../support/aeds-envelope.mjs'

const createdArticleTitle = `Acceptance Article ${Date.now()}`
const articleCoverFixturePath = path.resolve(process.cwd(), '../../tests/frontend/fixtures/assets/article-cover-16x9.png')
const acceptanceBackendUrl = process.env.FSUSBLOG_ACCEPTANCE_BACKEND_URL || 'http://127.0.0.1:5000'
const execFileAsync = promisify(execFile)
let adminStorageStatePromise: Promise<Awaited<ReturnType<typeof captureStorageState>>> | null = null

const cookieHeaderFromStorageState = (state: StorageState): string =>
  state.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ')

const serverDraftPath = (draftKey: string): string => `/api/author/drafts/${encodeURIComponent(draftKey)}`

const discardServerDraft = async (state: StorageState, draftKey: string): Promise<void> => {
  await fetch(`${acceptanceBackendUrl}${serverDraftPath(draftKey)}`, {
    method: 'DELETE',
    headers: {
      Accept: 'application/json',
      Cookie: cookieHeaderFromStorageState(state)
    }
  })
}

const resetLocalAcceptanceUserStatus = async (username: string): Promise<void> => {
  if (process.env.FSUSBLOG_RESET_SECURITY_TEST_STATE === '0') {
    return
  }

  try {
    await execFileAsync('docker', [
      'exec',
      'fsusblog-postgres',
      'psql',
      '-U',
      'fsusblog',
      '-d',
      'fsusblog',
      '-c',
      `UPDATE sys_user SET status = 0, banreason = NULL WHERE username = '${username.replace(/'/g, "''")}'`
    ], { timeout: 5000 })
  } catch {
    // Non-local environments may not use the developer docker container name.
  }
}

const postAuthorPreview = async (payload: unknown, state?: StorageState): Promise<Response> => fetch(`${acceptanceBackendUrl}/api/author/preview`, {
  method: 'POST',
  headers: {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'X-Fsus-Device-Fp': 'acceptance-private-preview',
    ...(state ? { Cookie: cookieHeaderFromStorageState(state) } : {})
  },
  body: JSON.stringify(payload)
})

const markdownEditor = (page: Page) => page.getByRole('textbox', { name: 'Markdown 正文编辑区' })

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
            (page) => page.getByRole('heading', { name: '控制中心' }),
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
        expect([401, 403], 'anonymous preview request should be denied').toContain(anonymousPreviewResponse.status)
        const adminPreviewResponse = await postAuthorPreview(privatePreviewPayload, storageState)
        expect(adminPreviewResponse.ok, 'admin private preview request should succeed').toBe(true)
        const adminPreviewEnvelope = await adminPreviewResponse.json()
        expect(adminPreviewEnvelope?.data?.html, 'private preview html should carry preview-only marker').toContain('data-preview-only="true"')
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

        await session.page.getByPlaceholder('在此键入博文标题...').fill(articleTitle)
        await markdownEditor(session.page).fill('## Acceptance\n\n这是一篇自动验收生成的博文，用于验证发布主链。')
        await session.page.getByRole('combobox', { name: '所属分类' }).click()
        await session.page.locator('.el-select-dropdown__item:visible').first().click()
        await session.page.getByRole('tab', { name: '预览' }).click()
        const previewResponsePromise = session.page.waitForResponse((response) => {
          const request = response.request()
          const url = new URL(response.url())
          return request.method() === 'POST' && url.pathname === '/api/author/preview'
        })
        await session.page.getByRole('button', { name: '生成私有预览' }).click()
        const previewResponse = await previewResponsePromise
        expect(previewResponse.ok(), 'private preview request should succeed').toBe(true)
        const privatePreviewFrame = session.page.frameLocator('iframe[title="私有预览渲染结果"]').first()
        await expect(privatePreviewFrame.locator('article[data-preview-only="true"]')).toBeVisible()
        await expect(privatePreviewFrame.locator('h2')).toContainText('Acceptance')
        const publishSidebar = session.page.getByRole('complementary', { name: '发布与上传设置' })
        const coverToastPromise = expectAnyToastText(session.page, /文章头图已更新/, 60_000)
        const coverUploadCompleteResponsePromise = session.page.waitForResponse((response) => {
          const request = response.request()
          const url = new URL(response.url())
          return request.method() === 'POST' && /^\/api\/binary\/upload\/[^/]+\/complete$/.test(url.pathname)
        }, { timeout: 60_000 })
        await publishSidebar.locator('input[type="file"][accept="image/*"]').setInputFiles(articleCoverFixturePath)
        const coverUploadCompleteResponse = await coverUploadCompleteResponsePromise
        expect(coverUploadCompleteResponse.ok(), 'cover upload complete request should succeed').toBe(true)
        await coverToastPromise
        const publishTab = publishSidebar.getByRole('tab', { name: '发布', exact: true })
        await publishTab.click()
        await expect(publishTab).toHaveAttribute('aria-selected', 'true')
        const coverPreview = publishSidebar.locator('img[alt="当前文章头图预览"]:visible').first()
        await expect(coverPreview).toBeVisible()
        await assertElementInViewport(session.page, coverPreview, 'article cover preview')
        const uploadedCoverUrl = await coverPreview.getAttribute('src')
        expect(uploadedCoverUrl, 'article cover preview should use uploaded image url').toBeTruthy()
        expect(uploadedCoverUrl).toMatch(/\/uploads\//)
        const submitButton = session.page.getByRole('button', { name: /立即发布|确认更新/ }).first()
        await assertElementHitTarget(session.page, submitButton, 'article publish button')
        await assertResponsiveLayoutContract(session.page, 'manage-article-write')
        const prepublishResponsePromise = session.page.waitForResponse((response) => {
          const request = response.request()
          const url = new URL(response.url())
          return request.method() === 'POST' && url.pathname === '/api/author/prepublish-check'
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
        await session.page.getByRole('button', { name: '确认发布' }).click()
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
        const persistedCoverPreview = session.page.locator('img[alt="当前文章头图预览"]').first()
        await expect(persistedCoverPreview).toBeVisible()
        await expect(persistedCoverPreview).toHaveAttribute('src', uploadedCoverUrl ?? '')
        const anonymousAssetReindexResponse = await fetch(`${acceptanceBackendUrl}/api/author/articles/${createdArticleId}/assets/reindex`, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'X-Fsus-Device-Fp': 'acceptance-asset-library'
          }
        })
        expect([401, 403], 'anonymous asset reindex request should be denied').toContain(anonymousAssetReindexResponse.status)
        await session.page.getByRole('tab', { name: '资产' }).click()
        await expect(session.page.locator('#article-asset-library-title:visible')).toHaveText('资产库')
        const assetReindexResponsePromise = session.page.waitForResponse((response) => {
          const request = response.request()
          const url = new URL(response.url())
          return request.method() === 'POST' && url.pathname === `/api/author/articles/${createdArticleId}/assets/reindex`
        })
        await session.page.getByRole('button', { name: '重建资产索引' }).click()
        const assetReindexResponse = await assetReindexResponsePromise
        expect(assetReindexResponse.ok(), 'asset reindex request should succeed').toBe(true)
        await expectAnyToastText(session.page, /资产库已重建/)
        await expect(session.page.getByText(uploadedCoverUrl ?? '', { exact: false })).toBeVisible()
        const uploadedAssetRow = session.page.locator('.asset-row').filter({ hasText: uploadedCoverUrl ?? '' }).first()
        await uploadedAssetRow.getByRole('button', { name: /插入资产/ }).click()
        await expectAnyToastText(session.page, /资产已插入正文/)
        await expect(markdownEditor(session.page)).toHaveValue(/\/uploads\//)
        if (viewport.size.width >= 640) {
          await session.page.getByRole('tab', { name: '版本' }).click()
          await expect(session.page.getByRole('button', { name: /选择修订版本 1/ })).toBeVisible()
          const updatedArticleTitle = `${articleTitle} revision`
          const updatedArticleBody = '## Acceptance\n\n这是一篇自动验收生成的修订版本，用于验证历史版本比较与回滚。'
          await session.page.getByPlaceholder('在此键入博文标题...').fill(updatedArticleTitle)
          await markdownEditor(session.page).fill(updatedArticleBody)
          const updateResponsePromise = session.page.waitForResponse((response) => {
            const request = response.request()
            const url = new URL(response.url())
            return request.method() === 'PUT' && url.pathname === `/api/binary/admin/article/${createdArticleId}`
          })
          await session.page.locator('.write-submit-button').click()
          await session.page.getByRole('dialog', { name: '更新确认' }).getByRole('button', { name: '确认更新' }).click()
          const updateResponse = await updateResponsePromise
          expect(updateResponse.ok(), 'article update request should succeed').toBe(true)
          await expect(session.page).toHaveURL(/\/user\/manage\/article\/list(?:\?.*)?$/)

          await session.page.goto(`/user/manage/article/edit/${createdArticleId}`, { waitUntil: 'domcontentloaded' })
          await waitForAppReady(session.page)
          await settlePage(session.page)
          await session.page.getByRole('tab', { name: '版本' }).click()
          await expect(session.page.getByRole('button', { name: /选择修订版本 2/ })).toBeVisible()
          await session.page.getByRole('button', { name: /选择修订版本 1/ }).click()
          await expect(session.page.getByText(/正文长度/)).toBeVisible()
          await session.page.getByRole('button', { name: '回滚到此版本' }).click()
          await session.page.getByRole('button', { name: '确认回滚' }).click()
          await expectAnyToastText(session.page, /已回滚到版本 1/)
          await expect(session.page.getByPlaceholder('在此键入博文标题...')).toHaveValue(articleTitle)
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
        const banButtonName = '封禁'
        const unbanButtonName = '解封'
        const clickStatusToggle = async (name: RegExp | string) => {
          const button = session.page.getByRole('button', { name }).first()
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
        await session.page.getByRole('button', { name: '创建标签' }).click()
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
        await session.page.getByPlaceholder('搜用户名...').fill('binaryuser')
        await session.page.getByRole('button', { name: '查询' }).click()
        const userTable = session.page.locator('.user-table').first()
        if (viewport.size.width < 640) {
          await expect(session.page.locator('.user-mobile-card').first()).toBeVisible()
          await assertElementHitTarget(session.page, session.page.getByRole('button', { name: '查询' }), 'mobile user search button')
          const primaryStatusAction = await session.page.getByRole('button', { name: banButtonName }).count()
            ? session.page.getByRole('button', { name: banButtonName }).first()
            : session.page.getByRole('button', { name: unbanButtonName }).first()
          await assertElementHitTarget(session.page, primaryStatusAction, 'mobile user status button')
        } else {
          await assertTableLayout(session.page, userTable, session.page.locator('.el-pagination').first())
          await resetLocalAcceptanceUserStatus('binaryuser')
          await session.page.getByRole('button', { name: '查询' }).click()
          await expect
            .poll(async () => await session.page.getByRole('button', { name: banButtonName }).count(), {
              message: 'precondition should place target user into ban-ready state',
              timeout: 30_000
            })
            .toBeGreaterThan(0)
          await clickStatusToggle(banButtonName)
          const banReasonCombobox = session.page.getByRole('combobox', { name: '封禁原因' })
          await expect(banReasonCombobox).toBeVisible()
          await banReasonCombobox.click()
          await session.page.getByRole('option', { name: '发布违规内容' }).click()
          await session.page.locator('input[name="banConfirmUsername"], input[placeholder*="binaryuser"]').first().fill('binaryuser')
          await session.page.getByRole('button', { name: /确认封禁|安全校验中/ }).click()
          await expect
            .poll(async () => await session.page.getByRole('button', { name: unbanButtonName }).count(), {
              message: 'ban action should switch row into unban state',
              timeout: 30_000
            })
            .toBeGreaterThan(0)
          await clickStatusToggle(unbanButtonName)
          await session.page.getByRole('button', { name: '立即解封' }).click()
          await expect
            .poll(async () => await session.page.getByRole('button', { name: banButtonName }).count(), {
              message: 'unban action should restore ban entry point',
              timeout: 30_000
            })
            .toBeGreaterThan(0)
          await session.page.getByRole('button', { name: '查询' }).click()
          await clickStatusToggle(banButtonName)
          await session.page.getByRole('button', { name: '取消' }).click()
        }
        await session.page.goto('/user/manage/messages', { waitUntil: 'domcontentloaded' })
        await waitForAppReady(session.page)
        await settlePage(session.page)
        const composePanel = await session.page.locator('.mail-compose-panel').filter({ hasText: '发送系统消息' }).count()
          ? session.page.locator('.mail-compose-panel').filter({ hasText: '发送系统消息' }).first()
          : session.page.locator('.mail-mobile-compose').filter({ hasText: '发送系统消息' }).first()
        await composePanel.getByLabel('目标用户 ID', { exact: true }).fill('1')
        await composePanel.getByLabel('主题', { exact: true }).fill(`Acceptance 系统消息 ${Date.now()}`)
        await composePanel.getByLabel('内容', { exact: true }).fill('这是一条管理员控制台自动验收消息。')
        await composePanel.getByRole('button', { name: '发送' }).click()
        await expect(composePanel.getByLabel('目标用户 ID', { exact: true })).toHaveValue('')
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
      const editDraftPath = serverDraftPath(editDraftKey)
      await discardServerDraft(storageState, editDraftKey)
      const session = await openAuditedPage(browser, storageState)
      try {
        const start = session.audit.checkpoint()
        await session.page.goto('/user/manage/article/write', { waitUntil: 'domcontentloaded' })
        await waitForAppReady(session.page)
        await settlePage(session.page)
        await assertNoHorizontalOverflow(session.page, 8)

        const menuButton = session.page.getByRole('button', { name: '打开账户导航' })
        await assertElementHitTarget(session.page, menuButton, 'mobile account menu button')
        await menuButton.click()
        const drawer = session.page.locator('#account-mobile-drawer')
        await expect(drawer).toBeVisible()
        await drawer.locator('nav').evaluate((element) => {
          element.scrollTop = element.scrollHeight
        })
        await assertElementHitTarget(session.page, drawer.getByRole('link', { name: /用户/ }).first(), 'mobile drawer user link')
        await drawer.getByRole('link', { name: /用户/ }).first().click()
        await expect(session.page).toHaveURL(/\/user\/manage\/users$/)
        await waitForAppReady(session.page)
        await settlePage(session.page)
        await assertNoHorizontalOverflow(session.page, 8)

        await session.page.goto(`/user/manage/article/edit/${fixtures.articleId}`, { waitUntil: 'domcontentloaded' })
        await waitForAppReady(session.page)
        await settlePage(session.page)
        await session.page.evaluate(async ({ key, path }) => {
          localStorage.removeItem(key)
          await fetch(path, {
            method: 'DELETE',
            credentials: 'include',
            headers: { Accept: 'application/json' }
          })
        }, { key: editDraftKey, path: editDraftPath })
        const draftTitle = `Mobile Draft ${Date.now()}`
        const draftBody = '## 本地缓存\n\n移动端草稿恢复测试内容。'
        await session.page.getByPlaceholder('在此键入博文标题...').fill(draftTitle)
        await markdownEditor(session.page).fill(draftBody)
        await expect
          .poll(async () => await session.page.evaluate((key) => Boolean(localStorage.getItem(key)), editDraftKey), {
            message: 'article draft should be written to localStorage',
            timeout: 10_000
          })
          .toBe(true)
        await expect
          .poll(async () => await session.page.evaluate(async (path) => {
            const response = await fetch(path, {
              credentials: 'include',
              headers: { Accept: 'application/json' }
            })
            if (!response.ok) return null
            const envelope = await response.json()
            return envelope?.data?.title ?? null
          }, editDraftPath), {
            message: 'article draft should be written to server draft storage',
            timeout: 10_000
          })
          .toBe(draftTitle)
        await session.page.evaluate((key) => localStorage.removeItem(key), editDraftKey)
        await session.page.reload({ waitUntil: 'domcontentloaded' })
        await waitForAppReady(session.page)
        await settlePage(session.page)
        await expect(session.page.getByRole('button', { name: '恢复服务端草稿' })).toBeVisible()
        await session.page.getByRole('button', { name: '恢复服务端草稿' }).click()
        await expect(session.page.getByPlaceholder('在此键入博文标题...')).toHaveValue(draftTitle)
        await expect(markdownEditor(session.page)).toHaveValue(draftBody)
        await session.page.evaluate(async ({ key, path }) => {
          localStorage.removeItem(key)
          await fetch(path, {
            method: 'DELETE',
            credentials: 'include',
            headers: { Accept: 'application/json' }
          })
        }, { key: editDraftKey, path: editDraftPath })

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

        session.audit.assertCleanSince(start, 'mobile-drawer-draft-taxonomy')
      } finally {
        await session.close()
      }
    })
  })
}
