// FsusBlog 前端文案契约
//
// 设计依据：FsusUI design.md §1 (The Intellectual Minimalist) + §9 + §10 + §13.5。
// 所有 user-facing 文案必须集中在这里，组件只通过 `@/copy` 引用，不在模板里硬塞中文。
//
// 注意：本文件只描述"调性正确的中文副本"的形状，不做 i18n；多语种留到未来 PR。
// 写法风格：
//   - 陈述事实，不欢迎，不道歉，不撒娇
//   - 真实任务语境（"保存草稿"、"发布文章"）
//   - 不用指令式语气 + 省略号，不用感叹号，不拽第三方产品名
//   - success 绿只用于状态标签；按钮主色按 §4 Accent Rules

export type CopyDomain = Readonly<Record<string, string>>

export type IdentityRouteMeta = Readonly<{
  title: string
  description: string
}>

export type IdentityPlaceholderSection = Readonly<{
  title: string
  description: string
  caption: string
  body: string
  items: string
}>

export type AuthCopy = Readonly<{
  register: CopyDomain
  login: CopyDomain
  recover: CopyDomain
  policyModal: CopyDomain
}>

export type IdentityCopy = Readonly<{
  overview: CopyDomain
  passkeys: CopyDomain
  recoveryKey: CopyDomain
  mfa: CopyDomain
  anonymous: CopyDomain
  publicProfile: CopyDomain
  sessions: CopyDomain
  commentRecords: CopyDomain
  placeholder: Readonly<{
    cardTitle: string
    sections: Readonly<Record<string, IdentityPlaceholderSection>>
  }>
  profile: CopyDomain
  meta: Readonly<Record<string, IdentityRouteMeta>>
  confirm: CopyDomain
  errors: CopyDomain
}>

export type SecurityCopy = Readonly<{
  challenge: CopyDomain
  passkeyStepUp: CopyDomain
  passkeyRegister: CopyDomain
  mfaSetup: CopyDomain
  mfaChallenge: CopyDomain
}>

export type MessagesCopy = Readonly<{
  conversationList: CopyDomain
  threadPanel: CopyDomain
  composePanel: CopyDomain
  emptyState: CopyDomain
  filter: CopyDomain
  status: CopyDomain
}>

export type ErrorsCopy = Readonly<{
  forbidden: CopyDomain
  notFound: CopyDomain
}>

export type AdminCopy = Readonly<{
  moderationReplay: CopyDomain
}>

export type LayoutCopy = Readonly<{
  siteHeader: CopyDomain
  recommendations: CopyDomain
  themeMode: CopyDomain
}>

export type FsusBlogCopy = Readonly<{
  auth: AuthCopy
  identity: IdentityCopy
  security: SecurityCopy
  messages: MessagesCopy
  errors: ErrorsCopy
  admin: AdminCopy
  layout: LayoutCopy
}>
