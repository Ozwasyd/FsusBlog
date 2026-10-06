import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { devNull } from 'node:os';
import { basename, resolve } from 'node:path';

// This is the last trusted master before retrospective post-baseline admission.
// Moving the anchor is a governance change, not a candidate-ledger operation.
export const POST_BASELINE_HISTORY_ANCHOR = 'd653afbde02b75814d8384777886b10419fb38a1';
// Freeze the compact before-snapshot cutoff for retrospective admission.
export const POST_BASELINE_BEFORE_ANCHOR = 'b144a2e54e655b6e363948cb9f6773a59cbf7be7';

const fullCommit = /^[0-9a-f]{40}$/u;
const blobOid = /^[0-9a-f]{40}$/u;
const testPath = /^tests\/(?:backend\/Unit\/[A-Za-z0-9_.-]+\.cs|[A-Za-z0-9_./-]+-baseline\.json)$/u;

function git(root, args)
{
    return spawnSync('git', args, {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        // Unsetting the override would reactivate repository-local info/grafts.
        env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: devNull }
    });
}

function gitText(root, args, label)
{
    const result = git(root, args);
    if (result.status !== 0)
    {
        throw new Error(`${label}: ${String(result.stderr || `git exited ${result.status}`).trim()}`);
    }
    return result.stdout;
}

function safePath(path)
{
    return typeof path === 'string' && testPath.test(path) && !path.split('/').includes('..');
}

function readRegularFile(root, path)
{
    const absolute = resolve(root, path);
    if (!lstatSync(absolute).isFile())
    {
        throw new Error('snapshot must be a regular file, not a symlink or directory');
    }
    return readFileSync(absolute, 'utf8');
}

function historicalRegularBlobOid(root, commit, path, label, required = false)
{
    const entry = gitText(root, ['ls-tree', '-z', commit, '--', path], label);
    if (entry.length === 0)
    {
        if (required)
        {
            throw new Error(`${label}: historical Git blob is missing`);
        }
        return null;
    }
    const match = /^(?:100644|100755) blob ([0-9a-f]{40})\t([^\0]+)\0$/u.exec(entry);
    if (!match || match[2] !== path)
    {
        throw new Error(`${label}: non-regular historical Git blob`);
    }
    return match[1];
}

function precedingAttributeNames(masked, opening, methodOffset)
{
    const names = [];
    let cursor = methodOffset;
    while (cursor > opening)
    {
        while (cursor > opening && /\s/u.test(masked[cursor - 1]))
        {
            cursor -= 1;
        }
        if (masked[cursor - 1] !== ']')
        {
            break;
        }
        const end = cursor - 1;
        let depth = 1;
        cursor -= 1;
        while (cursor > opening && depth > 0)
        {
            cursor -= 1;
            if (masked[cursor] === ']')
            {
                depth += 1;
            }
            else if (masked[cursor] === '[')
            {
                depth -= 1;
            }
        }
        if (depth !== 0)
        {
            return [];
        }
        const content = masked.slice(cursor + 1, end);
        let parentheses = 0;
        let brackets = 0;
        let start = 0;
        for (let index = 0; index <= content.length; index += 1)
        {
            const character = content[index];
            if (character === '(')
            {
                parentheses += 1;
            }
            else if (character === ')')
            {
                parentheses -= 1;
            }
            else if (character === '[')
            {
                brackets += 1;
            }
            else if (character === ']')
            {
                brackets -= 1;
            }
            if (parentheses < 0 || brackets < 0)
            {
                return [];
            }
            if (index === content.length || (character === ',' && parentheses === 0 && brackets === 0))
            {
                const attribute = /^\s*((?:global::)?[A-Za-z_][A-Za-z0-9_]*(?:\s*\.\s*[A-Za-z_][A-Za-z0-9_]*)*)\s*(?:\([\s\S]*\))?\s*$/u
                    .exec(content.slice(start, index));
                if (!attribute)
                {
                    return [];
                }
                names.push(attribute[1].replace(/\s/gu, ''));
                start = index + 1;
            }
        }
        if (parentheses !== 0 || brackets !== 0)
        {
            return [];
        }
    }
    return names;
}

