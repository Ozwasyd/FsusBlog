import { validateStrykerToolPolicy } from './stryker-tool.mjs';

// Closed source contract, independent of the candidate. The complete supported
// program fixes argument origins, both authority guards, producer/report order,
// and every command. Unknown statements/branches/assignments refuse. This is a
// bounded caller analysis, not a Bash interpreter or runtime custody receipt.
const canonicalBody = [
    '    local configPath="$1"',
    '    local outputDir="$2"',
    '    local reportName="$3"',
    '    local workingDir="${4:-$ROOT_DIR}"',
    '    local authorityTier="${5:-}"',
    '    local authorityOut="${6:-}"',
    '    local authoritySourceRoot="${7:-$ROOT_DIR}"',
    '    local strykerTraceArgs=()',
    '    if [[ -n "$authorityTier" || -n "$authorityOut" ]]; then',
    '        if [[ -z "$authorityTier" || -z "$authorityOut" ]]; then',
    '            Fail "Stryker authority requires both tier and output path"',
    '        fi',
    '        strykerTraceArgs=(--log-to-file --verbosity trace)',
    '    fi',
    '    Run rm -rf "$outputDir"',
    '    local FSUSBLOG_MUTATION_BUILD=1',
    '    export FSUSBLOG_MUTATION_BUILD',
    '    Run node "$ROOT_DIR/tools/mutation/stryker-tool.mjs" run --working-directory "$workingDir" --attestation-output "$outputDir/tool-binding.json" -- --config-file "$configPath" --output "$outputDir" "${strykerTraceArgs[@]}"',
    '    if [[ -n "$authorityTier" || -n "$authorityOut" ]]; then',
    '        local traceLogs=()',
    '        mapfile -t traceLogs < <(',
    '            find "$outputDir/logs" -maxdepth 1 -type f -name \'log-*.txt\' -print | sort',
    '        )',
    '        if [[ "${#traceLogs[@]}" -ne 1 ]]; then',
    '            Fail "Stryker authority requires exactly one verbose trace log, found ${#traceLogs[@]}"',
    '        fi',
    '        Run node "$ROOT_DIR/tools/test/check-stryker-report.mjs" "$outputDir/reports/$reportName.json" --config "$configPath" --tier "$authorityTier" --out "$authorityOut" --tool-binding "$outputDir/tool-binding.json" --trace-log "${traceLogs[0]}" --source-root "${authoritySourceRoot#"$ROOT_DIR"/}"',
    '        if [[ "$authorityTier" == "release-mutation-critical-slice" ]]; then',
    '            Run node "$ROOT_DIR/tools/test/check-mutation-inventory.mjs" --authority "$authorityOut"',
    '        fi',
    '    else',
    '        Run node "$ROOT_DIR/tools/test/check-stryker-report.mjs" "$outputDir/reports/$reportName.json"',
    '    fi'
].join('\n');
const callerName = 'RunBackendMutationWithConfig';
const contractError = 'requires the exact canonical producer invocation and report consuming the same canonical tool-binding, with original variable origins and control flow; legacy manifest tool execution and unsupported caller statements refuse';

