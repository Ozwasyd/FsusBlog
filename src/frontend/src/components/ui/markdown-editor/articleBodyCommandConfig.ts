export const articleBodyPrimaryCommandKeys = [
    'heading',
    'bold',
    'italic',
    'link',
    'quote',
    'code'
] as const;

export type ArticleBodyPrimaryCommandKey = (typeof articleBodyPrimaryCommandKeys)[number];

export const articleBodyForbiddenCommandKeys = ['h1', 'heading-1'] as const;

export const articleBodyStructureCommandKeys = [
    'heading-3',
    'heading-4',
    'heading-5',
    'heading-6'
] as const;

export const articleBodyInsertCommandKeys = [
    'ul',
    'ol',
    'task',
    'block',
    'latex',
    'mermaid',
    'table',
    'hr'
] as const;

export const articleBodyExtraCommandKeys = [
    ...articleBodyStructureCommandKeys,
    ...articleBodyInsertCommandKeys
] as const;

export type ArticleBodyExtraCommandKey = (typeof articleBodyExtraCommandKeys)[number];

/**
 * FsusUI toolbar primary resolution sorts by command.priority, not array
 * order. These values freeze the product order 章节 / 粗体 / 斜体 / 链接 /
 * 引用 / 行内代码 without Blog-local toolbar selectors.
 */
export const articleBodyPrimaryPriorityByKey: Readonly<Record<ArticleBodyPrimaryCommandKey, number>> = {
    heading: 600,
    bold: 500,
    italic: 400,
    link: 300,
    quote: 200,
    code: 100
};

export const articleBodyCommandSurfaces = Object.freeze({
    toolbar: true,
    commandPalette: true,
    selectionToolbar: true,
    slashMenu: true
});

export const articleBodyLocaleText = Object.freeze({
    commands: Object.freeze({
        heading: '章节',
        bold: '粗体',
        italic: '斜体',
        link: '链接',
        quote: '引用',
        code: '行内代码'
    }),
    commandGroups: Object.freeze({
        format: '文本',
        block: '结构',
        insert: '插入',
        code: '代码',
        media: '媒体'
    })
});

export const articleBodyCommandOverflowLabel = '插入';

export function isArticleBodyForbiddenCommandKey(key: string): boolean
{
    return (articleBodyForbiddenCommandKeys as readonly string[]).includes(key);
}

export function isArticleBodyPrimaryCommandKey(key: string): key is ArticleBodyPrimaryCommandKey
{
    return (articleBodyPrimaryCommandKeys as readonly string[]).includes(key);
}

export function applyArticleBodyPrimaryPriorities<
    T extends { readonly key: string; readonly priority?: number; }
>(commands: readonly T[]): T[]
{
    return commands.map((command) =>
    {
        if (!isArticleBodyPrimaryCommandKey(command.key))
        {
            return command;
        }

        return {
            ...command,
            priority: articleBodyPrimaryPriorityByKey[command.key]
        };
    });
}

export function composeArticleBodyEditorCommands<T extends { readonly key: string; readonly priority?: number; }>(
    defaultCommands: readonly T[],
    extraCommands: readonly T[],
    excludedKeys: readonly string[] = []
): T[]
{
    const excluded = new Set(excludedKeys);
    const extraKeySet = new Set<string>(articleBodyExtraCommandKeys);
    const defaults = applyArticleBodyPrimaryPriorities(defaultCommands)
        .filter((command) => !isArticleBodyForbiddenCommandKey(command.key) && !excluded.has(command.key));
    const defaultKeys = new Set(defaults.map((command) => command.key));
    const extras = extraCommands.filter((command) => extraKeySet.has(command.key)
        && !isArticleBodyForbiddenCommandKey(command.key)
        && !defaultKeys.has(command.key)
        && !excluded.has(command.key));
    return [...defaults, ...extras];
}
