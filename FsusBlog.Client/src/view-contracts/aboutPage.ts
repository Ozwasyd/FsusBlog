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
}): AboutPageViewContract {
  return {
    header: {
      title: '关于',
      currentYear: options.currentYear,
      manifestoLabel: 'MANIFESTO',
      readmeLabel: 'README.MD'
    },
    body: {
      content: options.content
    },
    footer: {
      siteTitle: options.siteTitle
    }
  };
}
