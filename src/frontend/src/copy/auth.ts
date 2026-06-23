// copy/auth.ts — 注册 / 登录 / 恢复访问 / 政策模态框
//
// 调性校准：
//   - 去掉指令式提醒、道歉式提示等暖色对话体
//   - 去掉 "无需密码即可安全登录"、"为保护账户安全…" 等营销承诺
//   - 去掉 `Google Authenticator` 产品位引用
//   - 去掉省略号 `…` 装饰；loading 文案保持中性状态

import type { AuthCopy } from './contracts'

export const FSUSBLOG_AUTH_COPY = {
  register: {
    title: '创建匿名账号',
    description: '不绑定邮箱或手机号。保存 Recovery Key，绑定通行密钥。',
    publicHandleHeading: '公开称呼',
    publicHandleLabel: '公开称呼（可选）',
    publicHandleHint: '留空时由系统生成匿名称呼。TOTP 可在账户设置中作为二次验证启用；TOTP 恢复码与 Recovery Key 不同。',
    publicHandlePlaceholder: '3-20 位中文或英文字母',
    agreementPrefix: '我已阅读并同意',
    guidelinesLink: '站点使用规范',
    submitButtonIdle: '创建匿名账号并生成 Recovery Key',
    submitButtonLoading: '正在创建匿名账号',
    recoveryKeyTitle: '保存 Recovery Key',
    recoveryKeyHint: 'Recovery Key 只显示一次。若它丢失且没有可用通行密钥，账号可能无法恢复。',
    recoveryKeyVersionPrefix: 'Recovery Key v',
    recoveryKeyCreatedAtPrefix: '生成时间：',
    copyRecoveryKeyCta: '复制 Recovery Key',
    recoveryKeySavedCheckbox: '我已保存 Recovery Key',
    registerPasskeyCta: '注册通行密钥',
    passkeyBoundTitle: '通行密钥已绑定',
    passkeyBoundHint: '登录使用通行密钥；账号恢复使用 Recovery Key。',
    enterAccountCta: '进入账号中心',
    hasAccountLabel: '已注册账号',
    loginLink: '现在登录',
    cancelLink: '回到主页'
  },
  login: {
    title: '登录',
    description: '写作、评论、站点维护。',
    rememberMe: '记住本设备',
    passkeyButton: '使用通行密钥登录',
    passkeyLoading: '等待设备验证',
    passkeyHint: '匿名身份不绑定邮箱或手机号；使用已绑定设备、安全密钥，或用 Recovery Key 恢复访问。',
    passkeyFailureHint: '验证失败时使用 Recovery Key 恢复访问。',
    recoverLink: '使用 Recovery Key 恢复访问',
    mfaRequiredTitle: '需要二次验证',
    mfaRequiredHint: '输入验证码或恢复码。',
    mfaAriaLabel: '选择验证方式',
    mfaModeTOTP: '验证码',
    mfaModeRecovery: '恢复码',
    mfaCodeLabel: 'MFA 验证码',
    mfaCodePlaceholder: '6 位验证码',
    mfaRecoveryLabel: '恢复码',
    mfaRecoveryPlaceholder: '恢复码',
    mfaSubmit: '验证',
    registerLink: '注册',
    cancelLink: '取消'
  },
  recover: {
    title: '恢复访问',
    description: '验证 Recovery Key，绑定新通行密钥。',
    sectionTitle: 'Recovery Key',
    sectionHint: 'Recovery Key 是账号恢复凭据，不是 TOTP 恢复码。验证后绑定新通行密钥。',
    keyLabel: 'Recovery Key',
    keyPlaceholder: '粘贴以 frk_ 开头的 Recovery Key',
    keyHelp: 'Recovery Key 丢失且无可用通行密钥时，账号可能无法恢复。',
    revokePasskeys: '恢复后撤销旧通行密钥',
    verifyCta: '验证 Recovery Key',
    sessionReadyHint: 'Recovery Key 已验证。恢复会话有效至 {expiresAt}。绑定新的通行密钥。',
    bindNewPasskeyCta: '绑定新的通行密钥',
    verifyFailedFallback: 'Recovery Key 验证失败。',
    returnLoginLink: '返回登录',
    cancelLink: '取消'
  },
  policyModal: {
    fallbackTitle: '条款详情',
    privacyTitle: '隐私政策',
    guidelinesTitle: '用户守则',
    loadingStatus: '正在加载内容',
    loadError: '无法加载条款内容',
    retryCta: '重试',
    emptyStatePrefix: '暂未配置',
    emptyStateSuffix: '。',
    acknowledgementCta: '我已阅读',
    bodyAriaLabel: '条款正文'
  }
} as const satisfies AuthCopy
