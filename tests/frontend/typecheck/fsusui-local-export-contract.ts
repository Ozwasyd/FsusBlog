import {
  ElDataList,
  FsusDataList,
  type DataListColumn,
  type DataListRow,
  type DataListRowKey,
} from '@ozwasyd/element-plus'

import type { Component } from 'vue'

const dataListComponents: Component[] = [ElDataList, FsusDataList]
const dataListColumns: DataListColumn[] = [
  { key: 'name', label: 'Name', grid: 'minmax(0, 1fr)' },
  { key: 'action', label: 'Action', align: 'end' },
]
const dataListRows: DataListRow[] = [{ id: 'global', name: 'Global' }]
const dataListKey: DataListRowKey = 'global'

export const fsusUiLocalExportContract = {
  dataListColumns,
  dataListComponents,
  dataListKey,
  dataListRows,
}
