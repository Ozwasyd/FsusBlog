import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const DocumentLifecycleSchema = 'fsusblog.document-lifecycle-policy.v2';
export const DocumentInventorySchema = 'fsusblog.document-inventory.v2';

function CompareOrdinal(left, right)
{
    return left === right ? 0 : left < right ? -1 : 1;
}

function ToPosix(value)
{
    return value.split(path.sep).join('/');
}

function Sha256(value)
{
    return crypto.createHash('sha256').update(value).digest('hex');
}

function WalkFiles(root, relativeRoot)
{
    const directory = path.join(root, relativeRoot);
    const files = [];
    const Visit = (absolute) =>
    {
        for (const entry of fs.readdirSync(absolute, { withFileTypes: true }).sort((left, right) => CompareOrdinal(left.name, right.name)))
        {
            const child = path.join(absolute, entry.name);
            if (entry.isDirectory())
            {
                Visit(child);
            }
            else if (entry.isFile())
            {
                files.push(ToPosix(path.relative(root, child)));
            }
        }
    };
    Visit(directory);
    return files.sort(CompareOrdinal);
}

function DocumentTitle(root, file)
{
    if (path.extname(file).toLowerCase() === '.md')
    {
        const text = fs.readFileSync(path.join(root, file), 'utf8');
        const heading = text.match(/^#\s+(.+)$/mu)?.[1]?.trim();
        if (heading)
        {
            return heading.replace(/\s+#+$/u, '').trim();
        }
    }
    return path.basename(file, path.extname(file))
        .split(/[-_]/u)
        .filter(Boolean)
        .map((part) => part[0]?.toUpperCase() + part.slice(1))
        .join(' ');
}

function DocumentKind(file)
{
    const extension = path.extname(file).toLowerCase();
    if (extension === '.md')
    {
        return 'markdown';
    }
    if (extension === '.json')
    {
        return 'json';
    }
    if (extension === '.yaml' || extension === '.yml')
    {
        return 'yaml';
    }
    return 'asset';
}

export function ReadDocumentLifecyclePolicy(root, relative = 'config/development/document-lifecycle.json')
{
    return JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
}

export function BuildDocumentInventory(root, policy)
{
    const metadataByPath = new Map((policy.documents ?? []).map((entry) => [entry.path, entry]));
    const documents = WalkFiles(root, 'docs').map((file) =>
    {
        const kind = DocumentKind(file);
        const metadata = metadataByPath.get(file) ?? {};
        const status = metadata.status ?? 'unclassified';
        const owner = metadata.owner ?? 'unclassified';
        const sourceOfTruth = status === 'current' && kind !== 'asset';
        return {
            path: file,
            title: DocumentTitle(root, file),
            kind,
            status,
            owner,
            sourceOfTruth,
            lastVerifiedCommit: policy.lastVerifiedCommit,
            supersedes: metadata.supersedes ?? [],
            supersededBy: metadata.supersededBy ?? null,
            relatedIssues: metadata.relatedIssues ?? [],
            producer: metadata.producer ?? null
        };
    });
    const content = {
        schema: DocumentInventorySchema,
        policy: 'config/development/document-lifecycle.json',
        policyDigest: `sha256:${Sha256(JSON.stringify(policy))}`,
        documents
    };
    return content;
}

function RelativeIndexTarget(file)
{
    return file.replace(/^docs\//u, '');
}

export function RenderDocumentIndex(inventory)
{
    const lines = [
        '# Documentation Index',
        '',
        '本索引由 `config/development/document-lifecycle.json` 中的显式 metadata 和当前 `docs/` inventory 生成。长期事实源只出现在 Current 区域；工单关联和替代关系不再从文件名推导。',
        '',
        '- Lifecycle policy: [`development/document-lifecycle.md`](development/document-lifecycle.md)',
        '- Machine-readable inventory: [`../config/development/document-inventory.generated.json`](../config/development/document-inventory.generated.json)',
        '- Path migrations are repository records, not GitHub blob URL redirects.',
        ''
    ];
    const owners = ['backend', 'frontend', 'security', 'release', 'governance'];
    const current = inventory.documents.filter((entry) => entry.status === 'current' && entry.sourceOfTruth && entry.path !== 'docs/index.md');
    lines.push('## Current sources of truth', '');
    for (const owner of owners)
    {
        const documents = current.filter((entry) => entry.owner === owner).sort((left, right) => CompareOrdinal(left.path, right.path));
        if (documents.length === 0)
        {
            continue;
        }
        lines.push(`### ${owner[0].toUpperCase()}${owner.slice(1)}`, '');
        for (const document of documents)
        {
            lines.push(`- [${document.title}](${RelativeIndexTarget(document.path)})`);
        }
        lines.push('');
    }
    for (const status of ['proposed', 'historical', 'generated', 'retired'])
    {
        const documents = inventory.documents.filter((entry) => entry.status === status).sort((left, right) => CompareOrdinal(left.path, right.path));
        lines.push(`## ${status[0].toUpperCase()}${status.slice(1)}`, '');
        if (documents.length === 0)
        {
            lines.push('- None.', '');
            continue;
        }
        if (status === 'historical')
        {
            const groups = new Map();
            for (const document of documents)
            {
                const relative = RelativeIndexTarget(document.path);
                const parts = relative.split('/');
                const group = parts.length === 1 ? 'root migration records' : parts.slice(0, document.kind === 'asset' ? 2 : 1).join('/');
                const current = groups.get(group) ?? { documents: 0, assets: 0 };
                current[document.kind === 'asset' ? 'assets' : 'documents'] += 1;
                groups.set(group, current);
            }
            for (const [group, counts] of [...groups].sort(([left], [right]) => CompareOrdinal(left, right)))
            {
                const summary = [
                    counts.documents > 0 ? `${counts.documents} document${counts.documents === 1 ? '' : 's'}` : null,
                    counts.assets > 0 ? `${counts.assets} asset${counts.assets === 1 ? '' : 's'}` : null
                ].filter(Boolean).join(', ');
                lines.push(`- \`${group}\`: ${summary}`);
            }
        }
        else
        {
            for (const document of documents)
            {
                const issues = document.relatedIssues.length > 0 ? `; issues ${document.relatedIssues.map((issue) => `#${issue}`).join(', ')}` : '';
                const producer = document.producer ? `; producer \`${document.producer}\`` : '';
                lines.push(`- [${document.title}](${RelativeIndexTarget(document.path)}) - owner \`${document.owner}\`${issues}${producer}`);
            }
        }
        lines.push('');
    }
    return `${lines.join('\n').trimEnd()}\n`;
}

function NamingViolation(file)
{
    const segments = file.split('/');
    const offending = segments.find((segment) => /^(?:issues?[-_]\d+(?:[-_]\d+)*|pr[-_]?\d+)/iu.test(segment)
        || /(?:^|[-_])(handoff|implementation-handoff|final|completion|landed)(?:[-_.]|$)/iu.test(segment));
    return offending ?? null;
}

function MarkdownLinks(text)
{
    return [...text.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/gu)].map((match) => match[1]);
}

function NormalizeLinkTarget(source, rawTarget)
{
    let target = rawTarget.trim();
    if (target.startsWith('<') && target.endsWith('>'))
    {
        target = target.slice(1, -1);
    }
    target = target.split(/\s+["']/u, 1)[0];
    if (!target || target.startsWith('#') || /^(?:https?:|mailto:)/iu.test(target))
    {
        return null;
    }
    target = target.split('#', 1)[0].split('?', 1)[0];
    try
    {
        target = decodeURIComponent(target);
    }
    catch
    {
        return '<invalid>';
    }
    return target.startsWith('/')
        ? target.slice(1)
        : path.posix.normalize(path.posix.join(path.posix.dirname(source), target));
}

function ValidateMarkdown(root, document, errors, linkExceptions)
{
    const text = fs.readFileSync(path.join(root, document.path), 'utf8');
    let openFence = null;
    for (const [index, line] of text.split(/\r?\n/u).entries())
    {
        const fence = line.match(/^\s*(```+|~~~+)(.*)$/u);
        if (fence)
        {
            if (openFence === null)
            {
                openFence = fence[1][0];
                if (!fence[2].trim())
                {
                    errors.push(`${document.path}:${index + 1} fenced code block requires a language`);
                }
            }
            else if (fence[1][0] === openFence)
            {
                openFence = null;
            }
        }
    }
    if (openFence !== null)
    {
        errors.push(`${document.path} contains an unclosed fenced code block`);
    }
    for (const rawTarget of MarkdownLinks(text))
    {
        const target = NormalizeLinkTarget(document.path, rawTarget);
        if (target === '<invalid>' || (target && !fs.existsSync(path.join(root, target))))
        {
            const key = `${document.path} -> ${rawTarget}`;
            if (!linkExceptions.has(key))
            {
                errors.push(`${document.path} references missing internal link ${rawTarget}`);
            }
        }
    }
}

function ValidatePolicy(root, policy, inventory, errors, options)
{
    if (policy.schema !== DocumentLifecycleSchema)
    {
        errors.push(`document lifecycle schema must be ${DocumentLifecycleSchema}`);
    }
    const allowedStatuses = new Set(['current', 'proposed', 'historical', 'generated', 'retired']);
    const allowedOwners = new Set(['backend', 'frontend', 'security', 'release', 'governance']);
    const paths = new Set();
    const metadataPaths = new Set();
    for (const metadata of policy.documents ?? [])
    {
        if (metadataPaths.has(metadata.path))
        {
            errors.push(`duplicate explicit document metadata path ${metadata.path}`);
        }
        metadataPaths.add(metadata.path);
        if (!fs.existsSync(path.join(root, metadata.path)))
        {
            errors.push(`explicit document metadata references missing path ${metadata.path}`);
        }
    }
    for (const document of inventory.documents)
    {
        if (paths.has(document.path))
        {
            errors.push(`duplicate document metadata path ${document.path}`);
        }
        paths.add(document.path);
        if (!metadataPaths.has(document.path))
        {
            errors.push(`${document.path} requires explicit document metadata`);
        }
        if (!allowedStatuses.has(document.status))
        {
            errors.push(`${document.path} has invalid status ${document.status}`);
        }
        if (!allowedOwners.has(document.owner))
        {
            errors.push(`${document.path} has invalid owner ${document.owner}`);
        }
        if (document.status !== 'current' && document.sourceOfTruth)
        {
            errors.push(`${document.path} cannot be a ${document.status} source of truth`);
        }
        if (document.status === 'generated' && (!document.producer || !fs.existsSync(path.join(root, document.producer))))
        {
            errors.push(`${document.path} generated producer does not exist: ${document.producer ?? '<missing>'}`);
        }
    }
    const compatibilityPaths = new Set();
    for (const entry of policy.legacyNamingCompatibility ?? [])
    {
        if (compatibilityPaths.has(entry.path))
        {
            errors.push(`duplicate legacy naming compatibility path ${entry.path}`);
        }
        compatibilityPaths.add(entry.path);
        if (!paths.has(entry.path) || !NamingViolation(entry.path) || !Number.isInteger(entry.removalIssue))
        {
            errors.push(`invalid legacy naming compatibility entry ${entry.path}`);
        }
    }
    for (const document of inventory.documents)
    {
        const offending = NamingViolation(document.path);
        if (offending && !compatibilityPaths.has(document.path))
        {
            errors.push(`${document.path} has forbidden long-term name ${offending}; use domain, subject, lifecycle state, and audience semantics`);
        }
    }
    const claims = new Map();
    for (const claim of policy.authorityClaims ?? [])
    {
        if (claims.has(claim.id))
        {
            errors.push(`duplicate source-of-truth authority ID ${claim.id}`);
        }
        claims.set(claim.id, claim.path);
        const document = inventory.documents.find((entry) => entry.path === claim.path);
        if (!document?.sourceOfTruth || document.status !== 'current')
        {
            errors.push(`authority ${claim.id} must reference one current source of truth: ${claim.path}`);
        }
    }
    const documentByPath = new Map(inventory.documents.map((entry) => [entry.path, entry]));
    for (const document of inventory.documents)
    {
        for (const targetPath of document.supersedes)
        {
            const target = documentByPath.get(targetPath);
            if (!target)
            {
                errors.push(`${document.path} supersedes missing target ${targetPath}`);
            }
            else if (target.supersededBy !== document.path)
            {
                errors.push(`${document.path} supersedes ${targetPath} without reciprocal supersededBy`);
            }
        }
        if (document.supersededBy)
        {
            const replacement = documentByPath.get(document.supersededBy);
            if (!replacement)
            {
                errors.push(`${document.path} supersededBy target does not exist: ${document.supersededBy}`);
            }
            else if (!replacement.supersedes.includes(document.path))
            {
                errors.push(`${document.path} supersededBy ${document.supersededBy} without reciprocal supersedes`);
            }
        }
    }
    for (const start of inventory.documents)
    {
        const visited = new Set();
        let current = start;
        while (current?.supersededBy)
        {
            if (visited.has(current.path))
            {
                errors.push(`document supersession cycle includes ${current.path}`);
                break;
            }
            visited.add(current.path);
            current = documentByPath.get(current.supersededBy);
        }
    }
    if (options.validateGit !== false)
    {
        try
        {
            execFileSync('git', ['-C', root, 'merge-base', '--is-ancestor', policy.lastVerifiedCommit, 'HEAD'], { stdio: 'ignore' });
            const distance = Number(execFileSync('git', ['-C', root, 'rev-list', '--count', `${policy.lastVerifiedCommit}..HEAD`], { encoding: 'utf8' }).trim());
            if (!Number.isInteger(distance) || distance > policy.maximumVerificationDistance)
            {
                errors.push(`document lifecycle verification commit is stale by ${distance} commits`);
            }
        }
        catch
        {
            errors.push(`document lifecycle lastVerifiedCommit is not an ancestor of HEAD: ${policy.lastVerifiedCommit}`);
        }
    }
    const currentMarkdown = inventory.documents.filter((entry) => entry.kind === 'markdown' && entry.status === 'current');
    for (const document of currentMarkdown)
    {
        const text = fs.readFileSync(path.join(root, document.path), 'utf8');
        for (const retired of policy.retiredReferences ?? [])
        {
            if (text.includes(retired.token))
            {
                errors.push(`${document.path} contains retired reference ${retired.token}`);
            }
        }
    }
    const migrationSources = new Set();
    for (const migration of policy.pathMigrations ?? [])
    {
        if (migrationSources.has(migration.from))
        {
            errors.push(`duplicate document path migration source ${migration.from}`);
        }
        migrationSources.add(migration.from);
        if (paths.has(migration.from) || !paths.has(migration.to))
        {
            errors.push(`invalid document path migration ${migration.from} -> ${migration.to}`);
        }
    }
}

export function ValidateDocumentLifecycle(root, policy, inventory, expectedIndex, options = {})
{
    const errors = [];
    ValidatePolicy(root, policy, inventory, errors, options);
    const linkExceptions = new Set((policy.brokenLinkExceptions ?? []).map((entry) => `${entry.source} -> ${entry.target}`));
    for (const document of inventory.documents.filter((entry) => entry.kind === 'markdown'))
    {
        ValidateMarkdown(root, document, errors, linkExceptions);
    }
    const inventoryPath = path.join(root, 'config/development/document-inventory.generated.json');
    const indexPath = path.join(root, 'docs/index.md');
    const expectedInventory = `${JSON.stringify(inventory, null, 4)}\n`;
    if (!fs.existsSync(inventoryPath) || fs.readFileSync(inventoryPath, 'utf8') !== expectedInventory)
    {
        errors.push('document inventory is stale; run node tools/docs/generate-document-lifecycle.mjs');
    }
    if (!fs.existsSync(indexPath) || fs.readFileSync(indexPath, 'utf8') !== expectedIndex)
    {
        errors.push('docs/index.md is stale; run node tools/docs/generate-document-lifecycle.mjs');
    }
    return errors.sort(CompareOrdinal);
}

export function WriteDocumentLifecycle(root, policy)
{
    const inventory = BuildDocumentInventory(root, policy);
    fs.writeFileSync(
        path.join(root, 'config/development/document-inventory.generated.json'),
        `${JSON.stringify(inventory, null, 4)}\n`
    );
    fs.writeFileSync(path.join(root, 'docs/index.md'), RenderDocumentIndex(inventory));
    return inventory;
}
