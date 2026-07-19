import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const DocumentLifecycleSchema = 'fsusblog.document-lifecycle-policy.v1';
export const DocumentInventorySchema = 'fsusblog.document-inventory.v1';

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

function GlobToRegExp(pattern)
{
    let source = '';
    for (let index = 0; index < pattern.length; index += 1)
    {
        const character = pattern[index];
        if (character === '*' && pattern[index + 1] === '*')
        {
            if (pattern[index + 2] === '/')
            {
                source += '(?:.*/)?';
                index += 2;
            }
            else
            {
                source += '.*';
                index += 1;
            }
            continue;
        }
        if (character === '*')
        {
            source += '[^/]*';
            continue;
        }
        if (character === '?')
        {
            source += '[^/]';
            continue;
        }
        source += /[.+^${}()|[\]\\]/u.test(character) ? `\\${character}` : character;
    }
    return new RegExp(`^${source}$`, 'u');
}

function Matches(file, patterns)
{
    return patterns.some((pattern) => GlobToRegExp(pattern).test(file));
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

function RelatedIssues(file)
{
    if (!/(?:^|\/)issues?-/u.test(file))
    {
        return [];
    }
    return [...new Set([...file.matchAll(/issues?-(\d{3,5})(?:-(\d{3,5}))?/gu)]
        .flatMap((match) => [match[1], match[2]])
        .filter(Boolean)
        .map(Number))]
        .sort((left, right) => left - right);
}

function FirstRuleValue(file, rules, field, fallback)
{
    for (const rule of rules)
    {
        if (Matches(file, rule.patterns))
        {
            return rule[field];
        }
    }
    return fallback;
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
    const producerByDocument = new Map((policy.generatedDocuments ?? []).map((entry) => [entry.path, entry.producer]));
    const documents = WalkFiles(root, 'docs').map((file) =>
    {
        const kind = DocumentKind(file);
        const status = FirstRuleValue(file, policy.statusRules ?? [], 'status', 'current');
        const owner = FirstRuleValue(file, policy.ownerRules ?? [], 'owner', 'governance');
        const sourceOfTruth = status === 'current' && kind !== 'asset';
        return {
            path: file,
            title: DocumentTitle(root, file),
            kind,
            status,
            owner,
            sourceOfTruth,
            lastVerifiedCommit: policy.lastVerifiedCommit,
            supersedes: [],
            supersededBy: null,
            relatedIssues: RelatedIssues(file),
            producer: producerByDocument.get(file) ?? null
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
        '本索引由 `config/development/document-lifecycle.json` 和当前 `docs/` inventory 生成。长期事实源只出现在 Current 区域；issue handoff、迁移记录和实施快照会被显式分类为 Historical，不再与当前权威文档并列。',
        '',
        '- Lifecycle policy: [`development/document-lifecycle.md`](development/document-lifecycle.md)',
        '- Machine-readable inventory: [`../config/development/document-inventory.generated.json`](../config/development/document-inventory.generated.json)',
        '- Historical documents keep stable paths until an explicit redirect-map migration is reviewed.',
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
        for (const document of documents)
        {
            const issues = document.relatedIssues.length > 0 ? `; issues ${document.relatedIssues.map((issue) => `#${issue}`).join(', ')}` : '';
            const producer = document.producer ? `; producer \`${document.producer}\`` : '';
            lines.push(`- [${document.title}](${RelativeIndexTarget(document.path)}) - owner \`${document.owner}\`${issues}${producer}`);
        }
        lines.push('');
    }
    return `${lines.join('\n').trimEnd()}\n`;
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
    for (const document of inventory.documents)
    {
        if (paths.has(document.path))
        {
            errors.push(`duplicate document metadata path ${document.path}`);
        }
        paths.add(document.path);
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
    const closedIssues = new Set(policy.closedIssues ?? []);
    for (const document of inventory.documents)
    {
        if (document.relatedIssues.some((issue) => closedIssues.has(issue)) && !['historical', 'retired'].includes(document.status))
        {
            errors.push(`${document.path} belongs to a closed issue and must be historical or retired`);
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
    const redirectSources = new Set();
    for (const redirect of policy.redirects ?? [])
    {
        if (redirectSources.has(redirect.from))
        {
            errors.push(`duplicate document redirect source ${redirect.from}`);
        }
        redirectSources.add(redirect.from);
        if (paths.has(redirect.from) || !paths.has(redirect.to))
        {
            errors.push(`invalid document redirect ${redirect.from} -> ${redirect.to}`);
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
