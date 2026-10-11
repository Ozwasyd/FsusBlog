import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function hasLocalFsusUiSource(root)
{
    return fs.existsSync(path.join(root, 'vue', 'packages', 'element-plus', 'index.ts'))
    && fs.existsSync(path.join(root, 'vue', 'packages', 'icons-vue', 'src', 'index.ts'));
}

const sourceCopyMarker = '.fsusblog-source-copy.json';

function sourceCopyRoot(repositoryRoot, sourceRoot)
{
    const identity = createHash('sha256').update(fs.realpathSync(sourceRoot)).digest('hex');
    return path.join(repositoryRoot, '.tmp', 'fsusui-source', identity);
}

function localSourceSnapshot(root)
{
    const files = [];
    const visit = (relative) =>
    {
        const file = path.join(root, relative);
        const stat = fs.lstatSync(file);
        if (stat.isSymbolicLink())
        {
            throw new Error(`local FsusUI source copy requires real source files: ${relative}`);
        }
        if (stat.isDirectory())
        {
            for (const name of fs.readdirSync(file).sort())
            {
                if (!['node_modules', '.git', '.tmp', '.cache'].includes(name))
                {
                    visit(path.join(relative, name));
                }
            }
        }
        else if (stat.isFile())
        {
            files.push(relative);
        }
        else
        {
            throw new Error(`unsupported local FsusUI source file: ${relative}`);
        }
    };
    visit('vue');
    for (const file of ['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml'])
    {
        if (fs.existsSync(path.join(root, file)))
        {
            visit(file);
        }
    }
    const digest = createHash('sha256');
    for (const file of files)
    {
        digest.update(file.split(path.sep).join('/'));
        digest.update('\0');
        digest.update(fs.readFileSync(path.join(root, file)));
        digest.update('\0');
    }
    return { files, hash: digest.digest('hex') };
}

function readSourceCopy(root, repositoryRoot, sourceRoot, verifyDependencies = true)
{
    const stat = fs.lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(root) !== root)
    {
        throw new Error('local FsusUI source copy must be a dedicated real directory');
    }
    const markerPath = path.join(root, sourceCopyMarker);
    if (!fs.lstatSync(markerPath).isFile() || fs.lstatSync(markerPath).isSymbolicLink())
    {
        throw new Error('local FsusUI source copy binding is missing');
    }
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    if (marker.schema !== 'fsusblog.local-fsusui-source-copy.v1'
        || marker.sourceRoot !== fs.realpathSync(sourceRoot)
        || root !== sourceCopyRoot(repositoryRoot, sourceRoot)
        || fs.realpathSync(path.resolve(marker.frontendRoot, '../..')) !== repositoryRoot)
    {
        throw new Error('local FsusUI source copy belongs to a different consumer or source');
    }
    const dependencies = path.join(root, 'node_modules');
    const consumerDependencies = path.join(marker.frontendRoot, 'node_modules');
    if (verifyDependencies && (!fs.lstatSync(dependencies).isSymbolicLink()
        || fs.realpathSync(dependencies) !== fs.realpathSync(consumerDependencies)
        || fs.realpathSync(path.join(root, 'vue/packages/node_modules/vue'))
            !== fs.realpathSync(path.join(consumerDependencies, 'vue'))))
    {
        throw new Error('local FsusUI source copy must use the consumer Vue identity throughout');
    }
    return marker;
}

function sourceOwnerRoot(root, repositoryRoot)
{
    const canonical = fs.realpathSync(root);
    const markerPath = path.join(canonical, sourceCopyMarker);
    if (!fs.existsSync(markerPath))
    {
        return root;
    }
    const sourceRoot = JSON.parse(fs.readFileSync(markerPath, 'utf8')).sourceRoot;
    return readSourceCopy(canonical, repositoryRoot, sourceRoot, false).sourceRoot;
}

