import {
  ElDataList,
  ElPublicShell,
  FsusDataList,
  type DataListColumn,
  type DataListRow,
  type DataListRowKey,
  type PublicShellMobileNavMode,
} from '@ozwasyd/element-plus'
import { FsusUiDataList } from '../../../src/frontend/src/fsusui/dataList'
import { FsusUiPublicShell } from '../../../src/frontend/src/fsusui/publicShell'

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
]

const dataListComponents: Component[] = [ElDataList, FsusDataList, ElPublicShell]
const dataListColumns: DataListColumn[] = [
  { key: 'name', label: 'Name', grid: 'minmax(0, 1fr)' },
  { key: 'action', label: 'Action', align: 'end' },
]
const dataListRows: DataListRow[] = [{ id: 'global', name: 'Global' }]
const dataListKey: DataListRowKey = 'global'
const publicShellMobileNavMode: PublicShellMobileNavMode = 'menu'

export const fsusUiLocalExportContract = {
  dataListColumns,
  dataListComponents,
  dataListKey,
  dataListRows,
  publicShellMobileNavMode,
}

export type { LocalTypePreservingAdapterContract }
