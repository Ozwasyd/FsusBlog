// copy/errors.ts — 全局错误页（403 / 404）
//
// 调性校准：
//   - 去掉 "抱歉" 道歉体
//   - 句号与 FsusUI §2 Punctuation 母题一致（"403." / "404."）

import type { ErrorsCopy } from './contracts'

export const FSUSBLOG_ERRORS_COPY = {
  forbidden: {
    codePrefix: '403',
    title: '访问被拒绝',
    description: '当前账户权限不足以访问此区域。',
    homeCta: '回到主页',
    reLoginCta: '重新登录'
  },
  notFound: {
    codePrefix: '404',
    title: '页面未找到',
    description: '所请求的资源已移动、删除或不存在。',
    homeCta: '回到主页',
    searchCta: '搜索文章',
    archiveCta: '查看归档'
  }
} as const satisfies ErrorsCopy
