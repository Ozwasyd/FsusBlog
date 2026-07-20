import type { TranslationKey } from '@/locales'

const routeTitleKeys = new Map<string, TranslationKey>([
  ['首页', 'common.routeTitles.home'],
  ['文章详情', 'common.routeTitles.article'],
  ['归档', 'common.routeTitles.archive'],
  ['关于', 'common.routeTitles.about'],
  ['隐私政策', 'common.routeTitles.privacy'],
  ['用户守则', 'common.routeTitles.guidelines'],
  ['版权声明', 'common.routeTitles.copyright'],
  ['搜索结果', 'common.routeTitles.search'],
  ['登录', 'common.routeTitles.login'],
  ['注册', 'common.routeTitles.register'],
  ['恢复访问', 'common.routeTitles.recover'],
  ['身份中心', 'common.routeTitles.account'],
  ['我的消息', 'common.routeTitles.messages'],
  ['仪表盘', 'common.routeTitles.dashboard'],
  ['写文章', 'common.routeTitles.writeArticle'],
  ['评论审核', 'common.routeTitles.moderateComments'],
  ['系统设置', 'common.routeTitles.settings'],
  ['无权访问', 'common.routeTitles.forbidden'],
  ['页面不存在', 'common.routeTitles.notFound']
])

export function resolveRouteTitleKey(title: string): TranslationKey | undefined {
  return routeTitleKeys.get(title)
}
