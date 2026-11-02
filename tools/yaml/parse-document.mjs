function trimYamlWhitespace(value)
{
    return value.replace(/^[ \t\r\n]+|[ \t\r\n]+$/gu, '');
}

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
        if (character === '#' && (index === 0 || /[ \t]/u.test(raw[index - 1])))
        {
            return raw.slice(0, index).replace(/[ \t]+$/u, '');
        }
    }

    return raw.replace(/[ \t]+$/u, '');
}

function tokenize(text)
{
    const tokens = [];
    const document = String(text ?? '').replace(/^\uFEFF/u, '');
    const lines = document.split(/\r?\n/u);
    if (document.endsWith('\n'))
    {
        lines.pop();
    }

    for (let index = 0; index < lines.length; index += 1)
    {
        const raw = lines[index];
        const leading = raw.match(/^[ \t]*/u)?.[0] ?? '';
        const content = stripYamlComment(raw.slice(leading.length));
        // Structural comments are ignored only when reading structure. Block
        // scalars must retain comment text, empty lines and their physical breaks.
        tokens.push({
            content,
            raw,
            leading,
            indent: raw.match(/^ */u)[0].length,
            ignored: !trimYamlWhitespace(content) || content === '---' || content === '...',
            terminated: index < lines.length - 1 || document.endsWith('\n'),
            line: index + 1
        });
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
            items.push(trimYamlWhitespace(value.slice(start, index)));
            start = index + 1;
        }
    }

    if (quote || depth !== 0)
    {
        throw new Error(`${source}:${line}: malformed YAML flow collection`);
    }
    items.push(trimYamlWhitespace(value.slice(start)));
    return items.filter(Boolean);
}

function splitMapping(content)
{
    const match = content.match(/^([A-Za-z_][A-Za-z0-9_.-]*):(?:[ \t]+(.*)|[ \t]*)$/u);
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
    const value = trimYamlWhitespace(String(raw ?? ''));

    if (value.startsWith('['))
    {
        if (!value.endsWith(']'))
        {
            throw new Error(`${source}:${line}: unterminated YAML flow sequence`);
        }
        const inner = trimYamlWhitespace(value.slice(1, -1));
        return inner ? splitFlowItems(inner, source, line).map((item) => parseYamlScalar(item, { source, line })) : [];
    }
    if (value.startsWith('{'))
    {
        if (!value.endsWith('}'))
        {
            throw new Error(`${source}:${line}: unterminated YAML flow mapping`);
        }
        const result = {};
        const inner = trimYamlWhitespace(value.slice(1, -1));
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
    const tokens = tokenize(text);
    let index = 0;

    function current()
    {
        while (index < tokens.length)
        {
            const token = tokens[index];
            if (token.leading.includes('\t'))
            {
                throw new Error(`${source}:${token.line}: YAML indentation must not contain tabs`);
            }
            if (!token.ignored)
            {
                return token;
            }
            index += 1;
        }
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
            if (!token)
            {
                break;
            }
            parts.push(trimYamlWhitespace(token.content));
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
        const block = [];
        let contentIndent = null;
        while (index < tokens.length)
        {
            // Read physical lines directly, before structural comment removal.
            const next = tokens[index];
            const empty = next.raw.length === next.indent;
            if (!empty && next.indent <= keyIndent)
            {
                break;
            }
            if (!empty && contentIndent === null)
            {
                contentIndent = next.indent;
                if (block.some((line) => line.indent > contentIndent))
                {
                    throw new Error(`${source}:${next.line}: YAML block scalar leading empty line is over-indented`);
                }
            }
            if (!empty && next.indent < contentIndent)
            {
                throw new Error(`${source}:${next.line}: YAML block scalar indentation decreased`);
            }
            block.push(next);
            index += 1;
        }
        const lines = block.map((line) => ({
            text: contentIndent === null ? '' : line.raw.slice(contentIndent),
            terminated: line.terminated
        }));
        let text = '';
        for (let position = 0; position < lines.length; position += 1)
        {
            const line = lines[position];
            text += line.text;
            if (!line.terminated)
            {
                continue;
            }
            if (style === '>' && line.text !== '' && !/^[ \t]/u.test(line.text))
            {
                let following = position + 1;
                while (following < lines.length && lines[following].text === '')
                {
                    following += 1;
                }
                const next = lines[following];
                if (next && !/^[ \t]/u.test(next.text))
                {
                    // Adjacent ordinary lines fold to a space. An intervening
                    // empty line supplies its own newline, preserving paragraphs.
                    if (following === position + 1)
                    {
                        text += ' ';
                    }
                    continue;
                }
            }
            text += '\n';
        }
        if (chomp === '-')
        {
            return text.replace(/\n+$/u, '');
        }
        if (chomp === '' && text.endsWith('\n'))
        {
            const clipped = text.replace(/\n+$/u, '');
            return clipped === '' ? '' : `${clipped}\n`;
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
            if (!token)
            {
                break;
            }
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
            if (!token)
            {
                break;
            }
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
            const item = token.content.slice(1).replace(/^[ \t]+/u, '');
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

    const first = current();
    if (!first)
    {
        return {};
    }
    if (first.indent !== 0)
    {
        throw new Error(`${source}:${first.line}: YAML document must start at column zero`);
    }
    const document = parseBlock(0);
    if (current())
    {
        throw new Error(`${source}:${current()?.line ?? 1}: trailing YAML content was not consumed`);
    }
    return document;
}
