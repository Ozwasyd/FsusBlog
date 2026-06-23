// copy/index.ts — FsusBlog 前端文案集中化 barrel
//
// 组件应通过 `@/copy` 引用，禁止在 .vue 模板 / <script setup> 字符串里硬塞中文。
// governance check：`tests/frontend/checks/static/check-copy-centralization.mjs`
//
// 调性校准依据：FsusUI design.md §1 (The Intellectual Minimalist) + §9 + §10 + §13.5

export { FSUSBLOG_AUTH_COPY } from './auth'
export type { AuthCopy } from './contracts'

export { FSUSBLOG_IDENTITY_COPY } from './identity'
export type { IdentityCopy } from './contracts'

export { FSUSBLOG_SECURITY_COPY } from './security'
export type { SecurityCopy } from './contracts'

export { FSUSBLOG_MESSAGES_COPY } from './messages'
export type { MessagesCopy } from './contracts'

export { FSUSBLOG_ERRORS_COPY } from './errors'
export type { ErrorsCopy } from './contracts'

export { FSUSBLOG_ADMIN_COPY } from './admin'
export type { AdminCopy } from './contracts'

export { FSUSBLOG_LAYOUT_COPY } from './layout'
export type { LayoutCopy } from './contracts'

export type {
  CopyDomain,
  FsusBlogCopy
} from './contracts'
