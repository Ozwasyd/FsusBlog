// FsusUI typed-confirm-field 替代 admin 自造的 IntegrityTypedConfirmField：
// - modelValue / phrase / label / description / id / name / placeholder / disabled / required props 全部覆盖
// - 内置 complete / invalid 状态样式（aria-invalid + namespace modifier class）
// - update:modelValue + change emits 与旧组件一致
export { ElTypedConfirmField as FsusUiTypedConfirmField } from '@ozwasyd/element-plus';
