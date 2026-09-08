function stripYamlComment(raw)
{
    let quote = null;
    let escaped = false;

    for (let index = 0; index < raw.length; index += 1)
    {
        const character = raw[index];
        if (quote === '"' && escaped)
        {
            escaped = false;
            continue;
        }
        if (quote === '"' && character === '\\')
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
        if (character === '"' || character === "'")
        {
            quote = character;
            continue;
        }
        if (character === '#' && (index === 0 || /\s/u.test(raw[index - 1])))
        {
            return raw.slice(0, index).trimEnd();
        }
    }

    return raw.trimEnd();
}

function tokenize(text, source)
{
    const tokens = [];
    const lines = String(text ?? '').replace(/^\uFEFF/u, '').split(/\r?\n/u);

    for (let index = 0; index < lines.length; index += 1)
    {
        const raw = lines[index];
        const leading = raw.match(/^[ \t]*/u)?.[0] ?? '';
        if (leading.includes('\t'))
        {
            throw new Error(`${source}:${index + 1}: YAML indentation must not contain tabs`);
        }
        const content = stripYamlComment(raw.slice(leading.length));
        if (!content.trim() || content === '---' || content === '...')
        {
            continue;
        }
        tokens.push({ content: content.trimEnd(), indent: leading.length, line: index + 1 });
    }

    return tokens;
}

function splitFlowItems(value, source, line)
{
    const items = [];
    let start = 0;
    let quote = null;
    let escaped = false;
    let depth = 0;

    for (let index = 0; index < value.length; index += 1)
    {
        const character = value[index];
        if (quote === '"' && escaped)
        {
            escaped = false;
            continue;
        }
        if (quote === '"' && character === '\\')
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
        if (character === '"' || character === "'")
        {
            quote = character;
            continue;
        }
        if (character === '[' || character === '{')
        {
            depth += 1;
        }
        if (character === ']' || character === '}')
        {
            depth -= 1;
        }
        if (character === ',' && depth === 0)
        {
            items.push(value.slice(start, index).trim());
            start = index + 1;
        }
    }

    if (quote || depth !== 0)
    {
        throw new Error(`${source}:${line}: malformed YAML flow collection`);
    }
    items.push(value.slice(start).trim());
    return items.filter(Boolean);
}

function splitMapping(content)
{
    const match = content.match(/^([A-Za-z_][A-Za-z0-9_.-]*):(?:\s+(.*)|\s*)$/u);
    if (!match)
    {
        return null;
    }
    return { key: match[1], value: match[2] ?? '' };
}

export function parseYamlScalar(raw, options = {})
{
    const source = options.source ?? '<yaml>';
    const line = options.line ?? 1;
    const value = String(raw ?? '').trim();

    if (value.startsWith('['))
    {
        if (!value.endsWith(']'))
        {
            throw new Error(`${source}:${line}: unterminated YAML flow sequence`);
        }
        const inner = value.slice(1, -1).trim();
        return inner ? splitFlowItems(inner, source, line).map((item) => parseYamlScalar(item, { source, line })) : [];
    }
    if (value.startsWith('{'))
    {
        if (!value.endsWith('}'))
        {
            throw new Error(`${source}:${line}: unterminated YAML flow mapping`);
        }
        const result = {};
        const inner = value.slice(1, -1).trim();
        for (const item of inner ? splitFlowItems(inner, source, line) : [])
        {
            const mapping = splitMapping(item);
            if (!mapping)
            {
                throw new Error(`${source}:${line}: malformed YAML flow mapping entry`);
            }
            if (Object.hasOwn(result, mapping.key))
            {
                throw new Error(`${source}:${line}: duplicate YAML key ${mapping.key}`);
            }
            result[mapping.key] = parseYamlScalar(mapping.value, { source, line });
        }
        return result;
    }
    if (value === 'true')
    {
        return true;
    }
    if (value === 'false')
    {
        return false;
    }
    if (value === 'null' || value === '~')
    {
        return null;
    }
    if (/^-?\d+(?:\.\d+)?$/u.test(value))
    {
        return Number(value);
    }
    if (value.startsWith('"') || value.startsWith("'"))
    {
        const quote = value[0];
        if (!value.endsWith(quote) || value.length < 2)
        {
            throw new Error(`${source}:${line}: unterminated YAML string`);
        }
        if (quote === '"')
        {
            try
            {
                return JSON.parse(value);
            }
            catch (error)
            {
                throw new Error(`${source}:${line}: invalid YAML double-quoted string: ${error.message}`, { cause: error });
            }
        }
        return value.slice(1, -1).replaceAll("''", "'");
    }
    return value;
}

