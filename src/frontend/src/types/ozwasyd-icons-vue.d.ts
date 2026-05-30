declare module '@ozwasyd/element-plus/es/icons-vue/src/index.mjs' {
  import type { DefineComponent } from 'vue'

  export const ArrowDown: DefineComponent
  export const ArrowRight: DefineComponent
  export const Back: DefineComponent
  export const Calendar: DefineComponent
  export const ChatDotRound: DefineComponent
  export const Check: DefineComponent
  export const Close: DefineComponent
  export const Cloudy: DefineComponent
  export const Delete: DefineComponent
  export const Document: DefineComponent
  export const Edit: DefineComponent
  export const FolderChecked: DefineComponent
  export const Hide: DefineComponent
  export const InfoFilled: DefineComponent
  export const Key: DefineComponent
  export const Location: DefineComponent
  export const Lock: DefineComponent
  export const Menu: DefineComponent
  export const Picture: DefineComponent
  export const Plus: DefineComponent
  export const Refresh: DefineComponent
  export const RefreshLeft: DefineComponent
  export const Search: DefineComponent
  export const Top: DefineComponent
  export const View: DefineComponent
  export const Warning: DefineComponent
  export const WarningFilled: DefineComponent
}

declare module '@ozwasyd/element-plus/es/wasm/index.mjs' {
  import type { FsusResult } from '@ozwasyd/element-plus/result'
  import type { MarkdownRenderResult } from '@/services/markdownActivationService'

  export function renderMarkdownResultWithRuntime(request: {
    source: string
    mode: 'article' | 'about' | 'preview' | 'editor'
    allowHtml: boolean
    allowLatex: boolean
    allowMermaid: boolean
    baseUrl: string | null
  }): Promise<FsusResult<MarkdownRenderResult>>
}
