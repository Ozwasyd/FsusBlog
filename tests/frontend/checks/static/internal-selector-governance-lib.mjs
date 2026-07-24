// Shared parser/validator for the CLI and its mutation tests.
const REGISTRY_SCHEMA = 'fsusblog.internal-selector-registry.v1';
const PUBLIC_SHELL_INTERNAL_PATTERN = /\.el-(?:public-shell|theme-mode-toggle)(?:__|--|$)/u;

function lineAt(source, offset)
{
    return source.slice(0, offset).split('\n').length;
}

function styleRanges(path, source)
{
    if (!path.endsWith('.vue'))
    {
        return [{ source, offset: 0 }];
    }

    return Array.from(source.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gu), (match) => ({
        source: match[1],
        offset: (match.index ?? 0) + match[0].indexOf(match[1])
    }));
}

function deepFindings(path, wholeSource, styleSource, styleOffset)
{
    const findings = [];
    const ranges = [];
    let cursor = 0;

    while (cursor < styleSource.length)
    {
        const match = /:deep\s*\(/gu.exec(styleSource.slice(cursor));
        if (!match)
        {
            break;
        }
        const start = cursor + (match.index ?? 0);

        const selectorStart = start + match[0].length;
        let depth = 1;
        let end = selectorStart;
        for (; end < styleSource.length && depth > 0; end += 1)
        {
            if (styleSource[end] === '(')
            {
                depth += 1;
            }
            if (styleSource[end] === ')')
            {
                depth -= 1;
            }
        }
        if (depth !== 0)
        {
            cursor = selectorStart;
            continue;
        }

        const selectorEnd = end - 1;
        const absoluteStart = styleOffset + start;
        findings.push({
            path,
            kind: 'deep',
            selector: styleSource.slice(selectorStart, selectorEnd).trim(),
            line: lineAt(wholeSource, absoluteStart)
        });
        ranges.push([start, end]);
        cursor = end;
    }

    return { findings, ranges };
}

function insideRanges(offset, ranges)
{
    return ranges.some(([start, end]) => offset >= start && offset < end);
}

export function scanInternalSelectors(files)
{
    const findings = [];

    for (const file of files)
    {
        for (const style of styleRanges(file.path, file.source))
        {
            const uncommented = style.source.replace(/\/\*[\s\S]*?\*\//gu, (comment) => (
                comment.replace(/[^\n]/gu, ' ')
            ));
            const deep = deepFindings(file.path, file.source, uncommented, style.offset);
            findings.push(...deep.findings);

            for (const match of uncommented.matchAll(/\.el-[a-z0-9_-]+/giu))
            {
                const localOffset = match.index ?? 0;
                if (insideRanges(localOffset, deep.ranges))
                {
                    continue;
                }
                findings.push({
                    path: file.path,
                    kind: 'direct-el',
                    selector: match[0],
                    line: lineAt(file.source, style.offset + localOffset)
                });
            }
        }
    }

    return findings;
}

function entryKey(entry)
{
    return `${entry.kind}\0${entry.path}\0${entry.selector}`;
}