function selectSourceCopy(root, repositoryRoot)
{
    const sourceRoot = fs.realpathSync(sourceOwnerRoot(root, repositoryRoot));
    const copy = sourceCopyRoot(repositoryRoot, sourceRoot);
    if (!fs.existsSync(copy))
    {
        return root;
    }
    const marker = readSourceCopy(copy, repositoryRoot, sourceRoot);
    if (localSourceSnapshot(sourceRoot).hash !== marker.sourceHash
        || localSourceSnapshot(copy).hash !== marker.sourceHash)
    {
        throw new Error('local FsusUI source copy is stale; rerun local source initialization');
    }
    return copy;
}

/** Publish a consumer-owned real source copy; initialize never receives the owner checkout. */
export function prepareLocalFsusUiSourceCopy({ repositoryRoot, sourceRoot, frontend, initialize })
{
    const consumer = fs.realpathSync(repositoryRoot);
    const owner = fs.realpathSync(sourceRoot);
    const destination = sourceCopyRoot(consumer, owner);
    const relative = path.relative(owner, destination);
    if (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    {
        throw new Error('local FsusUI dependency projection must be outside the source owner');
    }
    const parent = path.dirname(destination);
    fs.mkdirSync(parent, { recursive: true });
    if (fs.realpathSync(parent) !== parent)
    {
        throw new Error('local FsusUI source copy parent must be a real consumer directory');
    }
    if (fs.existsSync(destination))
    {
        const marker = readSourceCopy(destination, consumer, owner, false);
        if (marker.frontendRoot !== fs.realpathSync(frontend))
        {
            throw new Error('local FsusUI source copy belongs to a different frontend');
        }
    }
    const temporary = fs.mkdtempSync(path.join(parent, '.prepare-'));
    const previous = `${temporary}.previous`;
    let published = false;
    try
    {
        const snapshot = localSourceSnapshot(owner);
        for (const file of snapshot.files)
        {
            const target = path.join(temporary, file);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.copyFileSync(path.join(owner, file), target);
        }
        if (localSourceSnapshot(temporary).hash !== snapshot.hash
            || localSourceSnapshot(owner).hash !== snapshot.hash)
        {
            throw new Error('local FsusUI source changed while preparing its consumer copy');
        }
        fs.symlinkSync(path.join(fs.realpathSync(frontend), 'node_modules'), path.join(temporary, 'node_modules'), 'dir');
        initialize(temporary);
        if (fs.realpathSync(path.join(temporary, 'vue/packages/node_modules/vue'))
            !== fs.realpathSync(path.join(frontend, 'node_modules/vue')))
        {
            throw new Error('local FsusUI source copy must use the consumer Vue identity throughout');
        }
        fs.writeFileSync(path.join(temporary, sourceCopyMarker), `${JSON.stringify({
            schema: 'fsusblog.local-fsusui-source-copy.v1',
            sourceRoot: owner,
            frontendRoot: fs.realpathSync(frontend),
            sourceHash: snapshot.hash
        }, null, 2)}\n`, { flag: 'wx' });
        if (fs.existsSync(destination))
        {
            fs.renameSync(destination, previous);
        }
        fs.renameSync(temporary, destination);
        published = true;
        return destination;
    }
    catch (error)
    {
        if (fs.existsSync(previous) && !fs.existsSync(destination))
        {
            fs.renameSync(previous, destination);
        }
        throw error;
    }
    finally
    {
        fs.rmSync(temporary, { recursive: true, force: true });
        if (published)
        {
            fs.rmSync(previous, { recursive: true, force: true });
        }
    }
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
    gitCommonDirectory,
    preferSourceCopy = true
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
        const consumer = fs.realpathSync(repositoryRoot);
        return preferSourceCopy ? selectSourceCopy(explicitRoot, consumer) : sourceOwnerRoot(explicitRoot, consumer);
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

    const sourceRoot = candidates.find((candidate) => hasLocalFsusUiSource(candidate));
    return sourceRoot && preferSourceCopy
        ? selectSourceCopy(sourceRoot, fs.realpathSync(repositoryRoot))
        : sourceRoot ?? null;
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
