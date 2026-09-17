import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function hasLocalFsusUiSource(root)
{
    return fs.existsSync(path.join(root, 'vue', 'packages', 'element-plus', 'index.ts'))
    && fs.existsSync(path.join(root, 'vue', 'packages', 'icons-vue', 'src', 'index.ts'));
}

function resolveGitCommonDirectory(repositoryRoot)
{
    const result = spawnSync(
        'git',
        ['-C', repositoryRoot, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
        {
            encoding: 'utf8',
            windowsHide: true
        }
    );
    if (result.status !== 0)
    {
        return null;
    }

    const commonDirectory = result.stdout.trim();
    return commonDirectory ? path.resolve(repositoryRoot, commonDirectory) : null;
}

export function localFsusUiConsumptionDisabled(env = process.env)
{
    const configured = env.FSUSBLOG_USE_LOCAL_FSUSUI?.trim().toLowerCase();
    return configured === '0' || configured === 'false';
}

export function resolveLocalFsusUiRepositoryRoot({
    override,
    repositoryRoot,
    gitCommonDirectory
} = {})
{
    if (!String(repositoryRoot ?? '').trim())
    {
        throw new Error('FsusBlog repository root is required to resolve local FsusUI');
    }

    if (String(override ?? '').trim())
    {
        const explicitRoot = path.resolve(String(override).trim());
        if (!hasLocalFsusUiSource(explicitRoot))
        {
            throw new Error(
                `FSUSBLOG_LOCAL_FSUSUI_ROOT does not contain the FsusUI source contract: ${explicitRoot}`
            );
        }
        return explicitRoot;
    }

    const blogRoot = path.resolve(repositoryRoot);
    const commonDirectory = gitCommonDirectory === undefined
        ? resolveGitCommonDirectory(blogRoot)
        : path.resolve(gitCommonDirectory);
    const primaryBlogRoot = commonDirectory && path.basename(commonDirectory) === '.git'
        ? path.dirname(commonDirectory)
        : null;
    const candidates = [
    primaryBlogRoot ? path.join(path.dirname(primaryBlogRoot), 'FsusUI') : null,
    path.join(path.dirname(blogRoot), 'FsusUI')
    ].filter(Boolean);

    return candidates.find((candidate) => hasLocalFsusUiSource(candidate)) ?? null;
}

const isMain = process.argv[1]
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain)
{
    const args = process.argv.slice(2);
    const options = {};
    let valid = args.length >= 2 && args.length % 2 === 0;
    for (let index = 0; valid && index < args.length; index += 2)
    {
        const [flag, value] = args.slice(index, index + 2);
        const key = {
            '--repository-root': 'repositoryRoot',
            '--override': 'override',
            '--git-common-directory': 'gitCommonDirectory'
        }[flag];
        if (!key || !value || Object.hasOwn(options, key))
        {
            valid = false;
            break;
        }
        options[key] = value;
    }
    if (!valid || !options.repositoryRoot)
    {
        console.error(
            'usage: fsusui-root.mjs --repository-root ROOT '
          + '[--override ROOT] [--git-common-directory PATH]'
        );
        process.exitCode = 1;
    }
    else
    {
        const localRoot = resolveLocalFsusUiRepositoryRoot({
            override: options.override ?? process.env.FSUSBLOG_LOCAL_FSUSUI_ROOT,
            repositoryRoot: options.repositoryRoot,
            ...(options.gitCommonDirectory
                ? { gitCommonDirectory: options.gitCommonDirectory }
                : {})
        });
        if (!localRoot)
        {
            console.error(
                'local FsusUI source was not found beside the primary FsusBlog checkout; '
              + 'set FSUSBLOG_LOCAL_FSUSUI_ROOT explicitly'
            );
            process.exitCode = 1;
        }
        else
        {
            process.stdout.write(`${localRoot}\n`);
        }
    }
}
