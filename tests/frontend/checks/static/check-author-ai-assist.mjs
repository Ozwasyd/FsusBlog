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
const sidebar = read('src/frontend/src/components/admin/article/ArticleWriteSidebar.vue')
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
assert(api.includes('generateAiAssist') && api.includes('/api/author/ai-assist'), 'frontend API must call admin AI assist endpoint')
assert(composable.includes('requestAiAssist') && composable.includes('applyAiSuggestedTags'), 'editor composable must expose AI assist actions')
assert(sidebar.includes('data-author-ai-assist-panel="true"'), 'sidebar must render AI assist results inside author workspace')
assert(writeView.includes('@ai-assist="requestAiAssist"'), 'write view must wire AI assist trigger')
assert(security.includes('Authoring:AiAssist:ExternalProviderReviewed'), 'security docs must cover AI assist external review gate')
assert(operations.includes('Authoring:AiAssist:ExternalProviderReviewed'), 'operations docs must cover AI assist config gate')

console.log('[check-author-ai-assist] ok')
