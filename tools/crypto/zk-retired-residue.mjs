import { readFileSync } from 'node:fs';
import path from 'node:path';

const retiredCircuits = [
    ['fsus.anonymous.comment.', 'v', '2'].join(''),
    ['fsus.anonymous.comment.', 'v', '3'].join(''),
    ['fsus.anonymous.comment.', 'v', '4'].join('')
];
const retiredSymbols = [
    ['ZkComment', 'V2'].join(''),
    ['ZkComment', 'V3', 'Compat'].join(''),
    ['ZkComment', 'V4', 'Compat'].join(''),
    ['Circuit', 'Native'].join(''),
    ['AnonymousCredentialIssue', 'Request'].join(''),
    ['AnonymousCredentialIssue', 'Response'].join('')
];
const retiredPathPatterns = [
    new RegExp(['comment', '[-_]', 'v', '[234]'].join(''), 'iu')
];
const retiredLayoutPatterns = [
    new RegExp(['public[_A-Za-z]*layout[_A-Za-z]*version', '[^0-9]{0,12}', '[345]', '\\b'].join(''), 'iu'),
    new RegExp(['["\'`]?layout["\'`]?', '\\s*[:=]\\s*', '[45]', '\\b'].join(''), 'iu')
];
const cryptoArtifactPath = new RegExp(
    ['[.]', '(?:fsg16pk|fsg16vk|pk|vk|proof|public[_-]?inputs|r1cs|zkey)', '(?:[.](?:bin|dat|json))?', '$'].join(''),
    'iu');
const binaryMagics = [Buffer.from(['FSG16', 'VK1'].join('')), Buffer.from(['FSG16', 'PF1'].join(''))];
const base64Token = /(?:[A-Za-z0-9+/]{4}){4,}(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?/gu;

export function findTrackedZkResidue({
    root,
    trackedFiles,
    readTrackedFile = (file) => readFileSync(path.join(root, file))
})
{
    const errors = [];
    for (const file of trackedFiles.map(repoPath))
    {
        if (cryptoArtifactPath.test(file))
        {
            errors.push(`cryptographic artifact must not be tracked in ordinary Git: ${file}`);
        }
        if (retiredPathPatterns.some((pattern) => pattern.test(file)))
        {
            errors.push(`retired proving-system path must not be tracked: ${file}`);
        }

        let content;
        try
        {
            content = Buffer.from(readTrackedFile(file));
        }
        catch (error)
        {
            errors.push(`tracked file could not be inspected fail-closed: ${file}: ${error instanceof Error ? error.message : String(error)}`);
            continue;
        }

        const binary = content.includes(0);
        if (binary && binaryMagics.some((magic) => content.includes(magic)))
        {
            errors.push(`encoded proving artifact must not be tracked in ordinary Git: ${file}`);
        }
        if (decodedViews(content).some(hasRetiredText))
        {
            errors.push(`retired proving-system identity must not remain in tracked content: ${file}`);
        }
    }
    return errors;
}

function decodedViews(content)
{
    const buffers = [content];
    const utf8 = content.toString('utf8');
    for (const token of utf8.match(base64Token) ?? [])
    {
        try
        {
            const decoded = Buffer.from(token, 'base64');
            if (decoded.length >= 8)
            {
                buffers.push(decoded);
            }
        }
        catch
        {
            // Invalid base64-looking text remains covered by the original decoded views.
        }
    }

    const views = [];
    for (const buffer of buffers)
    {
        views.push(buffer.toString('utf8'), buffer.toString('latin1'), buffer.toString('utf16le'));
        if (buffer.length >= 2)
        {
            const swapped = Buffer.from(buffer.subarray(0, buffer.length - (buffer.length % 2)));
            swapped.swap16();
            views.push(swapped.toString('utf16le'));
        }
    }
    return views;
}

function hasRetiredText(text)
{
    return retiredCircuits.some((circuit) => text.includes(circuit)) ||
    retiredSymbols.some((symbol) => text.includes(symbol)) ||
    retiredPathPatterns.some((pattern) => pattern.test(text)) ||
    retiredLayoutPatterns.some((pattern) => pattern.test(text));
}

function repoPath(value)
{
    return String(value ?? '').replaceAll('\\', '/').replace(/^\.\//u, '');
}