export function parseYamlDocument(text, options = {})
{
    const source = options.source ?? '<yaml>';
    const tokens = tokenize(text, source);
    let index = 0;

    function current()
    {
        return tokens[index] ?? null;
    }

    function collectFlowValue()
    {
        const first = current();
        const parts = [];
        let squareDepth = 0;
        let braceDepth = 0;
        let quote = null;
        let escaped = false;

        while (index < tokens.length)
        {
            const token = current();
            parts.push(token.content.trim());
            for (const character of token.content)
            {
                if (quote === '"' && escaped)
                {
                    escaped = false;
                    continue;
                }
                if (quote === '"' && character === '\\')
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
                if (character === '"' || character === "'")
                {
                    quote = character;
                }
                else if (character === '[')
                {
                    squareDepth += 1;
                }
                else if (character === ']')
                {
                    squareDepth -= 1;
                }
                else if (character === '{')
                {
                    braceDepth += 1;
                }
                else if (character === '}')
                {
                    braceDepth -= 1;
                }
            }
            index += 1;
            if (!quote && squareDepth === 0 && braceDepth === 0)
            {
                break;
            }
            if (squareDepth < 0 || braceDepth < 0)
            {
                break;
            }
        }

        if (quote || squareDepth !== 0 || braceDepth !== 0)
        {
            throw new Error(`${source}:${first.line}: unterminated YAML flow collection`);
        }
        return parseYamlScalar(parts.join(' '), { source, line: first.line });
    }

    function parseBlockScalar(indicator, keyIndent, startLine)
    {
        const style = indicator[0];
        if (style !== '|' && style !== '>')
        {
            throw new Error(`${source}:${startLine}: unsupported YAML block scalar ${indicator}`);
        }
        if (!/^[|>][-+]?$/u.test(indicator))
        {
            throw new Error(`${source}:${startLine}: unsupported YAML block scalar ${indicator}`);
        }
        const chomp = indicator.length > 1 ? indicator[1] : '';
        const lines = [];
        let contentIndent = null;
        while (index < tokens.length)
        {
            const next = current();
            if (!next || next.indent <= keyIndent)
            {
                break;
            }
            if (contentIndent === null)
            {
                contentIndent = next.indent;
            }
            if (next.indent < contentIndent)
            {
                throw new Error(`${source}:${next.line}: YAML block scalar indentation decreased`);
            }
            const relative = ' '.repeat(next.indent - contentIndent);
            lines.push(relative + next.content);
            index += 1;
        }
        if (style === '>')
        {
            let text = '';
            for (let i = 0; i < lines.length; i += 1)
            {
                const line = lines[i];
                if (line === '')
                {
                    text += '\n';
                    continue;
                }
                if (text !== '' && !text.endsWith('\n'))
                {
                    text += ' ';
                }
                text += line;
            }
            if (chomp === '+')
            {
                text += '\n';
            }
            return text;
        }
        let text = lines.join('\n');
        if (chomp === '+')
        {
            text += '\n';
        }
        else if (chomp === '')
        {
            text += '\n';
        }
        return text;
    }

    function parseValue(raw, token, keyIndent)
    {
        if (raw !== '')
        {
            if (/^[|>][-+0-9]*$/u.test(raw))
            {
                return parseBlockScalar(raw, keyIndent, token.line);
            }
            return parseYamlScalar(raw, { source, line: token.line });
        }
        const next = current();
        if (!next || next.indent <= keyIndent)
        {
            return null;
        }
        return parseBlock(next.indent);
    }

    function parseMapping(indent)
    {
        const result = {};
        while (index < tokens.length)
        {
            const token = current();
            if (token.indent < indent)
            {
                break;
            }
            if (token.indent > indent)
            {
                throw new Error(`${source}:${token.line}: unexpected YAML indentation`);
            }
            if (token.content.startsWith('-'))
            {
                break;
            }

            const mapping = splitMapping(token.content);
            if (!mapping)
            {
                throw new Error(`${source}:${token.line}: expected a YAML mapping entry`);
            }
            if (Object.hasOwn(result, mapping.key))
            {
                throw new Error(`${source}:${token.line}: duplicate YAML key ${mapping.key}`);
            }
            index += 1;
            result[mapping.key] = parseValue(mapping.value, token, indent);
        }
        return result;
    }

    function parseSequence(indent)
    {
        const result = [];
        while (index < tokens.length)
        {
            const token = current();
            if (token.indent < indent)
            {
                break;
            }
            if (token.indent > indent)
            {
                throw new Error(`${source}:${token.line}: unexpected YAML sequence indentation`);
            }
            if (!token.content.startsWith('-'))
            {
                break;
            }
            const item = token.content.slice(1).trimStart();
            index += 1;

            if (!item)
            {
                const next = current();
                if (!next || next.indent <= indent)
                {
                    throw new Error(`${source}:${token.line}: empty YAML sequence item`);
                }
                result.push(parseBlock(next.indent));
                continue;
            }

            const firstMapping = splitMapping(item);
            if (!firstMapping)
            {
                const value = parseYamlScalar(item, { source, line: token.line });
                if (current() && current().indent > indent)
                {
                    throw new Error(`${source}:${current().line}: scalar YAML sequence item cannot own nested content`);
                }
                result.push(value);
                continue;
            }

            const mappingIndent = indent + 2;
            const record = {};
            record[firstMapping.key] = parseValue(firstMapping.value, token, mappingIndent);
            if (current() && current().indent === mappingIndent && !current().content.startsWith('-'))
            {
                const continuation = parseMapping(mappingIndent);
                for (const [key, value] of Object.entries(continuation))
                {
                    if (Object.hasOwn(record, key))
                    {
                        throw new Error(`${source}:${token.line}: duplicate YAML key ${key}`);
                    }
                    record[key] = value;
                }
            }
            else if (current() && current().indent > indent && current().indent !== mappingIndent)
            {
                throw new Error(`${source}:${current().line}: misaligned YAML sequence mapping field`);
            }
            result.push(record);
        }
        return result;
    }

    function parseBlock(indent)
    {
        const token = current();
        if (!token || token.indent !== indent)
        {
            throw new Error(`${source}: invalid YAML block indentation`);
        }
        if (token.content.startsWith('[') || token.content.startsWith('{'))
        {
            return collectFlowValue();
        }
        return token.content.startsWith('-') ? parseSequence(indent) : parseMapping(indent);
    }

    if (tokens.length === 0)
    {
        return {};
    }
    if (tokens[0].indent !== 0)
    {
        throw new Error(`${source}:${tokens[0].line}: YAML document must start at column zero`);
    }
    const document = parseBlock(0);
    if (index !== tokens.length)
    {
        throw new Error(`${source}:${current()?.line ?? 1}: trailing YAML content was not consumed`);
    }
    return document;
}
