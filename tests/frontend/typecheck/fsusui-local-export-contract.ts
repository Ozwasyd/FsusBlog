import {
  ElDataList,
  ElPublicShell,
  FsusDataList,
  FsusTaskPageHeader,
  type DataListColumn,
  type DataListRow,
  type DataListRowKey,
  type PublicShellMobileNavMode,
} from '@ozwasyd/element-plus'
import { FsusUiDataList } from '../../../src/frontend/src/fsusui/dataList'
import { FsusUiPublicShell } from '../../../src/frontend/src/fsusui/publicShell'
import { FsusUiTaskPageHeader } from '../../../src/frontend/src/fsusui/taskPageHeader'
import type { MarkdownSafeHtml } from '@ozwasyd/element-plus/markdown-runtime'

import type { Component } from 'vue'

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2)
    ? true
    : false
type Expect<Value extends true> = Value

type LocalTypePreservingAdapterContract = [
  Expect<Equal<typeof FsusUiDataList, typeof FsusDataList>>,
  Expect<Equal<typeof FsusUiPublicShell, typeof ElPublicShell>>,
  Expect<Equal<typeof FsusUiTaskPageHeader, typeof FsusTaskPageHeader>>,
]

const dataListComponents: Component[] = [ElDataList, FsusDataList, ElPublicShell, FsusTaskPageHeader]
const dataListColumns: DataListColumn[] = [
  { key: 'name', label: 'Name', grid: 'minmax(0, 1fr)' },
  { key: 'action', label: 'Action', align: 'end' },
]
const dataListRows: DataListRow[] = [{ id: 'global', name: 'Global' }]
const dataListKey: DataListRowKey = 'global'
const publicShellMobileNavMode: PublicShellMobileNavMode = 'menu'

// @ts-expect-error FsusUI owns the only constructor for committed Markdown HTML.
const plainMarkdownHtml: MarkdownSafeHtml = '<p>untrusted</p>'

export const fsusUiLocalExportContract = {
  dataListColumns,
  dataListComponents,
  dataListKey,
  dataListRows,
  publicShellMobileNavMode,
  plainMarkdownHtml,
}

export type { LocalTypePreservingAdapterContract }

// The feature consumer must compile against the real pinned public contracts.
export { ArticleAnchorContextAdapter } from '../../../src/frontend/src/services/authoring/articleAnchorContext'
export { ArticleAttachmentContextAdapter } from '../../../src/frontend/src/services/authoring/articleAttachmentContext'
export type * from './article-editor-continuity'
export { bindArticleEditorRuntime } from '../../../src/frontend/src/services/authoring/articleEditorRuntimeBinding'

import ArticleWriteEditor from '../../../src/frontend/src/components/admin/article/ArticleWriteEditor.vue'
import MarkdownEditorAdapter from '../../../src/frontend/src/components/ui/MarkdownEditorAdapter.vue'
import MarkdownTextEditor from '../../../src/frontend/src/components/ui/MarkdownTextEditor.vue'
import type { ArticleEditorContinuityPort } from '../../../src/frontend/src/services/authoring/articleEditorContinuity'
export type ArticleWriterPublicPortContract = [
  Expect<Equal<ReturnType<InstanceType<typeof ArticleWriteEditor>['getAuthoringEditorPort']>, ArticleEditorContinuityPort | null>>,
  Expect<Equal<ReturnType<InstanceType<typeof MarkdownEditorAdapter>['getAuthoringEditorPort']>, ArticleEditorContinuityPort | null>>,
  Expect<Equal<ReturnType<InstanceType<typeof MarkdownTextEditor>['getAuthoringEditorPort']>, ArticleEditorContinuityPort | null>>,
]
