// Temporary declaration augmentation for @ozwasyd/element-plus@1.6.0-preview.10.
// The published npm tarball exports ElSelect, ElOption, and icons-vue/ArrowDown at runtime,
// but omits es/components/select/index.d.ts, es/components/select/src/select.vue.d.ts,
// and es/icons-vue/**/*.d.ts. Remove once FsusUI publishes complete declaration files.
import type { DefineComponent, SVGAttributes } from 'vue'

declare module '@ozwasyd/element-plus' {
  export const ElOption: DefineComponent<{
    value: string | number | boolean | Record<string, unknown>
    label?: string | number
    created?: boolean
    disabled?: boolean
  }>

  export const ElSelect: DefineComponent<{
    id?: string
    name?: string
    modelValue?: unknown
    'onUpdate:modelValue'?: (value: any) => void
    onChange?: (value: any) => void
    ariaLabel?: string
    autocomplete?: string
    automaticDropdown?: boolean
    size?: '' | 'large' | 'default' | 'small'
    disabled?: boolean
    clearable?: boolean
    filterable?: boolean
    allowCreate?: boolean
    loading?: boolean
    popperClass?: string
    remote?: boolean
    loadingText?: string
    noMatchText?: string
    noDataText?: string
    multiple?: boolean
    multipleLimit?: number
    placeholder?: string
    defaultFirstOption?: boolean
    reserveKeyword?: boolean
    valueKey?: string
    collapseTags?: boolean
    collapseTagsTooltip?: boolean
    teleported?: boolean
    persistent?: boolean
    fitInputWidth?: boolean
  }>
}

declare module '@ozwasyd/element-plus/icons-vue' {
  export const ArrowDown: DefineComponent<SVGAttributes>
}
