function preserveLineBreak(character)
{
    return character === '\n' || character === '\r' ? character : ' ';
}

function maskRange(output, source, start, end)
{
    for (let cursor = start; cursor < end; cursor += 1)
    {
        output[cursor] = preserveLineBreak(source[cursor]);
    }
}

function commentEnd(source, index)
{
    if (source.startsWith('//', index))
    {
        const end = source.indexOf('\n', index + 2);
        return end < 0 ? source.length : end;
    }
    if (source.startsWith('/*', index))
    {
        const end = source.indexOf('*/', index + 2);
        return end < 0 ? source.length : end + 2;
    }
    return null;
}

function describeRawString(source, index)
{
    const match = source.slice(index).match(/^(\$*)("{3,})/u);
    if (!match)
    {
        return null;
    }
    return {
        braceArity: match[1].length,
        delimiter: match[2],
        interpolated: match[1].length > 0,
        kind: 'raw',
        openingLength: match[0].length
    };
}

function describeQuotedString(source, index)
{
    if (source.startsWith('$@"', index) || source.startsWith('@$"', index))
    {
        return { braceArity: 1, delimiter: '"', interpolated: true, kind: 'verbatim', openingLength: 3 };
    }
    if (source.startsWith('@"', index))
    {
        return { delimiter: '"', interpolated: false, kind: 'verbatim', openingLength: 2 };
    }
    if (source.startsWith('$"', index))
    {
        return { braceArity: 1, delimiter: '"', interpolated: true, kind: 'escaped', openingLength: 2 };
    }
    if (source[index] === '"' || source[index] === "'")
    {
        return { delimiter: source[index], interpolated: false, kind: 'escaped', openingLength: 1 };
    }
    return null;
}

function describeString(source, index)
{
    return describeRawString(source, index) ?? describeQuotedString(source, index);
}

function plainStringEnd(source, start, descriptor)
{
    const contentStart = start + descriptor.openingLength;
    if (descriptor.kind === 'raw')
    {
        const end = source.indexOf(descriptor.delimiter, contentStart);
        return end < 0 ? source.length : end + descriptor.delimiter.length;
    }

    let cursor = contentStart;
    while (cursor < source.length)
    {
        if (descriptor.kind === 'verbatim' && source.startsWith('""', cursor))
        {
            cursor += 2;
        }
        else if (descriptor.kind === 'escaped' && source[cursor] === '\\')
        {
            cursor += 2;
        }
        else if (source[cursor] === descriptor.delimiter)
        {
            return cursor + 1;
        }
        else
        {
            cursor += 1;
        }
    }
    return cursor;
}

function braceRunLength(source, index, brace)
{
    let cursor = index;
    while (source[cursor] === brace)
    {
        cursor += 1;
    }
    return cursor - index;
}

function stringClosingLength(source, index, descriptor)
{
    if (descriptor.kind === 'raw')
    {
        return source.startsWith(descriptor.delimiter, index) ? descriptor.delimiter.length : 0;
    }
    return source[index] === descriptor.delimiter ? 1 : 0;
}

function skipLiteralEscape(source, index, descriptor)
{
    if (descriptor.kind === 'verbatim' && source.startsWith('""', index))
    {
        return index + 2;
    }
    if (descriptor.kind === 'escaped' && source[index] === '\\')
    {
        return Math.min(source.length, index + 2);
    }
    return null;
}

function scanInterpolationExpression(source, start, braceArity, output)
{
    const closers = [];
    const expectedCloser = { '(': ')', '[': ']', '{': '}' };
    let cursor = start;
    while (cursor < source.length)
    {
        const commentStop = commentEnd(source, cursor);
        if (commentStop !== null)
        {
            maskRange(output, source, cursor, commentStop);
            cursor = commentStop;
            continue;
        }

        const descriptor = describeString(source, cursor);
        if (descriptor)
        {
            cursor = maskString(source, cursor, descriptor, output);
            continue;
        }

        const character = source[cursor];
        if (expectedCloser[character])
        {
            closers.push(expectedCloser[character]);
            cursor += 1;
            continue;
        }
        if (character === '}' && closers.length === 0
            && braceRunLength(source, cursor, '}') >= braceArity)
        {
            return cursor + braceArity;
        }
        if (character === closers.at(-1))
        {
            closers.pop();
        }
        cursor += 1;
    }
    return cursor;
}

function maskInterpolatedString(source, start, descriptor, output)
{
    const contentStart = start + descriptor.openingLength;
    maskRange(output, source, start, contentStart);
    let cursor = contentStart;
    let literalStart = contentStart;
    while (cursor < source.length)
    {
        const escapedStop = skipLiteralEscape(source, cursor, descriptor);
        if (escapedStop !== null)
        {
            cursor = escapedStop;
            continue;
        }

        const closingLength = stringClosingLength(source, cursor, descriptor);
        if (closingLength > 0)
        {
            maskRange(output, source, literalStart, cursor + closingLength);
            return cursor + closingLength;
        }

        if (source[cursor] !== '{')
        {
            cursor += 1;
            continue;
        }
        const runLength = braceRunLength(source, cursor, '{');
        if (runLength < descriptor.braceArity)
        {
            cursor += runLength;
            continue;
        }
        if (runLength === descriptor.braceArity * 2)
        {
            cursor += runLength;
            continue;
        }

        // A longer odd brace run can contain literal braces immediately before
        // the interpolation opener, for example $"{{{value}}}" and
        // $$"""{{{value}}}""". Preserve the expression after the final
        // braceArity opening braces instead of masking the complete run.
        const interpolationStart = cursor + runLength - descriptor.braceArity;
        maskRange(output, source, literalStart, interpolationStart);
        cursor = scanInterpolationExpression(source, cursor + runLength, descriptor.braceArity, output);
        literalStart = cursor;
    }
    maskRange(output, source, literalStart, cursor);
    return cursor;
}

function maskString(source, start, descriptor, output)
{
    if (descriptor.interpolated)
    {
        return maskInterpolatedString(source, start, descriptor, output);
    }
    const end = plainStringEnd(source, start, descriptor);
    maskRange(output, source, start, end);
    return end;
}

// Literal payloads are hidden, but interpolated expressions remain executable
// code and are recursively scanned for nested comments and string literals.
export function maskCSharp(source)
{
    // String indices are UTF-16 code-unit offsets. split('') keeps the output
    // indexed in the same coordinate system even when source contains astral
    // characters such as emoji.
    const output = source.split('');
    let cursor = 0;
    while (cursor < source.length)
    {
        const commentStop = commentEnd(source, cursor);
        if (commentStop !== null)
        {
            maskRange(output, source, cursor, commentStop);
            cursor = commentStop;
            continue;
        }
        const descriptor = describeString(source, cursor);
        if (descriptor)
        {
            cursor = maskString(source, cursor, descriptor, output);
            continue;
        }
        cursor += 1;
    }
    return output.join('');
}
