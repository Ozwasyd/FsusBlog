import { ElMessage } from '@ozwasyd/element-plus'

export function showBoundaryViolation() {
  ElMessage.warning('programmatic feedback belongs behind the FsusUI adapter')
}