// Lex shell words without executing expansions. Quotes, parameter/command
// substitutions and literal heredocs stay opaque, so embedded example text
// cannot declare a function. Preserve raw words for the closed AST comparison.
function shellTokens(input)
{
    const source = input.replace(/\r\n/gu, '\n');
    const tokens = [];
    const heredocs = [];
    let index = 0;
    let wantsDelimiter = null;
    let wordEnd = -1;
    const quoted = (quote) =>
    {
        index++;
        while (index < source.length)
        {
            const character = source[index];
            if (character === quote)
            {
                index++;
                return;
            }
            if (quote !== "'" && character === '\\')
            {
                index += 2;
            }
            else if (quote === '"' && source[index] === '$' && ['{', '('].includes(source[index + 1]))
            {
                expansion();
            }
            else
            {
                index++;
            }
        }
        throw new Error('incomplete Shell literal');
    };
    const expansion = () =>
    {
        const open = source[index + 1];
        const close = open === '{' ? '}' : ')';
        index += 2;
        let depth = 1;
        while (index < source.length)
        {
            const character = source[index];
            if (["'", '"', '`'].includes(character))
            {
                quoted(character);
            }
            else if (character === '\\')
            {
                index += 2;
            }
            else if (character === '$' && ['{', '('].includes(source[index + 1]))
            {
                expansion();
            }
            else
            {
                index++;
                if (character === open)
                {
                    depth++;
                }
                else if (character === close && --depth === 0)
                {
                    return;
                }
            }
        }
        throw new Error('incomplete Shell expansion');
    };
    while (index < source.length)
    {
        const character = source[index];
        if (character === '\\' && source[index + 1] === '\n')
        {
            index += 2;
            continue;
        }
        if (character === ' ' || character === '\t')
        {
            index++;
            continue;
        }
        if (character === '#')
        {
            while (index < source.length && source[index] !== '\n')
            {
                index++;
            }
            continue;
        }
        if (character === '\n')
        {
            tokens.push('\n');
            index++;
            for (const { delimiter, stripTabs } of heredocs.splice(0))
            {
                let found = false;
                while (index < source.length)
                {
                    const end = source.indexOf('\n', index);
                    const line = source.slice(index, end < 0 ? source.length : end);
                    index = end < 0 ? source.length : end + 1;
                    if ((stripTabs ? line.replace(/^\t+/u, '') : line) === delimiter)
                    {
                        found = true;
                        break;
                    }
                }
                if (!found)
                {
                    throw new Error('incomplete Shell literal');
                }
            }
            continue;
        }
        if ('();{}<>|&'.includes(character))
        {
            const operator = /^(?:<\(|<<<|<<-|<<|>>|\|\||&&|[();{}<>|&])/u.exec(source.slice(index))[0];
            tokens.push(operator === '(' && wordEnd === index && tokens.at(-1)?.endsWith('=') ? 'array(' : operator);
            index += operator.length;
            if (operator === '<<' || operator === '<<-')
            {
                wantsDelimiter = operator === '<<-';
            }
            continue;
        }
        const start = index;
        while (index < source.length && !/[\s();{}<>|&]/u.test(source[index]))
        {
            if (["'", '"', '`'].includes(source[index]))
            {
                quoted(source[index]);
            }
            else if (source[index] === '$' && ['{', '('].includes(source[index + 1]))
            {
                expansion();
            }
            else if (source[index] === '\\')
            {
                if (index + 1 >= source.length)
                {
                    throw new Error('incomplete Shell escape');
                }
                index += 2;
            }
            else
            {
                index++;
            }
        }
        const word = source.slice(start, index).replace(/\\\n/gu, '');
        tokens.push(word);
        wordEnd = index;
        if (wantsDelimiter !== null)
        {
            const delimiter = literalName(word);
            if (!delimiter || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(delimiter))
            {
                throw new Error('unsupported Shell heredoc delimiter');
            }
            heredocs.push({ delimiter, stripTabs: wantsDelimiter });
            wantsDelimiter = null;
        }
    }
    if (wantsDelimiter !== null || heredocs.length > 0)
    {
        throw new Error('incomplete Shell literal');
    }
    return tokens;
}

// Quote removal is only for literal declaration names/delimiters. Dynamic names
// are unsupported; word spelling in the body remains exact, including quoting.
function literalName(word)
{
    if (word === undefined || /[$`]/u.test(word))
    {
        return null;
    }
    return word.replace(/\\(.)/gu, '$1').replace(/["']/gu, '');
}

function callerBody(tokens)
{
    const declarations = [];
    const next = (position) =>
    {
        while (tokens[position] === '\n')
        {
            position++;
        }
        return position;
    };
    for (let index = 0; index < tokens.length; index++)
    {
        const withKeyword = tokens[index] === 'function';
        const nameIndex = withKeyword ? next(index + 1) : index;
        let position = next(nameIndex + 1);
        if (tokens[position] === '(' && tokens[next(position + 1)] === ')')
        {
            position = next(next(position + 1) + 1);
        }
        else if (!withKeyword)
        {
            continue;
        }
        const name = literalName(tokens[nameIndex]);
        if (name === null)
        {
            throw new Error('unsupported dynamic Shell function declaration');
        }
        if (name !== callerName)
        {
            continue;
        }
        if (tokens[position] !== '{')
        {
            throw new Error('unsupported mutation caller declaration body');
        }
        // Do not count the name again after recognizing the function keyword.
        if (withKeyword)
        {
            index = nameIndex;
        }
        let depth = 1;
        let end = position + 1;
        for (; end < tokens.length && depth > 0; end++)
        {
            if (tokens[end] === '{')
            {
                depth++;
            }
            else if (tokens[end] === '}')
            {
                depth--;
            }
        }
        if (depth !== 0)
        {
            throw new Error('mutation caller declaration is incomplete');
        }
        if (end < tokens.length && !['\n', ';'].includes(tokens[end]))
        {
            throw new Error(contractError);
        }
        declarations.push(tokens.slice(position + 1, end - 1));
    }
    if (declarations.length !== 1)
    {
        throw new Error('requires exactly one original mutation caller declaration');
    }
    return declarations[0];
}

// Supported grammar: statement lists of commands/local declarations/assignments
// and nested if/then/else/fi; parentheses only group command arguments (arrays and
// the fixed mapfile process substitution). The closed AST below decides which
// commands, conditions and groups are admissible; nothing is silently ignored.
function program(tokens)
{
    let index = 0;
    const separator = (word) => word === '\n' || word === ';';
    const skip = () =>
    {
        while (separator(tokens[index]))
        {
            index++;
        }
    };
    const statements = (stops = []) =>
    {
        const nodes = [];
        skip();
        while (index < tokens.length && !stops.includes(tokens[index]))
        {
            if (tokens[index] === 'if')
            {
                index++;
                const condition = [];
                while (index < tokens.length && tokens[index] !== 'then')
                {
                    condition.push(tokens[index++]);
                }
                if (tokens[index++] !== 'then' || condition.length === 0 || !separator(condition.at(-1)))
                {
                    throw new Error(contractError);
                }
                while (separator(condition.at(-1)))
                {
                    condition.pop();
                }
                const consequent = statements(['else', 'fi']);
                let alternate = null;
                if (tokens[index] === 'else')
                {
                    index++;
                    alternate = statements(['fi']);
                }
                if (tokens[index++] !== 'fi')
                {
                    throw new Error(contractError);
                }
                if (index < tokens.length && !separator(tokens[index]))
                {
                    throw new Error(contractError);
                }
                nodes.push({ type: 'if', condition, consequent, alternate });
            }
            else
            {
                const words = [];
                const group = () =>
                {
                    const open = tokens[index++];
                    const contents = [];
                    while (index < tokens.length && tokens[index] !== ')')
                    {
                        contents.push(['(', 'array(', '<('].includes(tokens[index]) ? group() : tokens[index++]);
                    }
                    if (tokens[index++] !== ')')
                    {
                        throw new Error(contractError);
                    }
                    // Only boundary newlines in a parenthesized group are layout.
                    // Interior separators remain significant (a second command
                    // cannot masquerade as extra arguments to find, for example).
                    while (contents[0] === '\n')
                    {
                        contents.shift();
                    }
                    while (contents.at(-1) === '\n')
                    {
                        contents.pop();
                    }
                    return { open, contents };
                };
                while (index < tokens.length && !separator(tokens[index]))
                {
                    if (['(', 'array(', '<('].includes(tokens[index]))
                    {
                        words.push(group());
                    }
                    else
                    {
                        const word = tokens[index++];
                        if ([')', '{', '}'].includes(word))
                        {
                            throw new Error(contractError);
                        }
                        words.push(word);
                    }
                }
                if (words.length === 0)
                {
                    throw new Error(contractError);
                }
                const type = words[0] === 'local' ? 'local' : /^[A-Za-z_][A-Za-z0-9_]*=/u.test(words[0]) ? 'assignment' : 'command';
                nodes.push({ type, words });
            }
            skip();
        }
        return nodes;
    };
    const nodes = statements();
    if (index !== tokens.length)
    {
        throw new Error(contractError);
    }
    return nodes;
}

const canonicalProgram = JSON.stringify(program(shellTokens(canonicalBody)));

/** Source-only contract: no physical execution or custody acceptance. */
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
        if (JSON.stringify(program(callerBody(shellTokens(laneSource)))) !== canonicalProgram)
        {
            throw new Error(contractError);
        }
    }
    catch (error)
    {
        fail(error.message);
    }
    return errors;
}
