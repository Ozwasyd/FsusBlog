#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '../../../..')

function read(path) {
  return readFileSync(resolve(repoRoot, path), 'utf8')
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

const authoringApi = read('src/frontend/src/api/authoring.ts')
const authoringDtos = read('src/backend/Models/Dtos/AuthoringDtos.cs')
const auditDtos = read('src/backend/Models/Dtos/AuditDtos.cs')
const authoringService = read('src/backend/Services/Authoring/AuthoringWorkflowService.cs')
const auditQuery = read('src/backend/Infrastructure/Audit/AuditQueryService.cs')

for (const token of [
  'id: string',
  'createdByAdminPrincipalId: string',
  'export async function getArticleRevision(\n  articleId: number,\n  revisionId: string',
  'export async function rollbackArticleRevision(\n  articleId: number,\n  revisionId: string',
  'export async function getAuditLogDetail(id: string',
  'export async function verifyAuditLog(id: string'
]) {
  assert(authoringApi.includes(token), `frontend authoring API long id boundary missing: ${token}`)
}

for (const forbidden of [
  'createdByAdminPrincipalId: number',
  'export async function getArticleRevision(\n  articleId: number,\n  revisionId: number',
  'export async function rollbackArticleRevision(\n  articleId: number,\n  revisionId: number',
  'export async function getAuditLogDetail(id: number',
  'export async function verifyAuditLog(id: number'
]) {
  assert(!authoringApi.includes(forbidden), `frontend authoring API must not expose long id as number: ${forbidden}`)
}

for (const token of [
  'ArticleRevisionSummaryResponse(\n    string Id',
  'string CreatedByAdminPrincipalId',
  'ArticleRevisionDetailResponse(\n    string Id',
  'AssetLibraryItemResponse(\n    string Id'
]) {
  assert(authoringDtos.includes(token), `backend authoring DTO long id must be string: ${token}`)
}

for (const token of [
  'AuditLogItemResponse(\n    string Id',
  'AuditTamperVerifyResponse(\n    string Id'
]) {
  assert(auditDtos.includes(token), `backend audit DTO long id must be string: ${token}`)
}

for (const token of [
  'revision.Id.ToString(CultureInfo.InvariantCulture)',
  'revision.CreatedByAdminPrincipalId.ToString(CultureInfo.InvariantCulture)',
  'item.Id.ToString(CultureInfo.InvariantCulture)'
]) {
  assert(authoringService.includes(token), `authoring service must serialize long id as invariant string: ${token}`)
}

assert(auditQuery.includes('row.Id.ToString(CultureInfo.InvariantCulture)'), 'audit query must serialize audit long id as invariant string')

console.log('[json-long-id-governance] ok')
