export type ThemeTokenContract = Readonly<{
  focusRing: string;
  articleList: Readonly<{
    container: string;
    card: string;
    metaRow: string;
    metaSeparator: string;
    metaCategory: string;
    title: string;
    titleLink: string;
    summary: string;
    readLink: string;
    pagination: string;
    paginationIndicator: string;
  }>;
  articleDetail: Readonly<{
    header: string;
    title: string;
    metaRow: string;
    metaSeparator: string;
    categoryLink: string;
    categoryText: string;
    footer: string;
    tagList: string;
    tagLink: string;
    commentsRoot: string;
    commentsHeading: string;
    commentsPlaceholderRoot: string;
    commentsPlaceholderDot: string;
    commentsPlaceholderText: string;
  }>;
  userComments: Readonly<{
    list: string;
    item: string;
    itemHeader: string;
    articleLabel: string;
    articleLink: string;
    time: string;
    content: string;
    footer: string;
    endHint: string;
  }>;
  dashboard: Readonly<{
    statGrid: string;
    statCard: string;
    statIconWrap: string;
    statLabel: string;
    statValue: string;
  }>;
}>;
