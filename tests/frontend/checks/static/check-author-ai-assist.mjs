#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const repoRoot = resolve(process.cwd(), '../..')

function read(path) {
  return readFileSync(resolve(repoRoot, path), 'utf8')
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

const endpoint = read('src/backend/Modules/Endpoints/AuthoringEndpoints.cs')
const service = read('src/backend/Services/Authoring/AuthoringWorkflowService.cs')
const dtos = read('src/backend/Models/Dtos/AuthoringDtos.cs')
const api = read('src/frontend/src/api/authoring.ts')
const composable = read('src/frontend/src/composables/useAdminArticleWrite.ts')
const writeView = read('src/frontend/src/views/admin/article/Write.vue')
const security = read('docs/security.md')
const operations = read('docs/operations.md')

assert(endpoint.includes('RequireAuthorization(policy => policy.RequireRole("admin"))'), 'author endpoints must require admin role')
assert(endpoint.includes('service.GenerateAiAssist(context.User.GetUserId(), request)'), 'AI assist endpoint must pass actor id for audit')
assert(dtos.includes('AiAssistResponse') && dtos.includes('ExternalProviderAllowed') && dtos.includes('AuditEvent'), 'AI assist DTO must expose provider and audit state')
assert(service.includes('Authoring:AiAssist:Enabled'), 'AI assist must read explicit enable config')
assert(service.includes('Authoring:AiAssist:AllowExternalProvider'), 'AI assist must gate external provider config')
assert(service.includes('Authoring:AiAssist:ExternalProviderReviewed'), 'AI assist must require external provider review config')
assert(service.includes('WriteAudit(AuditSourceCatalog.Article, "author-ai-assist"'), 'AI assist must write audit records')
assert(!service.includes('HttpClient'), 'AI assist service must not directly send unpublished drafts to an external HTTP provider')
assert(api.includes("const BINARY_API_PREFIX = '/api/binary'") && api.includes('binaryUrl: `${BINARY_API_PREFIX}/author${path}`'), 'frontend authoring API must route through the binary author bridge')
assert(api.includes('generateAiAssist') && api.includes("requestAuthoringBinary<AiAssistResponse>('/ai-assist'"), 'frontend API must call admin AI assist endpoint')
assert(composable.includes('requestAiAssist') && composable.includes('applyAiSuggestedTags'), 'editor composable must expose AI assist actions')
assert(writeView.includes('data-author-ai-assist-panel="true"'), 'write view must render AI assist results inside content check task')
assert(writeView.includes('@click="requestAiAssist"'), 'write view must wire AI assist trigger')
assert(writeView.includes('内容辅助 / DRAFT CHECK'), 'write view must label the panel as a draft-check tool')
assert(writeView.includes('根据当前标题与正文生成摘要草稿、标题备选、标签匹配和结构检查结果。'), 'write view must describe draft-check capabilities')
assert(writeView.includes('生成摘要草稿'), 'write view must expose summary draft action')
assert(writeView.includes('检查草稿'), 'write view must expose draft check action')
assert(writeView.includes('使用这版摘要'), 'write view must expose summary apply action')
assert(writeView.includes('匹配已有标签'), 'write view must expose tag matching action')
assert(writeView.includes('使用翻译草稿'), 'write view must expose translation draft action')
assert(composable.includes('正在检查草稿'), 'editor composable must use draft-check feedback copy')
assert(composable.includes('草稿检查结果已生成'), 'editor composable must use draft-check success copy')
assert(!writeView.includes('AI CHECK'), 'write view must not use AI-forward panel label')
assert(!writeView.includes('AI 辅助检查'), 'write view must not use AI-forward primary action')
assert(!writeView.includes('作者辅助 / AI CHECK'), 'write view must not use old author-assist label')
assert(security.includes('Authoring:AiAssist:ExternalProviderReviewed'), 'security docs must cover AI assist external review gate')
assert(operations.includes('Authoring:AiAssist:ExternalProviderReviewed'), 'operations docs must cover AI assist config gate')

console.log('[check-author-ai-assist] ok')
