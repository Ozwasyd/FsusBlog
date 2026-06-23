// copy/identity.ts — 身份中心 / 占位 / Profile 重定向页
//
// 调性校准：
//   - 去掉 "你可以…" 对话体，改为名词短语列表
//   - 去掉 "抱歉"、"请先完成" 暖色道歉 / 请求
//   - 状态标签使用中性词（"已启用" / "未启用"），不拽 "允许匿名优先" 等推销表达
//   - 删去 `...` 装饰省略号

import type { IdentityCopy } from './contracts'

export const FSUSBLOG_IDENTITY_COPY = {
  meta: {
    // Identity Center 路由标题（按路由 key 索引）
    UserIdentityOverview: {
      title: '身份总览',
      description: '汇总登录方式、恢复路径、公开身份与匿名评论状态。'
    },
    UserIdentityPasskeys: {
      title: '通行密钥',
      description: '管理用于登录的 Passkey 设备。'
    },
    UserIdentityRecoveryKey: {
      title: 'Recovery Key',
      description: '创建或轮换匿名账号恢复凭据。'
    },
    UserIdentityAnonymous: {
      title: '匿名身份',
      description: '查看匿名评论作者模式、适用范围与 ZK 可用状态。'
    },
    UserIdentityPublicProfile: {
      title: '公开资料',
      description: '管理公开发送评论时展示的身份信息。'
    },
    UserIdentitySessions: {
      title: '设备会话',
      description: '查看并撤销当前账号的活跃设备会话。'
    },
    UserIdentityMfa: {
      title: '二次验证',
      description: '管理 TOTP 二次验证状态。'
    },
    UserIdentityCommentRecords: {
      title: '可归因评论记录',
      description: '区分可归因评论记录与强匿名评论边界。'
    }
  },
  overview: {
    passkeyLabel: 'Passkey',
    passkeyEnabled: '已启用',
    passkeyDisabled: '未添加',
    passkeyDeviceCount: '{n} 个登录设备',
    recoveryKeyLabel: 'Recovery Key',
    recoveryKeyReady: '本次已生成',
    recoveryKeyRequired: '需要创建',
    recoveryKeyHint: '账号恢复凭据，只在创建或轮换时显示一次。',
    mfaLabel: 'TOTP 二次验证',
    mfaEnabled: '已启用',
    mfaDisabled: '未启用',
    mfaHint: 'TOTP 用于敏感操作确认，不是账号恢复方式。',
    anonymousLabel: '匿名评论',
    anonymousCardAvailable: '匿名评论可用',
    anonymousCardClosed: '匿名评论关闭',
    zkAvailable: 'ZK 可用',
    zkUnavailable: 'ZK 尚未启用',
    sectionTitle: '账号身份概览',
    sectionDescription: '查看当前账号的登录方式、恢复凭据、公开资料与匿名评论设置。',
    accountIdRow: '账户编号：{value}',
    accountIdEmpty: '未同步',
    publicHandleRow: '公开称呼：{value}',
    publicHandleEmpty: '未设置，公开发送时可再填写',
    anonymousPolicyRow: '匿名评论策略：{value}',
    anonymousPolicyAllowed: '以匿名为默认',
    anonymousPolicyClosed: '当前未启用',
    publicSendOptionRow: '公开发送选项：{value}',
    publicSendOptionAllowed: '可显式选择',
    publicSendOptionClosed: '当前不可用',
    lifecycleTitle: '账号生命周期',
    lifecycleDescription: '注销账户前需要完成匿名账号敏感操作校验。',
    lifecycleWarning: '注销后当前会话、通行密钥、Recovery Key 与匿名凭据状态都会失效。',
    deleteAccountCta: '注销账户'
  },
  passkeys: {
    sectionTitle: '通行密钥设备',
    sectionDescription: '使用设备通行密钥管理当前账号的登录设备。',
    loading: '通行密钥加载中',
    emptyTitle: '尚未添加通行密钥',
    emptyContent: '添加后可用设备生物识别或 PIN 登录。',
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
    sectionDescription: 'Recovery Key 是账号恢复凭据，不是 TOTP 恢复码；Recovery Key 只显示一次。',
    sectionHint: '创建或轮换后请立即保存。若 Recovery Key 丢失且没有可用通行密钥，账号可能无法恢复。',
    loading: 'Recovery Key 操作处理中',
    panelVersionPrefix: 'Recovery Key v',
    panelCreatedAtPrefix: '生成：',
    savedCheckbox: '我已保存 Recovery Key',
    closeOnceCta: '关闭一次性展示',
    emptyState: '当前页面不会读取或保存 Recovery Key 明文；只能创建或轮换后一次性展示。',
    createCta: '创建 Recovery Key',
    rotateCta: '轮换 Recovery Key'
  },
  mfa: {
    sectionTitle: 'TOTP 二次验证',
    sectionDescription: 'TOTP 用于敏感操作确认，不是账号恢复方式；Recovery Key 才是账号恢复凭据。',
    loading: '二次验证状态加载中',
    enabled: 'TOTP 已启用',
    disabled: 'TOTP 未启用',
    lastVerifiedPrefix: '最近验证',
    lastVerifiedEmpty: '未记录最近验证时间',
    enableCta: '启用 TOTP 二次验证',
    enabledHint: 'TOTP 用于敏感操作确认；账号恢复请使用 Recovery Key。',
    setupChallengeRequired: '需要先完成 TOTP 二次验证。TOTP 恢复码与 Recovery Key 不同。',
    initFailedFallback: 'TOTP 二次验证初始化失败',
    verifyFailedFallback: 'TOTP 二次验证失败',
    enabledSuccess: 'TOTP 二次验证已启用',
    setupModalTitle: 'TOTP 二次验证绑定',
    loadFailedFallback: '二次验证状态加载失败'
  },
  anonymous: {
    sectionTitle: '匿名身份',
    sectionDescription: '匿名评论身份遵循站点当前策略，不依赖用户名或密码。',
    governanceHeading: '治理策略',
    zkStatusHeading: 'ZK 状态',
    cardEnabled: '已开放',
    cardDisabled: '已关闭',
    cardAvailable: '可治理',
    cardUnavailable: '不可治理',
    cardZkAvailable: '可用',
    cardZkUnavailable: '未启用',
    cardZkConfigVisible: '配置入口可见',
    cardZkConfigHidden: '配置入口不可见',
    defaultModeHint: '默认评论作者模式在评论发布页确认。',
    governanceHint: '封禁与撤销由管理工作区处理。'
  },
  publicProfile: {
    sectionTitle: '公开资料',
    sectionDescription: '公开 handle 是可选项，只在你明确选择公开发送时使用。',
    draftLabel: '公开称呼草稿',
    draftPlaceholder: '公开发送评论时可填写',
    optInCheckbox: '我理解公开资料只会在显式公开发送时展示',
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
    sectionDescription: '查看当前账号的活跃会话，并下线不再使用的设备。',
    loading: '设备会话加载中',
    activeCountPrefix: '当前共有 {n} 个活跃会话',
    revokeOthersCta: '下线其他设备',
    currentDevice: '当前设备',
    otherDevice: '其他设备',
    activeAtPrefix: '活跃：',
    revokeCta: '下线',
    emptyTitle: '暂无活跃会话',
    emptyContent: '当前没有可展示的设备会话。',
    revokeSuccess: '设备会话已下线',
    revokeOthersSuccess: '其他设备已下线',
    deviceFallback: '未记录设备信息',
    loadFailedFallback: '设备会话加载失败'
  },
  commentRecords: {
    sectionTitle: '可归因评论记录',
    sectionDescription: '这里只描述可归因评论记录的边界，实际列表只展示公开发送记录。',
    boundary: '强匿名评论不会出现在按账号查询的评论记录中；只有选择可归因或公开发送的评论才会进入账号侧记录。',
    governance: '管理端可以根据策略处理匿名评论，但这里不会暗示强匿名评论可由账号反查。',
    viewLink: '查看可归因评论记录'
  },
  placeholder: {
    cardTitle: '身份设置',
    sections: {
      UserIdentityOverview: {
        title: '身份总览',
        description: '汇总登录方式、恢复路径、公开身份与匿名评论状态。',
        caption: '集中查看当前账号的安全状态与公开身份设置。',
        body: '包含：登录设备状态、恢复凭据、匿名身份、公开资料。',
        items: '["通行密钥状态", "Recovery Key 状态", "匿名身份与公开资料", "设备会话摘要"]'
      },
      UserIdentityPasskeys: {
        title: '通行密钥',
        description: '管理用于登录的 Passkey 设备。',
        caption: '管理用于登录当前账号的设备通行密钥。',
        body: '已添加设备、名称更新、移除不再使用的通行密钥。',
        items: '["已注册设备", "设备重命名", "最后一枚 Passkey 删除保护"]'
      },
      UserIdentityRecoveryKey: {
        title: 'Recovery Key',
        description: '管理匿名账号恢复凭据。',
        caption: '独立于 TOTP 恢复码。',
        body: 'Recovery Key 只在创建或轮换时展示一次，生成后须立即保存。',
        items: '["创建 Recovery Key", "轮换恢复凭据", "恢复会话绑定新 Passkey"]'
      },
      UserIdentityAnonymous: {
        title: '匿名身份',
        description: '查看匿名评论作者模式、适用范围与展示语言偏好。',
        caption: '不暴露真实账号身份。',
        body: '匿名身份状态会根据站点当前策略显示，强匿名评论不会暴露真实账号身份。',
        items: '["默认匿名模式", "匿名展示名语言", "匿名凭据状态与声誉分组"]'
      },
      UserIdentityPublicProfile: {
        title: '公开资料',
        description: '管理公开发送评论时展示的身份信息。',
        caption: '公开资料只会在你主动确认公开发送时展示。',
        body: '维护公开称呼、查看公开展示说明、发送前确认展示方式。',
        items: '["公开称呼", "公开发送确认", "评论作者展示预览"]'
      },
      UserIdentitySessions: {
        title: '设备会话',
        description: '查看并撤销当前账号的活跃设备会话。',
        caption: '用于管理当前账号的登录设备。',
        body: '查看当前设备和其他活跃会话，下线不再使用的设备。',
        items: '["当前设备", "其他活跃会话", "撤销其他设备"]'
      },
      UserIdentityMfa: {
        title: '二次验证',
        description: '管理 TOTP 二次验证和恢复码。',
        caption: 'TOTP 用于敏感操作确认，不是匿名账号恢复路径。',
        body: '启用或关闭二次验证，重新生成 TOTP 恢复码。',
        items: '["启用二次验证", "关闭二次验证", "重新生成 TOTP 恢复码"]'
      }
    }
  },
  profile: {
    pageTitle: '身份中心',
    pageDescription: '账号安全、恢复凭据、公开资料与匿名评论设置统一在身份中心管理。',
    emptyTitle: '前往身份中心',
    emptyContent: '身份中心管理 Passkey、Recovery Key、TOTP 二次验证、设备会话、公开称呼和匿名评论设置。',
    openIdentityCta: '打开身份中心'
  },
  confirm: {
    deletePasskeyTitle: '删除通行密钥',
    deletePasskeyBody: '确认删除此通行密钥？删除后，该设备将不能继续使用此密钥登录。',
    rotateRecoveryKeyTitle: '轮换 Recovery Key',
    rotateRecoveryKeyBody: '轮换后旧 Recovery Key 将失效。确认继续？',
    deleteAccountTitle: '注销账户',
    deleteAccountBody: '注销后账号相关会话、通行密钥、Recovery Key 与匿名凭据都会失效。确认继续？',
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