import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Use the repository's AST style authority, including its typed rules. The additional
// producer rule only separates statements; it does not suppress any style diagnostics.
export async function formatPropertyReadTypeScript(source, repositoryRoot, fileName)
{
    const apiUrl = pathToFileURL(path.join(repositoryRoot, 'tools/frontend/style-toolchain/node_modules/eslint/lib/api.js'));
    const { ESLint } = await import(apiUrl.href);
    const eslint = new ESLint({
        cwd: repositoryRoot,
        overrideConfigFile: path.join(repositoryRoot, 'eslint.config.mjs'),
        fix: true,
        overrideConfig: [{
            plugins: {
                'property-read-producer': {
                    rules: {
                        'separate-statements': {
                            meta: { type: 'layout', schema: [], fixable: 'whitespace' },
                            create(context)
                            {
                                return {
                                    Program(node)
                                    {
                                        const tokens = context.sourceCode.getTokens(node);
                                        for (let index = 0; index < tokens.length - 1; index++)
                                        {
                                            const token = tokens[index];
                                            const next = tokens[index + 1];
                                            if (token.value === ';' && token.loc.end.line === next.loc.start.line)
                                            {
                                                context.report({
                                                    node,
                                                    loc: token.loc,
                                                    message: 'Generate each statement on a separate line.',
                                                    fix: fixer => fixer.replaceTextRange([token.range[1], next.range[0]], '\n')
                                                });
                                            }
                                        }
                                    },
                                    BlockStatement(node)
                                    {
                                        const last = context.sourceCode.getLastToken(node);
                                        const next = context.sourceCode.getTokenAfter(node);
                                        if (next && last.loc.end.line === next.loc.start.line
                                            && ![';', ',', ')', ']'].includes(next.value))
                                        {
                                            context.report({
                                                node,
                                                loc: last.loc,
                                                message: 'Generate each statement on a separate line.',
                                                fix: fixer => fixer.replaceTextRange([last.range[1], next.range[0]], '\n')
                                            });
                                        }
                                    }
                                };
                            }
                        }
                    }
                }
            },
            rules: { 'property-read-producer/separate-statements': 'error' }
        }]
    });
    let formatted = source;
    for (let attempt = 0; attempt < 3; attempt++)
    {
        const [result] = await eslint.lintText(formatted, { filePath: fileName });
        formatted = result.output ?? formatted;
        if (result.errorCount === 0 && result.warningCount === 0)
        {
            return formatted;
        }
        if (!result.output || attempt === 2)
        {
            throw new Error(`property_read_generated_style: ${JSON.stringify(result.messages)}`);
        }
    }
    throw new Error('property_read_generated_style_unreachable');
}
