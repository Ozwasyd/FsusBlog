import { vi } from 'vitest'
import type { AuthoringInspectorAuthority, AuthoringInspectorBinding } from '@/fsusui/authoringInspector'

export const inspectorBinding = (): AuthoringInspectorBinding => ({
  pluginId: 'acme.tools', pluginVersion: '1.0', packageSha256: 'a'.repeat(64),
  runtimeIdentity: 'b'.repeat(64), lifecycleGeneration: 1, articleId: 'article-1',
  documentId: 'doc-1', documentEpoch: 1, sourceRevision: 4, viewId: 'acme.tools.details',
  requestId: 'request-1', deadline: Date.now() + 30000,
  grantId: 'grant-1', grantDigest: 'c'.repeat(64), scope: { kind: 'article-metadata' },
})
export const inspectorModel = () => ({
  sectionId: 'acme.tools.details', titleReference: 'inspector.title', state: 'ready' as const,
  nodes: [
    { kind: 'values' as const, id: 'values', rows: [{ id: 'title', labelReference: 'field.title', value: 'Example' }] },
    { kind: 'list' as const, id: 'list', items: ['One', 'Two'] },
    { kind: 'table' as const, id: 'table', columns: [{ id: 'name', labelReference: 'field.name' }], rows: [{ id: 'row-1', cells: ['Value'] }] },
    { kind: 'status' as const, id: 'status', messageReference: 'status.ready' },
    { kind: 'diagnostic' as const, id: 'diagnostic', code: 'spell-check', severity: 'warning' as const, messageReference: 'diagnostic.spelling' },
  ], commands: [{ commandId: 'acme.tools.review', labelReference: 'command.review' }],
})
export const inspectorHost = (controller = new AbortController()): AuthoringInspectorAuthority => ({
  isCurrent: vi.fn(() => true), permitsRead: vi.fn(() => true), commandEnabled: vi.fn(() => true),
  signal: () => controller.signal, localize: (reference) => reference,
})
