#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '../../../..');

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
const authoringServiceRoot = resolve(repoRoot, 'src/backend/Services/Authoring')
const authoringService = readdirSync(authoringServiceRoot)
  .filter((name) => /^Authoring(?:WorkflowService|DraftLifecycleService|AssetLibraryService)(?:\..+)?\.cs$/u.test(name))
  .sort()
  .map((name) => read(`src/backend/Services/Authoring/${name}`))
  .join('\n')
const auditQuery = read('src/backend/Infrastructure/Audit/AuditQueryService.cs')

for (const token of [
  'id: string',
  'createdByAdminPrincipalId: string'
]) {
  assert(authoringApi.includes(token), `frontend authoring API long id boundary missing: ${token}`)
}

for (const [signature, label] of [
  [/export async function getArticleRevision\(\s*articleId:\s*number,\s*revisionId:\s*string/u, 'getArticleRevision(articleId: number, revisionId: string)'],
  [/export async function rollbackArticleRevision\(\s*articleId:\s*number,\s*revisionId:\s*string/u, 'rollbackArticleRevision(articleId: number, revisionId: string)'],
  [/export async function getAuditLogDetail\(\s*id:\s*string/u, 'getAuditLogDetail(id: string)'],
  [/export async function verifyAuditLog\(\s*id:\s*string/u, 'verifyAuditLog(id: string)']
]) {
  assert(signature.test(authoringApi), `frontend authoring API long id boundary missing: ${label}`)
}

for (const [signature, label] of [
  [/createdByAdminPrincipalId:\s*number/u, 'createdByAdminPrincipalId: number'],
  [/export async function getArticleRevision\(\s*articleId:\s*number,\s*revisionId:\s*number/u, 'getArticleRevision(articleId: number, revisionId: number)'],
  [/export async function rollbackArticleRevision\(\s*articleId:\s*number,\s*revisionId:\s*number/u, 'rollbackArticleRevision(articleId: number, revisionId: number)'],
  [/export async function getAuditLogDetail\(\s*id:\s*number/u, 'getAuditLogDetail(id: number)'],
  [/export async function verifyAuditLog\(\s*id:\s*number/u, 'verifyAuditLog(id: number)']
]) {
  assert(!signature.test(authoringApi), `frontend authoring API must not expose long id as number: ${label}`)
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
