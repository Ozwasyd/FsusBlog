import { validateStrykerToolPolicy } from './stryker-tool.mjs';

const callerCommand = 'Run node "$ROOT_DIR/tools/mutation/stryker-tool.mjs" run --working-directory "$workingDir" --attestation-output "$outputDir/tool-binding.json" -- --config-file "$configPath" --output "$outputDir" "${strykerTraceArgs[@]}"';
const reportCommand = 'Run node "$ROOT_DIR/tools/test/check-stryker-report.mjs" "$outputDir/reports/$reportName.json" --config "$configPath" --tier "$authorityTier" --out "$authorityOut" --tool-binding "$outputDir/tool-binding.json" --trace-log "${traceLogs[0]}" --source-root "${authoritySourceRoot#"$ROOT_DIR"/}"';

// Ignore quoted text, comments and literal heredocs before locating a declaration.
// Unsupported heredoc delimiters refuse instead of being treated as executable source.
function executableLines(source)
{
    const lines = [];
    const pending = [];
    let heredoc = null;
    let quote = null;
    for (const line of source.split(/\r?\n/u))
    {
        if (heredoc)
        {
            if ((heredoc.stripTabs ? line.replace(/^\t+/u, '') : line) === heredoc.delimiter)
            {
                heredoc = pending.shift() ?? null;
            }
            lines.push('');
            continue;
        }
        const continuedQuote = quote !== null;
        let escaped = false;
        let end = line.length;
        for (let index = 0; index < line.length; index++)
        {
            const character = line[index];
            if (escaped)
            {
                escaped = false;
                continue;
            }
            if (quote === "'")
            {
                if (character === quote)
                {
                    quote = null;
                }
                continue;
            }
            if (character === '\\')
            {
                escaped = true;
                continue;
            }
            if (quote)
            {
                if (character === quote)
                {
                    quote = null;
                }
                continue;
            }
            if (character === '#' && (index === 0 || /\s/u.test(line[index - 1])))
            {
                end = index;
                break;
            }
            if (character === '<' && line[index - 1] !== '<' && line[index + 1] === '<' && line[index + 2] !== '<')
            {
                const match = /^<<(-?)\s*(?:'([A-Za-z_][A-Za-z0-9_]*)'|"([A-Za-z_][A-Za-z0-9_]*)"|([A-Za-z_][A-Za-z0-9_]*))(?=\s|$)/u.exec(line.slice(index));
                if (!match)
                {
                    throw new Error('unsupported Shell heredoc delimiter');
                }
                pending.push({ delimiter: match[2] ?? match[3] ?? match[4], stripTabs: match[1] === '-' });
                index += match[0].length - 1;
                continue;
            }
            if (["'", '"', '`'].includes(character))
            {
                quote = character;
            }
        }
        lines.push(continuedQuote ? '' : line.slice(0, end));
        if (!quote && pending.length > 0 && !/\\\s*$/u.test(line))
        {
            heredoc = pending.shift();
        }
    }
    if (heredoc || pending.length > 0 || quote)
    {
        throw new Error('incomplete Shell literal');
    }
    return lines;
}

/**
 * Check the source interface of the original fresh, run-bound producer.
 * docs/testing.md distinguishes the upstream manifest pin from the installed
 * repository fork. These checks grant no physical execution/custody acceptance.
 */
export function verifyStrykerCallerContract({ laneSource, policy, manifest, patch, expressionTreePatch })
{
    const errors = [];
    const fail = (message) => errors.push(`backend mutation caller: ${message}`);
    try
    {
        validateStrykerToolPolicy(policy, manifest, patch, expressionTreePatch);
        if (policy.toolManifestPath !== '.config/dotnet-tools.json')
        {
            fail('producer must discover the canonical repository-root tool manifest');
        }
    }
    catch (error)
    {
        fail(error.message);
    }
    try
    {
        if (typeof laneSource !== 'string')
        {
            throw new Error('Shell caller source is missing');
        }
        const lines = executableLines(laneSource);
        const starts = lines.flatMap((line, index) => line === 'RunBackendMutationWithConfig() {' ? [index] : []);
        if (starts.length !== 1)
        {
            throw new Error('requires exactly one original mutation caller declaration');
        }
        const end = lines.findIndex((line, index) => index > starts[0] && line === '}');
        if (end < 0)
        {
            throw new Error('mutation caller declaration is incomplete');
        }
        const commands = lines.slice(starts[0] + 1, end).join('\n')
            .replace(/[ \t]*\\\n[ \t]*/gu, ' ').split('\n').map((line) => line.trim());
        if (commands.filter((line) => line === callerCommand).length !== 1)
        {
            fail('requires the exact canonical producer invocation with working directory, config, output and run-owned tool binding');
        }
        if (commands.filter((line) => line === reportCommand).length !== 1)
        {
            fail('report must consume the same canonical tool-binding output');
        }
        if (commands.some((line) => /^(?:Run\s+)?dotnet\s+tool\s+(?:restore|run|install)\b/u.test(line)))
        {
            fail('legacy manifest tool execution cannot substitute the run-bound repository producer');
        }
    }
    catch (error)
    {
        fail(error.message);
    }
    return errors;
}
