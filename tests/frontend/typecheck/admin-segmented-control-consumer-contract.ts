import type {
  FsusUiSegmentedControlItem,
  FsusUiSegmentedControlValue
} from '../../../src/frontend/src/fsusui/segmentedControl'

const ArticlePublishStatus = {
  Draft: 0,
  Scheduled: 1,
  Published: 2,
  Archived: 3
} as const
type ArticlePublishStatusValue = typeof ArticlePublishStatus[keyof typeof ArticlePublishStatus]

const ALL_ARTICLES = 'all' as const
const businessStatusFilters = [
  { label: '全部', value: undefined },
  { label: '草稿', value: ArticlePublishStatus.Draft },
  { label: '定时', value: ArticlePublishStatus.Scheduled },
  { label: '已发布', value: ArticlePublishStatus.Published },
  { label: '归档', value: ArticlePublishStatus.Archived }
] as const

const toPublicItem = (
  item: (typeof businessStatusFilters)[number],
  disabled: boolean
): FsusUiSegmentedControlItem => ({
  label: item.label,
  value: item.value ?? ALL_ARTICLES,
  disabled
})

const toBusinessStatus = (
  value: FsusUiSegmentedControlValue
): ArticlePublishStatusValue | undefined => {
  switch (value) {
    case ArticlePublishStatus.Draft:
    case ArticlePublishStatus.Scheduled:
    case ArticlePublishStatus.Published:
    case ArticlePublishStatus.Archived:
      return value
    default:
      return undefined
  }
}

const publicStatusItems = businessStatusFilters.map((item) => toPublicItem(item, false))
const publicModelValue: FsusUiSegmentedControlValue = ALL_ARTICLES

export const adminSegmentedControlConsumerTypeContract = {
  publicModelValue,
  publicStatusItems,
  selectedBusinessStatus: toBusinessStatus(publicModelValue)
}