function unambiguousTestAttribute(masked, name, attributeContext)
{
    const parts = name.replace(/^global::/u, '').split('.');
    const simpleName = parts.at(-1);
    if (!/^(?:Fact|Theory)(?:Attribute)?$/u.test(simpleName))
    {
        return false;
    }
    if (/\\(?:u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8})/u.test(masked + attributeContext))
    {
        return false;
    }
    // Attribute spelling cannot establish the resolved identity of an alias.
    const alias = new RegExp(`\\busing\\s+@?${parts[0]}\\s*=`, 'u');
    if (alias.test(masked) || alias.test(attributeContext))
    {
        return false;
    }
    // A type literally named Fact/Theory is not the owner's FactAttribute/TheoryAttribute identity.
    if (!simpleName.endsWith('Attribute')
        && new RegExp(`\\b(?:class|struct|record(?:\\s+(?:class|struct))?)\\s+@?${simpleName}\\b`, 'u')
            .test(masked + '\n' + attributeContext))
    {
        return false;
    }
    return true;
}

function historicalMethodPresent(source, className, methodName, maskCSharpTrivia, proveXunit, attributeContext = '', requireFact = false)
{
    if (typeof maskCSharpTrivia !== 'function')
    {
        throw new Error('C# source mask capability is required');
    }
    if (typeof source !== 'string')
    {
        return false;
    }
    const masked = maskCSharpTrivia(source);
    // Escaped identifiers are unresolved here, not evidence that a member disappeared.
    if (!proveXunit && /\\(?:u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8})/u.test(masked))
    {
        return true;
    }
    const conditionalDirectives = [...masked.matchAll(/^[ \t]*#\s*(if|endif)\b/gmu)];
    const insideConditional = (offset) =>
    {
        let depth = 0;
        for (const directive of conditionalDirectives)
        {
            if (directive.index >= offset)
            {
                break;
            }
            depth += directive[1] === 'if' ? 1 : -1;
            if (depth < 0)
            {
                return true;
            }
        }
        return depth !== 0;
    };
    const depths = new Uint32Array(masked.length + 1);
    let depth = 0;
    for (let index = 0; index < masked.length; index += 1)
    {
        if (masked[index] === '{')
        {
            depth += 1;
        }
        else if (masked[index] === '}')
        {
            depth = Math.max(0, depth - 1);
        }
        depths[index + 1] = depth;
    }
    const classDeclaration = proveXunit
        ? /^[ \t]*(?:(?:public|internal|private|protected|abstract|sealed|static|partial)\s+)*class\s+([A-Za-z_][A-Za-z0-9_]*)\b/gmu
        : /\b(?:class|struct|record(?:\s+class|\s+struct)?)\s+@?([A-Za-z_][A-Za-z0-9_]*)\b/gu;
    const declaration = proveXunit ? new RegExp(
        `^[ \\t]*public[ \\t]+(?:async[ \\t]+)?(?:void|Task(?:<[^>\\n]+>)?|ValueTask(?:<[^>\\n]+>)?)[ \\t]+${methodName}[ \\t]*\\(`,
        'gmu'
    ) : new RegExp(`\\b${methodName}\\s*(?:<[^;{}()]*>)?\\s*\\(`, 'gu');
    const classMatches = [...masked.matchAll(classDeclaration)];
    if (requireFact && [...masked.matchAll(new RegExp(`\\b(?:class|struct|record(?:\\s+(?:class|struct))?)\\s+@?${className}\\b`, 'gu'))].length !== 1)
    {
        return false;
    }
    for (const classMatch of classMatches)
    {
        if (classMatch[1] !== className)
        {
            continue;
        }
        // Mutually exclusive branches can change brace ownership; no symbols are evaluated here.
        if (!proveXunit && conditionalDirectives.length > 0 && declaration.test(masked))
        {
            return true;
        }
        const opening = masked.indexOf('{', classMatch.index + classMatch[0].length);
        if (opening < 0)
        {
            if (!proveXunit)
            {
                return true;
            }
            continue;
        }
        if (proveXunit && (insideConditional(classMatch.index) || insideConditional(opening)))
        {
            continue;
        }
        if (requireFact && (depths[classMatch.index] !== 0
            || !/^\s*\{/u.test(masked.slice(classMatch.index + classMatch[0].length))))
        {
            continue;
        }
        const bodyDepth = depths[opening + 1];
        let closing = opening + 1;
        while (closing < masked.length && !(masked[closing] === '}' && depths[closing] === bodyDepth))
        {
            closing += 1;
        }
        if (closing === masked.length)
        {
            if (!proveXunit)
            {
                return true;
            }
            continue;
        }
        if (proveXunit && insideConditional(closing))
        {
            continue;
        }
        const body = masked.slice(opening + 1, closing);
        const methodMatches = [...body.matchAll(declaration)];
        if (requireFact && [...body.matchAll(new RegExp(`\\b${methodName}\\s*(?:<[^;{}()]*>)?\\s*\\(`, 'gu'))]
            .filter((match) => depths[opening + 1 + match.index] === bodyDepth).length !== 1)
        {
            return false;
        }
        for (const methodMatch of methodMatches)
        {
            const methodOffset = opening + 1 + methodMatch.index;
            if (depths[methodOffset] !== bodyDepth)
            {
                continue;
            }
            if (requireFact && !/^\s*\)\s*(?:\{|=>)/u.test(masked.slice(methodOffset + methodMatch[0].length)))
            {
                continue;
            }
            // Without the historical compilation symbols, an attributed method in a
            // conditional region cannot be proven to have been an executable test.
            if (proveXunit && insideConditional(methodOffset))
            {
                continue;
            }
            const attributes = proveXunit ? precedingAttributeNames(masked, opening, methodOffset) : [];
            const testAttributes = attributes.filter((name) => /^(?:Fact|Theory)(?:Attribute)?$/u.test(name.split('.').at(-1)));
            if (requireFact && (testAttributes.length !== 1
                || !/^(?:Fact|FactAttribute)$/u.test(testAttributes[0].split('.').at(-1))))
            {
                continue;
            }
            if (!proveXunit || attributes.some((name) => unambiguousTestAttribute(masked, name, attributeContext)))
            {
                return true;
            }
        }
    }
    return false;
}

export function historicalXunitMethodPresent(source, className, methodName, maskCSharpTrivia, { attributeContext = '' } = {})
{
    return historicalMethodPresent(source, className, methodName, maskCSharpTrivia, true, attributeContext);
}

// Deletion needs evidence of absence; unfamiliar attributes or conditional code cannot supply it.
export function historicalMethodMayBePresent(source, className, methodName, maskCSharpTrivia)
{
    return historicalMethodPresent(source, className, methodName, maskCSharpTrivia, false);
}

function historicalAttributeContext(root, commit, maskCSharpTrivia)
{
    const result = git(root, ['grep', '--no-textconv', '-l', '-z', '-E',
        '-e', '(^|[^[:alnum:]_])(global|Fact|Theory)([^[:alnum:]_]|$)', '-e', '\\\\(u[[:xdigit:]]{4}|U[[:xdigit:]]{8})',
        commit, '--', 'tests/backend']);
    if (result.status === 1)
    {
        return '';
    }
    if (result.status !== 0)
    {
        throw new Error(`historical attribute context unavailable: ${String(result.stderr).trim()}`);
    }
    const context = [];
    for (const entry of result.stdout.split('\0').filter(Boolean))
    {
        const prefix = `${commit}:`;
        if (!entry.startsWith(prefix))
        {
            throw new Error('historical attribute context path is unbound');
        }
        const path = entry.slice(prefix.length);
        if (!path.endsWith('.cs'))
        {
            continue;
        }
        historicalRegularBlobOid(root, commit, path, 'historical attribute context source', true);
        const source = gitText(root, ['show', `${commit}:${path}`], 'historical attribute context source');
        const masked = maskCSharpTrivia(source);
        context.push(...[...masked.matchAll(/\bglobal\s+using\s+[^;]+;/gu)]
            .filter((match) => match[0].includes('=')).map((match) => match[0]));
        // Namespace/compilation lookup is not reconstructed here. Any immutable
        // backend declaration of these suffix-less names makes short attribution
        // ambiguous, even when the declaration is in another source file.
        context.push(...[...masked.matchAll(/\b(?:class|struct|record(?:\s+(?:class|struct))?)\s+@?(?:Fact|Theory)\b/gu)]
            .map((match) => match[0]));
        context.push(...[...masked.matchAll(/\\(?:u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8})/gu)]
            .map((match) => match[0]));
    }
    return context.join('\n');
}

// This is an exact-history assertion against an existing canonical ID, not an
// inventory producer. Only the unambiguous file-scoped, top-level, no-argument
// Fact shape can bridge the archived method ID to Roslyn's static case identity.
export function canonicalFactMatchesHistoricalOwner({ source, id, historicalId, path, maskCSharpTrivia, attributeContext = '' })
{
    const historical = /^xunit:(tests\/backend\/Unit\/[A-Za-z0-9_.-]+\.cs)#([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)$/u.exec(String(historicalId ?? ''));
    if (!historical || historical[1] !== path || typeof source !== 'string' || typeof maskCSharpTrivia !== 'function')
    {
        return false;
    }
    const masked = maskCSharpTrivia(source);
    if (/^[ \t]*#\s*(?:if|elif|else|endif)\b/mu.test(masked))
    {
        return false;
    }
    const namespaces = [...masked.matchAll(/\bnamespace\s+([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\s*([;{])/gu)];
    if (namespaces.length !== 1 || namespaces[0][2] !== ';')
    {
        return false;
    }
    const prefix = masked.slice(0, namespaces[0].index);
    let depth = 0;
    for (let index = 0; index < masked.length; index += 1)
    {
        if (index === namespaces[0].index && depth !== 0)
        {
            return false;
        }
        depth += masked[index] === '{' ? 1 : masked[index] === '}' ? -1 : 0;
        if (depth < 0)
        {
            return false;
        }
    }
    if (depth !== 0 || /\b(?:class|struct|record|interface|enum)\b/u.test(prefix))
    {
        return false;
    }
    const [, , className, methodName] = historical;
    const expected = `xunit:${path}#${namespaces[0][1]}.${className}.${methodName}#case-0000`;
    return id === expected && historicalMethodPresent(
        source, className, methodName, maskCSharpTrivia, true, attributeContext, true
    );
}

function validateV2Record({ root, record, baseline, anchorCommit, maskCSharpTrivia, readAttributeContext })
{
    const errors = [];
    const match = /^xunit:(tests\/backend\/Unit\/[A-Za-z0-9_.-]+\.cs)#([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)$/u.exec(String(record?.historicalId ?? record?.id ?? ''));
    if (!match || !safePath(record?.path) || match[1] !== record.path || basename(record.path) !== `${match[2]}.cs`)
    {
        return [`${record?.id ?? '<missing id>'}: v2 history requires an exact legacy xUnit method and owner path`];
    }
    const [, path, className, methodName] = match;
    let source;
    let sourceOid;
    let result;
    let resultOid;
    let anchor;
    let attributeContext;
    try
    {
        sourceOid = historicalRegularBlobOid(root, baseline.sourceCommit, path, `${record.id} source`, true);
        source = gitText(root, ['show', `${baseline.sourceCommit}:${path}`], `${record.id} source`);
        attributeContext = readAttributeContext(baseline.sourceCommit);
        resultOid = historicalRegularBlobOid(root, baseline.deletionCommit, path, `${record.id} deletion result`);
        if (resultOid)
        {
            result = gitText(root, ['show', `${baseline.deletionCommit}:${path}`], `${record.id} deletion result`);
        }
        const anchorListedOid = gitText(root, ['ls-tree', '--object-only', anchorCommit, '--', path], `${record.id} trusted anchor tree`).trim();
        if (anchorListedOid)
        {
            anchor = gitText(root, ['show', `${anchorCommit}:${path}`], `${record.id} trusted anchor`);
        }
    }
    catch (error)
    {
        return [`${record.id}: ${error.message}`];
    }
    if (record.historicalId !== undefined && !canonicalFactMatchesHistoricalOwner({
        source, id: record.id, historicalId: record.historicalId, path, maskCSharpTrivia, attributeContext
    }))
    {
        errors.push(`${record.id}: canonical retired identity does not match the exact historical Fact owner`);
    }
    if (!blobOid.test(String(record.sourceBlobOid ?? '')) || record.sourceBlobOid !== sourceOid)
    {
        errors.push(`${record.id}: source blob binding differs from Git history`);
    }
    if (record.resultBlobOid !== resultOid)
    {
        errors.push(`${record.id}: deletion-result blob binding differs from Git history`);
    }
    if (!historicalXunitMethodPresent(source, className, methodName, maskCSharpTrivia, { attributeContext }))
    {
        errors.push(`${record.id}: old attributed method is absent from source commit`);
    }
    if (historicalMethodMayBePresent(result, className, methodName, maskCSharpTrivia))
    {
        errors.push(`${record.id}: old attributed method survives deletion commit`);
    }
    if (historicalMethodMayBePresent(anchor, className, methodName, maskCSharpTrivia))
    {
        errors.push(`${record.id}: old attributed method survives trusted master anchor`);
    }
    if (sourceOid === resultOid)
    {
        errors.push(`${record.id}: source and deletion-result blobs are identical`);
    }
    return errors;
}

export function validatePostBaselineHistory({
    root,
    paths,
    replacements,
    parseMatrix,
    maskCSharpTrivia,
    anchorCommit = POST_BASELINE_HISTORY_ANCHOR,
    beforeCommit = POST_BASELINE_BEFORE_ANCHOR,
    readCurrent = (path) => readRegularFile(root, path)
})
{
    const errors = [];
    const ids = [];
    const sources = [];
    const replacementById = new Map(replacements.map((entry) => [entry.id, entry]));
    const observedIds = new Set();
    if (typeof parseMatrix !== 'function' || typeof maskCSharpTrivia !== 'function')
    {
        return { ids, sources, errors: ['post-baseline history capabilities are missing'] };
    }
    if (!Array.isArray(paths))
    {
        return { ids, sources, errors: ['post-baseline paths must be an array'] };
    }
    if (!fullCommit.test(anchorCommit) || !fullCommit.test(beforeCommit))
    {
        return { ids, sources, errors: ['post-baseline history anchors must be full commits'] };
    }

    let legacyPaths;
    try
    {
        const anchorMatrix = parseMatrix(gitText(root, ['show', `${anchorCommit}:tests/matrix.yml`], 'trusted matrix'));
        legacyPaths = new Set(anchorMatrix.governance?.retention?.postBaselines ?? []);
    }
    catch (error)
    {
        return { ids, sources, errors: [`trusted post-baseline matrix unavailable: ${error.message}`] };
    }
    const currentPaths = new Set(paths);
    // This invocation is bound to one repository and immutable commit objects.
    // Read each source context once, never reuse ambient or cross-invocation state.
    const attributeContexts = new Map();
    const readAttributeContext = (commit) =>
    {
        if (!attributeContexts.has(commit))
        {
            attributeContexts.set(commit, historicalAttributeContext(root, commit, maskCSharpTrivia));
        }
        return attributeContexts.get(commit);
    };
    if (currentPaths.size !== paths.length)
    {
        errors.push('post-baseline paths contain duplicates');
    }
    for (const legacyPath of legacyPaths)
    {
        if (!currentPaths.has(legacyPath))
        {
            errors.push(`trusted post-baseline path removed: ${legacyPath}`);
        }
    }
    for (const path of paths)
    {
        if (!safePath(path) || !path.endsWith('-baseline.json'))
        {
            errors.push(`unsafe post-baseline path: ${path}`);
            continue;
        }
        let source;
        let baseline;
        try
        {
            source = readCurrent(path);
            baseline = JSON.parse(source);
        }
        catch (error)
        {
            errors.push(`${path}: cannot read post-baseline snapshot: ${error.message}`);
            continue;
        }
        if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline))
        {
            errors.push(`${path}: post-baseline snapshot must be an object`);
            continue;
        }
        const legacy = legacyPaths.has(path);
        if (legacy)
        {
            try
            {
                const trusted = gitText(root, ['show', `${anchorCommit}:${path}`], `${path} trusted blob`);
                if (source !== trusted)
                {
                    errors.push(`${path}: trusted v1 post-baseline bytes changed`);
                }
            }
            catch (error)
            {
                errors.push(`${path}: ${error.message}`);
            }
        }
        else if (baseline.schema !== 'fsusblog.issue-acceptance-baseline.v2')
        {
            errors.push(`${path}: new post-baseline snapshot requires exact-history v2 schema`);
            continue;
        }
        if (legacy && baseline.schema !== 'fsusblog.issue-acceptance-baseline.v1')
        {
            errors.push(`${path}: trusted v1 post-baseline schema changed`);
        }
        if (!legacy)
        {
            const sourceCommit = baseline.sourceCommit;
            const deletionCommit = baseline.deletionCommit;
            if (!fullCommit.test(String(sourceCommit ?? '')) || !fullCommit.test(String(deletionCommit ?? '')))
            {
                errors.push(`${path}: source and deletion commits must be full Git object IDs`);
                continue;
            }
            try
            {
                const parents = gitText(root, ['rev-list', '--parents', '-n', '1', deletionCommit], `${path} deletion ancestry`).trim().split(' ');
                if (parents.length !== 2 || parents[0] !== deletionCommit || parents[1] !== sourceCommit)
                {
                    errors.push(`${path}: deletion commit must have source commit as its sole immediate parent`);
                }
                const ancestor = git(root, ['merge-base', '--is-ancestor', deletionCommit, anchorCommit]);
                if (ancestor.status !== 0)
                {
                    errors.push(`${path}: deletion commit is not in trusted master history`);
                }
                const afterBefore = git(root, ['merge-base', '--is-ancestor', beforeCommit, sourceCommit]);
                if (afterBefore.status !== 0)
                {
                    errors.push(`${path}: source commit predates trusted before snapshot`);
                }
            }
            catch (error)
            {
                errors.push(`${path}: ${error.message}`);
                continue;
            }
        }
        if (!Array.isArray(baseline.records) || baseline.records.length === 0)
        {
            errors.push(`${path}: post-baseline records are empty`);
            continue;
        }
        if (!legacy && (baseline.expectedRecords !== baseline.records.length
      || baseline.expectedMigrated !== baseline.records.length))
        {
            errors.push(`${path}: v2 expected counts must equal the exact migrated record count`);
        }
        let accepted = 0;
        for (const record of baseline.records)
        {
            if (record?.disposition !== 'migrated')
            {
                if (!legacy)
                {
                    errors.push(`${path}: v2 record is not migrated: ${record?.id ?? '<missing id>'}`);
                }
                continue;
            }
            const replacement = replacementById.get(record?.id);
            if (!replacement || replacement.path !== record?.path)
            {
                errors.push(`${path}: migrated record lacks an exact central replacement: ${record?.id ?? '<missing id>'}`);
                continue;
            }
            if (observedIds.has(record.id))
            {
                errors.push(`${path}: duplicate post-baseline migrated ID: ${record.id}`);
            }
            observedIds.add(record.id);
            if (!legacy)
            {
                errors.push(...validateV2Record({ root, record, baseline, anchorCommit, maskCSharpTrivia, readAttributeContext }));
            }
            ids.push(record.id);
            accepted += 1;
        }
        if (Number.isInteger(baseline.expectedMigrated) && accepted !== baseline.expectedMigrated)
        {
            errors.push(`${path}: expected ${baseline.expectedMigrated} migrated records, found ${accepted}`);
        }
        sources.push({ source: path, issue: baseline.issue, accepted });
    }
    return { ids: [...new Set(ids)], sources, errors };
}
