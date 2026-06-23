// copy/admin.ts — 作者工作台 / 审核回放
//
// 调性校准：
//   - 真实任务语境（"生成预览"、"扫描评论"）
//   - 数字 + 状态描述，不拽营销词

import type { AdminCopy } from './contracts'

export const FSUSBLOG_ADMIN_COPY = {
  moderationReplay: {
    sectionEyebrow: '策略回放',
    sectionTitle: '预览差异',
    sectionDescription: '回放执行前必须先生成预览；执行需要管理员通行密钥二次验证、确认短语和高价值审计。',
    inputRegionPlaceholder: '地区',
    inputRegionAriaLabel: '地区',
    inputPolicyVersionPlaceholder: '上一版策略号',
    inputPolicyVersionAriaLabel: '策略版本',
    inputDictionaryIdPlaceholder: '词库 ID',
    inputDictionaryIdAriaLabel: '词库 ID',
    inputLimitAriaLabel: '扫描数量',
    generatePreviewCta: '生成预览',
    columnComment: '评论',
    columnPolicyVersion: '策略版本',
    columnBlockedRegions: '拦截地区',
    columnRiskLabels: '风险标签',
    columnVisibility: '可见性',
    visibilityChanged: '已变化',
    visibilityUnchanged: '未变化',
    blockedRegionsEmpty: '-',
    riskLabelsEmpty: '-',
    emptyPreviewTitle: '预览暂无差异',
    emptyPreviewDescription: '当前参数没有命中需要比较的评论，调整地区、策略版本或扫描数量后可重新生成预览。',
    notGeneratedTitle: '尚未生成回放预览',
    notGeneratedDescription: '填写地区、上一版策略号或词库 ID 后，先生成预览再进入执行流程。',
    executionNotice: '回放执行当前不提供直接按钮。执行流程必须基于上方预览，完成管理员通行密钥二次验证、确认短语、高价值审计、可中断进度与失败重试后才能进入执行。',
    metricScanned: '扫描评论',
    metricAffected: '受影响评论',
    metricVisibilityChanged: '可见性变化',
    metricHighRiskChanged: '高风险变更',
    metricAddedRegions: '新增拦截地区',
    metricRemovedRegions: '移除拦截地区',
    metricAddedRiskLabels: '新增风险标签',
    metricRemovedRiskLabels: '移除风险标签',
    errorToastFallback: '策略回放预览失败'
  }
} as const satisfies AdminCopy
