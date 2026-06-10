export type AboutPageViewContract = Readonly<{
  header: Readonly<{
    title: string;
    currentYear: number;
    manifestoLabel: string;
    readmeLabel: string;
  }>;
  body: Readonly<{
    content: string;
  }>;
  footer: Readonly<{
    siteTitle: string;
  }>;
}>;

export function createAboutPageViewContract(options: {
  siteTitle: string;
  currentYear: number;
  content: string;
  title?: string;
}): AboutPageViewContract {
  return {
    header: {
      title: options.title?.trim() || '关于',
      currentYear: options.currentYear,
      manifestoLabel: '公开页面',
      readmeLabel: '内容文档'
    },
    body: {
      content: options.content
    },
    footer: {
      siteTitle: options.siteTitle
    }
  };
}
