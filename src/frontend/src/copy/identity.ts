// copy/identity.ts — 身份中心 / 占位 / Profile 重定向页
//
// 调性校准：
//   - 去掉对话体，改为名词短语列表
//   - 去掉暖色道歉 / 指令
//   - 状态标签使用中性词（"已启用" / "未启用"），不拽 "允许匿名优先" 等推销表达
//   - 删去 `...` 装饰省略号

import type { IdentityCopy } from './contracts'

export const FSUSBLOG_IDENTITY_COPY = {
  meta: {
    // Identity Center 路由标题（按路由 key 索引）
    UserIdentityOverview: {
      title: '身份总览',
      description: '登录方式、恢复凭据、公开身份、匿名评论。'
    },
    UserIdentityPasskeys: {
      title: '通行密钥',
      description: '登录设备。'
    },
    UserIdentityRecoveryKey: {
      title: 'Recovery Key',
      description: '账号恢复凭据。'
    },
    UserIdentityAnonymous: {
      title: '匿名身份',
      description: '匿名策略、适用范围、隐私证明。'
    },
    UserIdentityPublicProfile: {
      title: '公开资料',
      description: '公开发送时使用的身份信息。'
    },
    UserIdentitySessions: {
      title: '设备会话',
      description: '活跃设备会话。'
    },
    UserIdentityMfa: {
      title: '二次验证',
      description: 'TOTP 状态。'
    },
    UserIdentityCommentRecords: {
      title: '可归因评论记录',
      description: '公开发送记录边界。'
    }
  },
  overview: {
    passkeyLabel: 'Passkey',
    passkeyEnabled: '已启用',
    passkeyDisabled: '未登记',
    passkeyDeviceCount: '{n} 个登录设备',
    recoveryKeyLabel: 'Recovery Key',
    recoveryKeyReady: '本次已生成',
    recoveryKeyRequired: '未创建',
    recoveryKeyHint: '创建或轮换时一次性显示。',
    mfaLabel: 'TOTP 二次验证',
    mfaEnabled: '已启用',
    mfaDisabled: '未启用',
    mfaHint: '敏感操作验证；不用于账号恢复。',
    anonymousLabel: '匿名评论',
    anonymousCardAvailable: '匿名评论可用',
    anonymousCardClosed: '匿名评论关闭',
    zkAvailable: '隐私证明可用',
    zkUnavailable: '隐私证明未启用',
    sectionTitle: '身份概览',
    sectionDescription: '登录方式、恢复凭据、公开资料、匿名评论。',
    accountIdRow: '账户编号：{value}',
    accountIdEmpty: '未同步',
    publicHandleRow: '公开称呼：{value}',
    publicHandleEmpty: '未设置',
    anonymousPolicyRow: '匿名评论策略：{value}',
    anonymousPolicyAllowed: '默认匿名',
    anonymousPolicyClosed: '当前未启用',
    publicSendOptionRow: '公开发送选项：{value}',
    publicSendOptionAllowed: '可选',
    publicSendOptionClosed: '当前不可用',
    lifecycleTitle: '账号生命周期',
    lifecycleDescription: '注销账户前需要完成匿名账号敏感操作校验。',
    lifecycleWarning: '注销后当前会话、通行密钥、Recovery Key 与匿名凭据状态都会失效。',
    deleteAccountCta: '注销账户'
  },
  passkeys: {
    sectionTitle: '通行密钥设备',
    sectionDescription: '当前账号的通行密钥设备。',
    loading: '通行密钥加载中',
    emptyTitle: '尚未添加通行密钥',
    emptyContent: '登记后用于设备认证。',
    addCta: '添加通行密钥',
    nameInputAriaLabel: '通行密钥名称',
    saveCta: '保存',
    cancelCta: '取消',
    editCta: '编辑',
    deleteCta: '删除',
    nameEmpty: '未命名通行密钥',
    createdAtLabel: '创建',
    activeAtLabel: '活跃',
    activeNeverRecorded: '未记录',
    backupEligible: '支持同步备份',
    backupIneligible: '仅本设备'
  },
  recoveryKey: {
    sectionTitle: 'Recovery Key',
    sectionDescription: '账号恢复凭据；一次性显示。',
    sectionHint: '创建或轮换后保存。丢失且无可用通行密钥时，账号可能无法恢复。',
    loading: '处理中',
    panelVersionPrefix: 'Recovery Key v',
    panelCreatedAtPrefix: '生成：',
    savedCheckbox: '我已保存 Recovery Key',
    closeOnceCta: '关闭',
    emptyState: '明文不保存；仅创建或轮换后显示。',
    createCta: '创建 Recovery Key',
    rotateCta: '轮换 Recovery Key'
  },
  mfa: {
    sectionTitle: 'TOTP 二次验证',
    sectionDescription: '敏感操作验证；账号恢复使用 Recovery Key。',
    loading: '二次验证状态加载中',
    enabled: 'TOTP 已启用',
    disabled: 'TOTP 未启用',
    lastVerifiedPrefix: '最近验证',
    lastVerifiedEmpty: '未记录最近验证时间',
    enableCta: '启用 TOTP 二次验证',
    enabledHint: '敏感操作验证；账号恢复使用 Recovery Key。',
    setupChallengeRequired: '需要先完成 TOTP 二次验证。TOTP 恢复码与 Recovery Key 不同。',
    initFailedFallback: 'TOTP 二次验证初始化失败',
    verifyFailedFallback: 'TOTP 二次验证失败',
    enabledSuccess: 'TOTP 二次验证已启用',
    setupModalTitle: 'TOTP 二次验证绑定',
    loadFailedFallback: '二次验证状态加载失败'
  },
  anonymous: {
    sectionTitle: '匿名身份',
    sectionDescription: '匿名评论按站点策略处理。',
    governanceHeading: '治理策略',
    zkStatusHeading: '隐私证明',
    cardEnabled: '已开放',
    cardDisabled: '已关闭',
    cardAvailable: '可治理',
    cardUnavailable: '不可治理',
    cardZkAvailable: '可用',
    cardZkUnavailable: '未启用',
    cardZkConfigVisible: '配置入口可见',
    cardZkConfigHidden: '配置入口不可见',
    defaultModeHint: '发布页确认作者模式。',
    governanceHint: '封禁与撤销由治理工作区处理。'
  },
  publicProfile: {
    sectionTitle: '公开资料',
    sectionDescription: '公开称呼仅用于公开发送。',
    draftLabel: '公开称呼草稿',
    draftPlaceholder: '公开发送评论时可填写',
    optInCheckbox: '仅公开发送时展示',
    publicSendOptionPrefix: '公开发送选项：',
    publicSendOptionAvailable: '可用',
    publicSendOptionUnavailable: '不可用',
    currentDraftPrefix: '当前草稿：',
    currentDraftEmpty: '未设置',
    saveCta: '保存公开称呼',
    clearCta: '清空公开称呼',
    savedSuccess: '公开称呼已保存',
    clearedSuccess: '公开称呼已清空',
    saveFailedFallback: '公开称呼保存失败'
  },
  sessions: {
    sectionTitle: '设备会话',
    sectionDescription: '当前账号的活跃设备会话。',
    loading: '设备会话加载中',
    activeCountPrefix: '{n} 个活跃会话',
    revokeOthersCta: '下线其他设备',
    currentDevice: '当前设备',
    otherDevice: '其他设备',
    activeAtPrefix: '活跃：',
    revokeCta: '下线',
    emptyTitle: '暂无活跃会话',
    emptyContent: '无设备会话。',
    revokeSuccess: '设备会话已下线',
    revokeOthersSuccess: '其他设备已下线',
    deviceFallback: '未记录设备信息',
    loadFailedFallback: '设备会话加载失败'
  },
  commentRecords: {
    sectionTitle: '可归因评论记录',
    sectionDescription: '这里只描述可归因评论记录的边界，实际列表只展示公开发送记录。',
    boundary: '强匿名评论不会出现在按账号查询的评论记录中；只有选择可归因或公开发送的评论才会进入账号侧记录。',
    governance: '匿名评论按策略处理；账号侧不反查强匿名评论。',
    viewLink: '可归因评论记录'
  },
  placeholder: {
    cardTitle: '身份设置',
    sections: {
      UserIdentityOverview: {
        title: '身份总览',
        description: '登录方式、恢复凭据、公开身份、匿名评论。',
        caption: '安全状态与公开身份设置。',
        body: '登录设备状态、恢复凭据、匿名身份、公开资料。',
        items: '["通行密钥状态", "Recovery Key 状态", "匿名身份与公开资料", "设备会话摘要"]'
      },
      UserIdentityPasskeys: {
        title: '通行密钥',
        description: '登录设备。',
        caption: '当前账号的通行密钥设备。',
        body: '已登记设备、名称更新、通行密钥移除。',
        items: '["已注册设备", "设备重命名", "最后一枚 Passkey 删除保护"]'
      },
      UserIdentityRecoveryKey: {
        title: 'Recovery Key',
        description: '账号恢复凭据。',
        caption: '独立于 TOTP 恢复码。',
        body: '创建或轮换时一次性显示。',
        items: '["创建 Recovery Key", "轮换恢复凭据", "恢复会话绑定新 Passkey"]'
      },
      UserIdentityAnonymous: {
        title: '匿名身份',
        description: '匿名策略、适用范围、隐私证明。',
        caption: '真实账号身份不展示。',
        body: '匿名身份状态按站点策略显示。',
        items: '["默认匿名模式", "匿名展示名语言", "匿名凭据状态与声誉分组"]'
      },
      UserIdentityPublicProfile: {
        title: '公开资料',
        description: '公开发送时使用的身份信息。',
        caption: '仅公开发送时展示。',
        body: '公开称呼、展示说明、发送前确认。',
        items: '["公开称呼", "公开发送确认", "评论作者展示预览"]'
      },
      UserIdentitySessions: {
        title: '设备会话',
        description: '活跃设备会话。',
        caption: '当前账号的登录设备。',
        body: '当前设备、其他活跃会话、设备下线。',
        items: '["当前设备", "其他活跃会话", "撤销其他设备"]'
      },
      UserIdentityMfa: {
        title: '二次验证',
        description: 'TOTP 状态。',
        caption: '敏感操作验证；不用于账号恢复。',
        body: '二次验证启停、TOTP 恢复码生成。',
        items: '["启用二次验证", "关闭二次验证", "重新生成 TOTP 恢复码"]'
      }
    }
  },
  profile: {
    pageTitle: '身份中心',
    pageDescription: '账号安全、恢复凭据、公开资料、匿名评论。',
    emptyTitle: '前往身份中心',
    emptyContent: 'Passkey、Recovery Key、TOTP、设备会话、公开称呼、匿名评论。',
    openIdentityCta: '打开身份中心'
  },
  confirm: {
    deletePasskeyTitle: '删除通行密钥',
    deletePasskeyBody: '删除后，该设备不能使用此密钥登录。',
    rotateRecoveryKeyTitle: '轮换 Recovery Key',
    rotateRecoveryKeyBody: '轮换后旧 Recovery Key 失效。',
    deleteAccountTitle: '注销账户',
    deleteAccountBody: '注销后账号相关会话、通行密钥、Recovery Key 与匿名凭据都会失效。',
    confirmButton: '确认',
    cancelButton: '取消'
  },
  errors: {
    recoveryKeySensitiveOperationRequired: '需要先完成匿名账号敏感操作校验',
    passkeySensitiveOperationRequired: '需要先完成匿名账号敏感操作校验',
    accountDeleteSensitiveOperationRequired: '需要先完成匿名账号敏感操作校验',
    renameFailedFallback: '通行密钥重命名失败',
    deleteFailedFallback: '通行密钥删除失败',
    recoveryKeyFailedFallback: 'Recovery Key 操作失败',
    accountDeleteFailedFallback: '账号注销失败',
    accountDeletedSuccess: '账号已注销',
    recoveryKeyCreatedSuccess: 'Recovery Key 已创建',
    recoveryKeyRotatedSuccess: 'Recovery Key 已轮换'
  }
} as const satisfies IdentityCopy
