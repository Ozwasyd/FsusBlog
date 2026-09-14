import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('../../../..', import.meta.url)));
const viewContractsRoot = join(repoRoot, 'src/frontend/src/view-contracts');
const commentApiPath = join(repoRoot, 'src/frontend/src/api/comment.ts');
const forbidden = [
    /CommentThreadItemContract[\s\S]*?\buserName\b/,
    /\buserName\b[\s\S]*?CommentThreadItem/
];

const violations = [];

for (const file of listSourceFiles(viewContractsRoot))
{
    const source = readFileSync(file, 'utf8');
    for (const pattern of forbidden)
    {
        if (pattern.test(source))
        {
            violations.push(`${relative(repoRoot, file)} matches ${pattern}`);
        }
    }
}

const commentApi = readFileSync(commentApiPath, 'utf8');
const createV2 = commentApi.match(/export interface CommentCreateV2Dto(?: extends [^{]+)? \{[\s\S]*?\n\}/u)?.[0] ?? '';
if (!/@deprecated[^\n]*匿名模式不应设置 replyToUserId/u.test(createV2) || !createV2.includes('replyToUserId?: number | null'))
{
    violations.push('src/frontend/src/api/comment.ts must keep replyToUserId explicitly deprecated during anonymous migration');
}

if (violations.length > 0)
{
    console.error('[check-comment-thread-view-contract-identity] CommentThreadItemContract userName regression detected:');
    for (const violation of violations)
    {
        console.error(`- ${violation}`);
    }
    process.exit(1);
}

console.log('[check-comment-thread-view-contract-identity] OK');

function listSourceFiles(root)
{
    const files = [];
    for (const entry of readdirSync(root))
    {
        const fullPath = join(root, entry);
        const stat = statSync(fullPath);
        if (stat.isDirectory())
        {
            files.push(...listSourceFiles(fullPath));
            continue;
        }
        if (/\.(?:ts|tsx|vue)$/.test(entry))
        {
            files.push(fullPath);
        }
    }
    return files;
}