function findingCounts(findings)
{
    const counts = new Map();
    for (const finding of findings)
    {
        const key = entryKey(finding);
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
}

export function expandInternalSelectorRegistryEntries(registry)
{
    const entries = Array.isArray(registry?.entries) ? registry.entries : [];
    return entries.flatMap((entry) =>
    {
        if (!Array.isArray(entry.selectors))
        {
            return [entry];
        }
        return entry.selectors.map((selector) => ({
            path: entry.path,
            owner: entry.owner,
            reason: entry.reason,
            expiresOn: entry.expiresOn,
            replacementIssue: entry.replacementIssue,
            ...selector
        }));
    });
}

export function validateInternalSelectorRegistry({ findings, registry, today })
{
    const errors = [];
    if (registry?.schema !== REGISTRY_SCHEMA)
    {
        return [`registry schema must be ${REGISTRY_SCHEMA}`];
    }

    const entries = expandInternalSelectorRegistryEntries(registry);
    const registered = new Map();
    for (const entry of entries)
    {
        const label = `${entry.path} :: ${entry.selector}`;
        const key = entryKey(entry);
        if (registered.has(key))
        {
            errors.push(`duplicate registry entry: ${label}`);
            continue;
        }
        registered.set(key, entry);

        if (!String(entry.owner ?? '').trim())
        {
            errors.push(`registry entry requires owner: ${label}`);
        }
        if (!String(entry.reason ?? '').trim())
        {
            errors.push(`registry entry requires reason: ${label}`);
        }
        if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(entry.expiresOn ?? '')))
        {
            errors.push(`registry entry requires ISO expiresOn: ${label}`);
        }
        else if (entry.expiresOn < today)
        {
            errors.push(`registry entry expired on ${entry.expiresOn}: ${label}`);
        }
        if (!String(entry.replacementIssue ?? '').trim())
        {
            errors.push(`registry entry requires replacementIssue: ${label}`);
        }
        if (!Number.isInteger(entry.occurrences) || entry.occurrences < 1)
        {
            errors.push(`registry entry requires positive occurrences: ${label}`);
        }
    }

    const discovered = findingCounts(findings);
    for (const finding of findings)
    {
        if (PUBLIC_SHELL_INTERNAL_PATTERN.test(finding.selector))
        {
            errors.push(`PublicShell internal selector is forbidden: ${finding.path} :: ${finding.selector}`);
        }
    }

    for (const [key, count] of discovered)
    {
        const [kind, path, selector] = key.split('\0');
        const entry = registered.get(key);
        if (!entry)
        {
            errors.push(`unregistered ${kind === 'deep' ? 'deep selector' : 'direct Element Plus selector'}: ${path} :: ${selector}`);
            continue;
        }
        if (entry.occurrences !== count)
        {
            errors.push(`registry occurrence mismatch: ${path} :: ${selector}; registered ${entry.occurrences}, discovered ${count}`);
        }
    }

    for (const [key, entry] of registered)
    {
        if (!discovered.has(key))
        {
            errors.push(`stale registry entry: ${entry.path} :: ${entry.selector}`);
        }
    }

    const deepCount = findings.filter((finding) => finding.kind === 'deep').length;
    if (!Number.isInteger(registry.maximumDeepOccurrences) || registry.maximumDeepOccurrences < 0)
    {
        errors.push('registry maximumDeepOccurrences must be a non-negative integer');
    }
    else if (deepCount !== registry.maximumDeepOccurrences)
    {
        errors.push(`deep selector budget mismatch: registered ${registry.maximumDeepOccurrences}, discovered ${deepCount}`);
    }

    if (registry.maximumDirectElOccurrences !== undefined)
    {
        const directCount = findings.filter((finding) => finding.kind === 'direct-el').length;
        if (!Number.isInteger(registry.maximumDirectElOccurrences) || registry.maximumDirectElOccurrences < 0)
        {
            errors.push('registry maximumDirectElOccurrences must be a non-negative integer');
        }
        else if (directCount !== registry.maximumDirectElOccurrences)
        {
            errors.push(`direct Element Plus selector budget mismatch: registered ${registry.maximumDirectElOccurrences}, discovered ${directCount}`);
        }
    }

    return Array.from(new Set(errors));
}

export function validateInternalSelectorMigrationEvidence({ evidence, registry })
{
    const errors = [];
    if (evidence?.schema !== 'fsusblog.internal-selector-migration-evidence.v1')
    {
        return ['migration evidence schema must be fsusblog.internal-selector-migration-evidence.v1'];
    }

    const migrations = Array.isArray(evidence.migrations) ? evidence.migrations : [];
    const removedDeepOccurrences = migrations.reduce(
        (total, migration) => total + Number(migration.removedDeepOccurrences ?? 0),
        0
    );
    const expectedCurrentDeep = Number(evidence.baseline?.deepOccurrences) - removedDeepOccurrences;

    if (expectedCurrentDeep !== evidence.current?.deepOccurrences)
    {
        errors.push(
            `migration evidence deep total mismatch: baseline ${evidence.baseline?.deepOccurrences}, removed ${removedDeepOccurrences}, current ${evidence.current?.deepOccurrences}`
        );
    }
    if (evidence.current?.deepOccurrences !== registry?.maximumDeepOccurrences)
    {
        errors.push(
            `migration evidence current deep count ${evidence.current?.deepOccurrences} does not match registry ${registry?.maximumDeepOccurrences}`
        );
    }
    if (evidence.current?.directElementPlusOccurrences !== registry?.maximumDirectElOccurrences)
    {
        errors.push(
            `migration evidence direct Element Plus count ${evidence.current?.directElementPlusOccurrences} does not match registry ${registry?.maximumDirectElOccurrences}`
        );
    }
    if (evidence.baseline?.publicShellInternalOccurrences !== 0
        || evidence.current?.publicShellInternalOccurrences !== 0)
    {
        errors.push('migration evidence must keep PublicShell internal selectors at zero');
    }
    for (const migration of migrations.filter(({ owner }) => owner === 'FsusUI'))
    {
        const commits = [
            migration.fsusUiCommit,
            ...(Array.isArray(migration.fsusUiCommits) ? migration.fsusUiCommits : [])
        ].filter(Boolean);
        if (!/^Ozwasyd\/FsusUI#\d+$/u.test(String(migration.fsusUiIssue ?? '')))
        {
            errors.push(`FsusUI migration requires a linked FsusUI issue: ${migration.surface}`);
        }
        if (commits.length === 0 || commits.some((commit) => !/^[0-9a-f]{40}$/u.test(String(commit))))
        {
            errors.push(`FsusUI migration requires full commit identities: ${migration.surface}`);
        }
    }

    return errors;
}
