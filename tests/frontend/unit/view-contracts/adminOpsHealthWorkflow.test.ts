import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoFile = (path: string): string => fileURLToPath(new URL(`../../../../${path}`, import.meta.url))
const readRepoFile = (path: string): string => readFileSync(repoFile(path), 'utf8')

describe('admin ops health workflow contract', () => {
  const opsHealth = readRepoFile('src/frontend/src/views/admin/OpsHealth.vue')
  const authoringApi = readRepoFile('src/frontend/src/api/authoring.ts')
  const operationsDtos = readRepoFile('src/backend/Models/Dtos/OperationsDtos.cs')

  it('keeps recent errors as structured frontend and backend contracts', () => {
    expect(operationsDtos).toContain('RecentOpsErrorResponse')
    expect(operationsDtos).toContain('DateTimeOffset OccurredAt')
    expect(operationsDtos).toContain('string Severity')
    expect(operationsDtos).toContain('string Action')
    expect(operationsDtos).toContain('string Message')
    expect(operationsDtos).toContain('string? Detail')
    expect(operationsDtos).toContain('int Count')
    expect(authoringApi).toContain('export interface RecentOpsErrorResponse')
    expect(authoringApi).toContain('recentErrors: RecentOpsErrorResponse[]')
    expect(authoringApi).not.toContain('recentErrors: string[]')
  })

  it('renders recent errors as operational rows instead of raw log strings', () => {
    expect(opsHealth).toContain('opsRecentErrors')
    expect(opsHealth).toContain('error.action')
    expect(opsHealth).toContain('error.message')
    expect(opsHealth).toContain('adminStatusLabel[toAdminSystemStatus(error.severity)]')
    expect(opsHealth).toContain('formatOpsErrorTime(error.occurredAt)')
    expect(opsHealth).toContain('error.detail')
    expect(opsHealth).not.toContain('{{ error }}')
    expect(opsHealth).not.toContain(':key="error"')
    expect(authoringApi).not.toContain('CAST(')
  })

  it('uses compact empty, grouped count, detail disclosure, and copy action', () => {
    expect(opsHealth).toContain('AdminInlineEmptyState')
    expect(opsHealth).toContain('暂无错误记录')
    expect(opsHealth).toContain('formatOpsErrorCount(error.count)')
    expect(opsHealth).toContain('<details')
    expect(opsHealth).toContain('复制详情')
    expect(opsHealth).toContain('copyOpsErrorDetail')
  })

  it('normalizes ops hierarchy and backup artifact labels', () => {
    expect(opsHealth).toContain('核心依赖、后台任务、备份与队列状态。')
    expect(opsHealth).not.toContain('eyebrow="管理"')
    expect(opsHealth).not.toContain('eyebrow="运行时"')
    expect(opsHealth).not.toContain('eyebrow="服务"')
    expect(opsHealth).not.toContain('eyebrow="任务"')
    expect(opsHealth).not.toContain('eyebrow="备份"')
    expect(opsHealth).not.toContain('eyebrow="错误"')
    expect(opsHealth).toContain('backupArtifactKindLabel')
    expect(opsHealth).toContain('restore-drill')
    expect(opsHealth).toContain('恢复演练')
    expect(opsHealth).toContain('not_run')
    expect(opsHealth).toContain('未运行')
  })
})
