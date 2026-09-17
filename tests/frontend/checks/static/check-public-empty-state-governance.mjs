#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const failures = [];

const rel = (file) => path.relative(repoRoot, file).replaceAll(path.sep, '/');
const read = (file) => fs.readFileSync(file, 'utf8');

const targetRoots = [
    'src/frontend/src/components/home',
    'src/frontend/src/components/article'
].map((dir) => path.join(repoRoot, dir));
const packageJsonPath = path.join(repoRoot, 'src/frontend/package.json');
const requiredContracts = [
    {
        path: 'src/frontend/src/components/home/HomeArticleErrorState.vue',
        tokens: [
            'PublicContentState',
            '文章列表暂时无法加载',
            '请稍后重试。',
            'role="alert"',
            '>重试<'
        ]
    },
    {
        path: 'src/frontend/src/components/home/HomeArticleEmptyState.vue',
        tokens: [
            'PublicContentState',
            '暂时还没有文章',
            '发布后的内容会显示在这里。',
            'href="/archive"',
            '查看归档'
        ]
    },
    {
        path: 'src/frontend/src/components/article/ArticleDetailErrorState.vue',
        tokens: [
            'PublicContentState',
            'description="请稍后重试。"',
            'role="alert"',
            "@click=\"$emit('retry')\""
        ]
    },
    {
        path: 'src/frontend/src/components/article/ArticleDetailNotFoundState.vue',
        tokens: [
            'PublicContentState',
            ':to="view.actionHref"',
            '{{ view.actionText }}'
        ]
    },
    {
        path: 'src/frontend/src/view-contracts/articleDetail.ts',
        tokens: [
            '文章暂时无法加载',
            "retryText: '重试'",
            '文章不存在或已不可见',
            "actionText: '返回首页'"
        ]
    }
];

function fail(file, line, message)
{
    failures.push(`${rel(file)}:${line}: ${message}`);
}

function walk(dir, files = [])
{
    if (!fs.existsSync(dir))
    {
        return files;
    }

    for (const entry of fs.readdirSync(dir, { withFileTypes: true }))
    {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory())
        {
            walk(fullPath, files);
            continue;
        }

        if (entry.isFile() && /\.(vue|ts)$/.test(entry.name))
        {
            files.push(fullPath);
        }
    }

    return files;
}

for (const file of targetRoots.flatMap((dir) => walk(dir)))
{
    const lines = read(file).split(/\r?\n/);
    lines.forEach((line, index) =>
    {
        if (/<el-empty\b/.test(line))
        {
            fail(file, index + 1, 'public home/article states must use FsusBlog-owned public empty/error state patterns, not el-empty');
        }
    });
}

for (const contract of requiredContracts)
{
    const file = path.join(repoRoot, contract.path);
    const source = read(file);
    for (const token of contract.tokens)
    {
        if (!source.includes(token))
        {
            fail(file, 1, `public empty/error state contract is missing ${token}`);
        }
    }
}

const packageJson = JSON.parse(read(packageJsonPath));
const scripts = packageJson.scripts ?? {};
const checkScript = 'node ../../tests/frontend/checks/static/check-public-empty-state-governance.mjs';
if (scripts['check:public-empty-state-governance'] !== checkScript)
{
    fail(packageJsonPath, 1, 'check:public-empty-state-governance script is missing');
}
if (!String(scripts['check:views-constraints'] ?? '').includes('check:public-empty-state-governance'))
{
    fail(packageJsonPath, 1, 'check:views-constraints must run check:public-empty-state-governance');
}

if (failures.length > 0)
{
    console.error(failures.map((failure) => `[public-empty-state-governance] ${failure}`).join('\n'));
    process.exit(1);
}

console.log('[public-empty-state-governance] ok');
