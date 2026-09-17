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
}>;

export function createAboutPageViewContract(options: {
    currentYear: number;
    content: string;
    title?: string;
}): AboutPageViewContract
{
    const title = options.title?.trim() || '关于';
    const labels = createStaticPageLabels(title);

    return {
        header: {
            title,
            currentYear: options.currentYear,
            manifestoLabel: labels.manifestoLabel,
            readmeLabel: labels.readmeLabel
        },
        body: {
            content: options.content
        }
    };
}

function createStaticPageLabels(title: string): Pick<AboutPageViewContract['header'], 'manifestoLabel' | 'readmeLabel'>
{
    if (title.includes('隐私'))
    {
        return {
            manifestoLabel: '隐私说明',
            readmeLabel: '访问边界'
        };
    }

    if (title.includes('守则') || title.includes('规范'))
    {
        return {
            manifestoLabel: '站点规范',
            readmeLabel: '阅读与互动'
        };
    }

    if (title.includes('版权'))
    {
        return {
            manifestoLabel: '版权说明',
            readmeLabel: '内容授权'
        };
    }

    return {
        manifestoLabel: '站点说明',
        readmeLabel: '持续更新'
    };
}
