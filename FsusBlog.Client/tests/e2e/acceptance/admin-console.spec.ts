import { test, expect } from '@playwright/test'
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

const createdArticleTitle = `Acceptance Article ${Date.now()}`
let adminStorageStatePromise: Promise<Awaited<ReturnType<typeof captureStorageState>>> | null = null

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
          expectedUrl: '/user/manage/article/list',
          label: 'manage-article-list',
          selectors: [
            (page) => page.getByRole('button', { name: '发布新博文' }),
            (page) => page.locator('.custom-table')
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
          path: '/user/messagebox',
          expectedUrl: '/user/messagebox',
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
      const session = await openAuditedPage(browser, storageState)
      try {
        const start = session.audit.checkpoint()
        await session.page.goto('/user/manage', { waitUntil: 'domcontentloaded' })
        await waitForAppReady(session.page)
        await settlePage(session.page)

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

        await session.page.getByPlaceholder('在此键入博文标题...').fill(createdArticleTitle)
        await session.page.locator('textarea.wasm-markdown-editor__textarea').fill('## Acceptance\n\n这是一篇自动验收生成的博文，用于验证发布主链。')
        await session.page.getByRole('combobox', { name: '所属分类' }).click()
        await session.page.locator('.el-select-dropdown__item:visible').first().click()
        const submitButton = session.page.getByRole('button', { name: /立即发布|确认更新/ }).first()
        await assertElementHitTarget(session.page, submitButton, 'article publish button')
        await assertResponsiveLayoutContract(session.page, 'manage-article-write')
        await submitButton.click()
        await session.page.getByRole('button', { name: '确认发布' }).click()
        await expect(session.page).toHaveURL(/\/user\/manage\/article\/list$/)
        const createdArticleRow = session.page.locator('.custom-table').getByText(createdArticleTitle, { exact: false }).first()
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
        const categoryTable = session.page.locator('.category-table').first()
        await assertTableLayout(session.page, categoryTable)
        await session.page.goto('/user/manage/tag', { waitUntil: 'domcontentloaded' })
        await waitForAppReady(session.page)
        await settlePage(session.page)
        const tagName = `acc-tag-${Date.now().toString().slice(-6)}`
        await session.page.getByRole('button', { name: '创建标签' }).click()
        await session.page.getByPlaceholder('标签名称（如：Vue3）').fill(tagName)
        await session.page.getByRole('button', { name: /保存变更/ }).click()
        await expectAnyToastText(session.page, /标签创建成功|标签已保存，但列表同步失败/)
        await assertTableLayout(session.page, session.page.locator('.tag-table').first())
        await session.page.goto('/user/manage/settings', { waitUntil: 'domcontentloaded' })
        await waitForAppReady(session.page)
        await settlePage(session.page)
        const siteSaveButton = session.page.getByRole('button', { name: /保存同步|保存中/ }).first()
        await assertElementHitTarget(session.page, siteSaveButton, 'settings save button')
        await siteSaveButton.click()
        await expectAnyToastText(session.page, /SEO 配置同步成功/)
        await assertToastInViewport(session.page)
        await session.page.goto('/user/manage/users', { waitUntil: 'domcontentloaded' })
        await waitForAppReady(session.page)
        await settlePage(session.page)
        await session.page.getByPlaceholder('搜用户名...').fill('binaryuser')
        await session.page.getByRole('button', { name: '查询' }).click()
        const userTable = session.page.locator('.user-table').first()
        if (viewport.size.width < 640) {
          await expect(session.page.locator('.user-mobile-card').first()).toBeVisible()
          await assertElementHitTarget(session.page, session.page.getByRole('button', { name: '查询' }), 'mobile user search button')
          await assertElementHitTarget(session.page, session.page.getByRole('button', { name: banButtonName }).first(), 'mobile user ban button')
        } else {
          await assertTableLayout(session.page, userTable, session.page.locator('.custom-pagination').first())
        }
        if (await session.page.getByRole('button', { name: unbanButtonName }).count()) {
          await clickStatusToggle(unbanButtonName)
          await session.page.getByRole('button', { name: '立即解封' }).click()
          await expect
            .poll(async () => await session.page.getByRole('button', { name: banButtonName }).count(), {
              message: 'precondition should restore target user into ban-ready state',
              timeout: 30_000
            })
            .toBeGreaterThan(0)
        }
        await clickStatusToggle(banButtonName)
        const banReasonCombobox = session.page.getByRole('combobox', { name: '封禁原因 (将公示给用户)' })
        await expect(banReasonCombobox).toBeVisible()
        await banReasonCombobox.click()
        await session.page.getByRole('option', { name: '发布违规内容' }).click()
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
        await session.page.getByRole('button', { name: '取消' }).click({
          force: viewport.size.width < 640
        })
        await session.page.goto('/user/messagebox', { waitUntil: 'domcontentloaded' })
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

        await session.page.goto('/user/manage/article/write', { waitUntil: 'domcontentloaded' })
        await waitForAppReady(session.page)
        await settlePage(session.page)
        await session.page.evaluate(() => {
          localStorage.removeItem('fsus:article-draft:create')
        })
        const draftTitle = `Mobile Draft ${Date.now()}`
        const draftBody = '## 本地缓存\n\n移动端草稿恢复测试内容。'
        await session.page.getByPlaceholder('在此键入博文标题...').fill(draftTitle)
        await session.page.locator('textarea.wasm-markdown-editor__textarea').fill(draftBody)
        await expect
          .poll(async () => await session.page.evaluate(() => Boolean(localStorage.getItem('fsus:article-draft:create'))), {
            message: 'article draft should be written to localStorage',
            timeout: 10_000
          })
          .toBe(true)
        await session.page.reload({ waitUntil: 'domcontentloaded' })
        await waitForAppReady(session.page)
        await settlePage(session.page)
        await expect(session.page.getByText('发现本地缓存')).toBeVisible()
        await session.page.getByRole('button', { name: '恢复本地缓存' }).click()
        await expect(session.page.getByPlaceholder('在此键入博文标题...')).toHaveValue(draftTitle)
        await expect(session.page.locator('textarea.wasm-markdown-editor__textarea')).toHaveValue(draftBody)
        await session.page.evaluate(() => localStorage.removeItem('fsus:article-draft:create'))

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
