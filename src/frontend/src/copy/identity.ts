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
      description: ''
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
      description: '匿名评论、公开发送、站点处理规则。'
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
      title: '公开评论记录',
      description: '账号记录只包含公开发送。'
    }
  },
  overview: {
    passkeyLabel: 'Passkey',
    passkeyEnabled: '已启用',
    passkeyDisabled: '未添加',
    passkeyDeviceCount: '{n} 个设备可登录',
    recoveryKeyLabel: 'Recovery Key',
    recoveryKeyReady: '本次已生成',
    recoveryKeyRequired: '未创建',
    recoveryKeyHint: '创建或轮换后只显示一次。',
    mfaLabel: 'TOTP 二次验证',
    mfaEnabled: '已启用',
    mfaDisabled: '未启用',
    mfaHint: '敏感操作验证；不用于账号恢复。',
    anonymousLabel: '匿名评论',
    anonymousCardAvailable: '可用',
    anonymousCardClosed: '已关闭',
    zkAvailable: '增强匿名可用',
    zkUnavailable: '增强匿名未开放',
    sectionTitle: '当前设置',
    sectionDescription: '',
    publicHandleLabel: '公开称呼',
    publicHandleEmpty: '未设置公开称呼',
    anonymousPolicyLabel: '匿名评论',
    anonymousPolicyAllowed: '默认匿名；公开发送需主动选择。',
    anonymousPolicyClosed: '当前站点未开放匿名评论。',
    publicSendOptionLabel: '公开发送',
    publicSendOptionAllowed: '发布评论时可选择公开称呼。',
    publicSendOptionClosed: '当前站点不可公开发送。',
    lifecycleTitle: '账号生命周期',
    lifecycleDescription: '注销账户前需要完成敏感操作校验。',
    lifecycleWarning: '注销会把账号转为已注销，移除公开称呼、会话、通行密钥、Recovery Key、匿名凭据和 TOTP 数据；已发布内容不会自动删除。',
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
    backupModeLabel: '备份',
    backupEligible: '支持同步备份',
    backupIneligible: '仅本设备',
    recoverySuggestion: '当前仅有一枚无法备份的通行密钥。建议再添加一枚通行密钥，或创建 Recovery Key。'
  },
  recoveryKey: {
    sectionTitle: 'Recovery Key',
    sectionDescription: '账号恢复凭据；一次性显示。',
    sectionHint: '创建或轮换后立即保存；之后不会再次显示。丢失且无可用通行密钥时，账号可能无法恢复。',
    loading: '处理中',
    panelVersionPrefix: 'Recovery Key v',
    panelCreatedAtPrefix: '生成：',
    savedCheckbox: '我已保存 Recovery Key',
    closeOnceCta: '关闭',
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
    disableCta: '关闭 TOTP 二次验证',
    disableConfirmTitle: '关闭 TOTP 二次验证',
    disableConfirmBody: '关闭后，敏感操作将不再使用 TOTP 验证。',
    disableConfirmCta: '确认关闭',
    disabledSuccess: 'TOTP 二次验证已关闭',
    setupChallengeRequired: '需要先完成 TOTP 二次验证。TOTP 恢复码与 Recovery Key 不同。',
    disableChallengeRequired: '需要先完成 TOTP 二次验证。',
    initFailedFallback: 'TOTP 二次验证初始化失败',
    verifyFailedFallback: 'TOTP 二次验证失败',
    disableFailedFallback: 'TOTP 二次验证关闭失败',
    enabledSuccess: 'TOTP 二次验证已启用',
    setupModalTitle: 'TOTP 二次验证绑定',
    loadFailedFallback: '二次验证状态加载失败'
  },
  anonymous: {
    sectionTitle: '匿名身份',
    sectionDescription: '匿名能力、公开发送和增强匿名状态。',
    readOnlyBody: '匿名发送不展示账号身份。',
    publicChoiceBody: '公开发送需在评论发布页主动选择。',
    governanceHeading: '异常处理',
    zkStatusHeading: '增强匿名',
    cardEnabled: '可用',
    cardDisabled: '已关闭',
    cardAvailable: '可处理',
    cardUnavailable: '未开放',
    cardZkAvailable: '可用',
    cardZkUnavailable: '未开放',
    cardZkConfigVisible: '普通匿名评论可用。',
    cardZkConfigHidden: '当前站点未开放。',
    defaultModeHint: '发布页选择是否公开称呼。',
    governanceHint: '违规评论按站点规则处理。'
  },
  publicProfile: {
    sectionTitle: '公开资料',
    sectionDescription: '公开称呼仅用于公开发送。',
    draftLabel: '公开称呼',
    draftPlaceholder: '公开发送评论时可填写',
    optInCheckbox: '仅公开发送时展示',
    summaryAriaLabel: '公开资料状态',
    publicSendOptionLabel: '公开发送选项',
    publicSendOptionAvailable: '可用',
    publicSendOptionUnavailable: '不可用',
    saveCta: '保存公开称呼',
    savedSuccess: '公开称呼已保存',
    clearedSuccess: '公开称呼已移除',
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
    activeAtLabel: '最近活跃',
    createdAtLabel: '创建时间',
    loginMethodLabel: '登录方式',
    credentialLabel: '通行密钥',
    authenticationPasskey: '通行密钥',
    authenticationRecoveryKey: '恢复密钥',
    authenticationEnrollment: '首次绑定',
    authenticationOther: '其他方式',
    durationLabel: '登录持续时间',
    durationPersistent: '保持登录（30 天）',
    durationBrowserSession: '关闭浏览器后退出',
    sessionTypeLabel: '会话',
    revokeCta: '下线',
    emptyTitle: '暂无活跃会话',
    emptyContent: '无设备会话。',
    revokeSuccess: '设备会话已下线',
    revokeOthersSuccess: '其他设备已下线',
    deviceFallback: '未记录设备信息',
    loadFailedFallback: '设备会话加载失败'
  },
  commentRecords: {
    sectionTitle: '公开评论记录',
    sectionDescription: '账号记录只包含公开发送。',
    loading: '正在加载公开评论记录。',
    emptyTitle: '暂无公开评论记录',
    emptyDescription: '公开发送的评论会显示在这里；匿名发送不会进入账号记录。',
    policyAriaLabel: '当前评论策略',
    policyPublicSendLabel: '公开发送',
    policyAnonymousLabel: '匿名评论',
    policyZkLabel: '增强匿名',
    policyGovernanceLabel: '匿名评论处理',
    policyOpen: '已开放',
    policyClosed: '已关闭',
    policyActive: '按规则处理',
    policyUnavailable: '未开放'
  },
  placeholder: {
    cardTitle: '身份设置',
    sections: {
      UserIdentityOverview: {
        title: '身份总览',
        description: '',
        caption: '安全状态与公开身份设置。',
        body: '通行密钥、Recovery Key、TOTP、公开称呼和评论策略。',
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
        description: '匿名评论、公开发送、站点处理规则。',
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
    deleteAccountBody: '注销会把账号转为已注销，移除公开称呼、会话、通行密钥、Recovery Key、匿名凭据和 TOTP 数据；已发布内容不会自动删除。',
    confirmButton: '确认',
    cancelButton: '取消'
  },
  errors: {
    recoveryKeySensitiveOperationRequired: '当前账号没有可用的敏感操作验证。请先添加通行密钥或启用 TOTP 后再操作。',
    passkeySensitiveOperationRequired: '当前账号没有可用的敏感操作验证。请先添加通行密钥或启用 TOTP 后再操作。',
    accountDeleteSensitiveOperationRequired: '当前账号没有可用的敏感操作验证。请先添加通行密钥或启用 TOTP 后再操作。',
    renameFailedFallback: '通行密钥重命名失败',
    deleteFailedFallback: '通行密钥删除失败',
    recoveryKeyFailedFallback: 'Recovery Key 操作失败',
    accountDeleteFailedFallback: '账号注销失败',
    accountDeletedSuccess: '账号已注销',
    recoveryKeyCreatedSuccess: 'Recovery Key 已创建',
    recoveryKeyRotatedSuccess: 'Recovery Key 已轮换'
  }
} as const satisfies IdentityCopy
