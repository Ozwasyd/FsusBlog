import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoFile = (path: string): string => fileURLToPath(new URL(`../../../../${path}`, import.meta.url))
const readRepoFile = (path: string): string => readFileSync(repoFile(path), 'utf8')

describe('admin UX task flow contract', () => {
  const accountNav = readRepoFile('src/frontend/src/layouts/accountNav.ts')
  const accountLayout = readRepoFile('src/frontend/src/layouts/AccountLayout.vue')
  const writePage = readRepoFile('src/frontend/src/views/admin/article/Write.vue')
  const writeComposable = readRepoFile('src/frontend/src/composables/useAdminArticleWrite.ts')
  const commentQueue = readRepoFile('src/frontend/src/components/admin/comment-moderation/CommentModerationQueue.vue')
  const commentBulk = readRepoFile('src/frontend/src/components/admin/comment-moderation/CommentModerationBulkActions.vue')
  const commentComposable = readRepoFile('src/frontend/src/composables/useCommentModerationQueue.ts')
  const messages = readRepoFile('src/frontend/src/views/user/Messages.vue')
  const dashboard = readRepoFile('src/frontend/src/views/admin/Dashboard.vue')
  const publicShellState = readRepoFile('src/frontend/src/public-renderers/publicShellState.ts')
  const homeContent = readRepoFile('src/frontend/src/components/public/pages/PublicHomePageContent.vue')
  const filterContent = readRepoFile('src/frontend/src/components/public/pages/PublicFilterPageContent.vue')
  const uxCheck = readRepoFile('tests/frontend/checks/ux/check-ux-semantics.mjs')
  const usabilityScript = readRepoFile('docs/ux/usability-test-script.md')
  const findingsValidator = readRepoFile('tools/ux/validate-usability-findings.mjs')

  it('groups admin navigation by task without changing route paths', () => {
    expect(accountNav).toContain("label: '内容'")
    expect(accountNav).toContain("label: '互动'")
    expect(accountNav).toContain("label: '系统'")
    expect(accountNav).toContain("label: '运维'")
    expect(accountNav).toContain("to: '/user/manage/article/list'")
    expect(accountNav).toContain("to: '/user/manage/moderation'")
    expect(accountNav).toContain("to: '/user/manage/cache'")
    expect(accountLayout).toContain('currentNavGroupKey')
    expect(accountLayout).toContain('openMobileGroupKey')
    expect(accountLayout).toContain('account-mobile-nav-group-active')
  })

  it('turns the article editor side panel into a publishing task flow', () => {
    expect(writePage).toContain('label="发布设置"')
    expect(writePage).toContain('label="内容检查"')
    expect(writePage).toContain('label="预览"')
    expect(writePage).toContain('label="历史版本"')
    expect(writePage).toContain('label="资源"')
    expect(writePage).not.toContain('label="SEO"')
    expect(writePage).not.toContain('label="AI"')
    expect(writePage).not.toContain('label="上传"')
    expect(writePage).toContain('发布前 checklist')
    expect(writePage).toContain('全屏：最大化编辑区，可按 Esc 退出')
    expect(writeComposable).toContain("return isEdit.value ? '更新文章' : '发布文章'")
  })

  it('adds recommendation and preview semantics to comment moderation', () => {
    expect(commentComposable).toContain('buildRecommendedAction')
    expect(commentComposable).toContain('recommendedActionLabel')
    expect(commentComposable).toContain('recommendedActionReason')
    expect(commentQueue).toContain('推荐动作')
    expect(commentQueue).toContain('moderation-detail-fold')
    expect(commentBulk).toContain('批量审核预演')
    expect(commentBulk).toContain('该操作会写入审核日志')
  })

  it('clarifies message center context, action consequences, and dashboard tasks', () => {
    expect(messages).toContain('正在回复：')
    expect(messages).toContain('标记为处理中')
    expect(messages).toContain('移回待处理')
    expect(messages).toContain('关闭会话')
    expect(messages).toContain('状态变更会通知用户')
    expect(messages).toContain('回复草稿尚未发送')
    expect(dashboard).toContain('今日待处理')
    expect(dashboard).toContain('评论待审')
    expect(dashboard).toContain('工单待处理')
  })

  it('tightens public search, empty states, and UX quality gates', () => {
    expect(publicShellState).toContain('搜索文章、标签或关键词')
    expect(homeContent).toContain('快速入口')
    expect(filterContent).toContain('搜索范围：全站文章、标签或关键词')
    expect(uxCheck).toContain('[ux-semantics] ok')
    expect(usabilityScript).toContain('每轮 5-8 人')
    expect(findingsValidator).toContain('requiredFindingFields')
  })
})
