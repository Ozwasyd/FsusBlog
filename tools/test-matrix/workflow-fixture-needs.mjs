// Negative workflow fixtures retain every existing dependency before injecting
// the forbidden edge. These mutations never change the production validator.
export function appendWorkflowNeedToJob(source, { fieldIndent, jobIndent }, need)
{
    const lines = source.split('\n');
    const pattern = new RegExp(`^\\s{${fieldIndent}}needs:\\s*(.*)$`, 'u');
    const index = lines.findIndex((line) => pattern.test(line));
    if (index < 0)
    {
        throw new Error('workflow fixture job is missing needs');
    }
    const value = lines[index].match(pattern)[1].trim();
    if (!value)
    {
        const childIndent = fieldIndent + (fieldIndent - jobIndent);
        lines.splice(index + 1, 0, `${' '.repeat(childIndent)}- ${need}`);
    }
    else if (/^\[[^\]]*\]$/u.test(value))
    {
        const existing = value.slice(1, -1).trim();
        lines[index] = `${' '.repeat(fieldIndent)}needs: [${existing}${existing ? ', ' : ''}${need}]`;
    }
    else
    {
        throw new Error('workflow fixture needs must use a block or flow sequence');
    }
    return lines.join('\n');
}
