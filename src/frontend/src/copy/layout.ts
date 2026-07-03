// copy/layout.ts — 站点头部 / 首页热门推荐 / 主题模式
//
// 调性校准：
//   - 品牌标点 "热门文章" 沿用
//   - 单位文案 "次打开" 是 §9 推荐的任务语境

import type { LayoutCopy } from './contracts'

export const FSUSBLOG_LAYOUT_COPY = {
  siteHeader: {
    ariaLabel: '站点导航',
    navAriaLabel: '主导航',
    fallbackTitle: "Fsu's Blog",
    fallbackDescription: '工程记录、性能实验、UI 系统与 FsusBlog 构建过程。',
    fallbackKeywords: '.NET, 前端性能, 系统设计, UI 系统, 技术博客, FsusBlog',
    fallbackAuthor: 'Fsu',
    fallbackManifestName: "Fsu's Blog",
    fallbackManifestShortName: 'FsusBlog'
  },
  recommendations: {
    eyebrow: '热门文章',
    ariaReadFull: '阅读全文：{title}',
    viewsUnit: '次打开'
  },
  themeMode: {
    label: '主题模式'
  }
} as const satisfies LayoutCopy
