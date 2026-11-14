import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

function record(value)
{
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function own(value, name)
{
    return record(value) && Object.hasOwn(value, name) ? value[name] : undefined;
}

function fail(detail)
{
    throw new Error('canonical declaration workspace source projection refuses ' + detail);
}

function packageName(value)
{
    return typeof value === 'string' && value.length <= 214
        && /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(value);
}

function selectedDirectory(value, selectors)
{
    return selectors.some(selector => value.startsWith(selector.slice(0, -1))
        && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(value.slice(selector.length - 1)));
}

function workspaceVersion(specifier, manifest)
{
    const present = Object.hasOwn(manifest, 'version');
    if (present && (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/u.test(manifest.version)))
    {
        fail('an unsupported source package version');
    }
    if (specifier === 'workspace:*')
    {
        if (!present && manifest.private !== true)
        {
            fail('an unversioned nonprivate workspace source');
        }
    }
    else
    {
        // This port accepts the original literal caret triplet only when it matches exactly.
        // Other pnpm range forms need their own supported semantic owner before admission.
        const match = /^workspace:\^(\d+\.\d+\.\d+)$/u.exec(specifier);
        if (!match || !present || manifest.version !== match[1])
        {
            fail('an unsupported or unsatisfied workspace version declaration');
        }
    }
    return { versionPresent: present, ...(present ? { version: manifest.version } : {}), private: manifest.private === true };
}

/** Project the original pnpm workspace protocol from Git inputs; never discover packages by following links. */
export function projectCanonicalWorkspaceSourceAliases({ root, index, read, parse })
{
    const configurationFiles = ['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml'];
    const present = configurationFiles.map(file => index.has(file));
    if (!present[0] && !present[1])
    {
        return { configured: false, selectors: [], members: [], aliases: [] };
    }
    if (present.some(value => !value))
    {
        fail('an incomplete original workspace configuration');
    }
    const manifest = JSON.parse(read(path.join(root, configurationFiles[0])));
    const workspace = parse(read(path.join(root, configurationFiles[1])));
    const lock = parse(read(path.join(root, configurationFiles[2])));
    const selectors = own(workspace, 'packages');
    if (!record(manifest) || own(manifest, 'packageManager') !== 'pnpm@10.33.0'
        || !Array.isArray(selectors) || !selectors.length
        || selectors.length !== new Set(selectors).size || !isDeepStrictEqual(manifest.workspaces, selectors)
        || selectors.some(value => typeof value !== 'string'
            || !/^(?:[a-zA-Z0-9][a-zA-Z0-9._-]*\/)+\*$/u.test(value))
        || !record(own(lock, 'importers')) || own(lock, 'lockfileVersion') !== '9.0')
    {
        fail('unknown workspace selectors or lock format');
    }
    const members = [];
    const names = new Map();
    for (const [file, entry] of [...index].sort(([left], [right]) => left.localeCompare(right)))
    {
        const directory = path.posix.dirname(file);
        if (path.posix.basename(file) !== 'package.json' || !selectedDirectory(directory, selectors))
        {
            continue;
        }
        if (!['100644', '100755'].includes(entry.mode))
        {
            fail('a nonregular Git workspace manifest');
        }
        const source = JSON.parse(read(path.join(root, file)));
        if (!record(source) || !packageName(source.name) || names.has(source.name))
        {
            fail('an invalid or duplicate Git workspace name');
        }
        const member = { directory, manifest: file, name: source.name, source };
        members.push(member);
        names.set(source.name, member);
    }
    if (!members.length)
    {
        fail('an empty Git workspace membership');
    }
    const importers = [{ directory: '.', source: manifest }, ...members];
    if (!isDeepStrictEqual(Object.keys(lock.importers).sort(), importers.map(value => value.directory).sort()))
    {
        fail('a lock importer outside the exact Git workspace membership');
    }
    const aliases = [];
    for (const importer of importers)
    {
        const lockedImporter = own(lock.importers, importer.directory);
        if (!record(lockedImporter))
        {
            fail('a malformed workspace importer');
        }
        const declared = new Set();
        const dependencyDeclarations = new Map();
        for (const section of ['dependencies', 'devDependencies', 'optionalDependencies'])
        {
            const dependencies = own(importer.source, section) ?? {};
            const locked = own(lockedImporter, section) ?? {};
            if (!record(dependencies) || !record(locked))
            {
                fail('a malformed workspace dependency section');
            }
            for (const [name, specifier] of Object.entries(dependencies))
            {
                const previous = dependencyDeclarations.get(name);
                if (previous !== undefined && (String(previous).startsWith('workspace:') || String(specifier).startsWith('workspace:')))
                {
                    fail('a workspace name declared in multiple dependency sections');
                }
                dependencyDeclarations.set(name, specifier);
                if (typeof specifier !== 'string' || !specifier.startsWith('workspace:'))
                {
                    continue;
                }
                const target = names.get(name);
                const binding = own(locked, name);
                if (!packageName(name) || declared.has(name) || !target || !record(binding)
                    || binding.specifier !== specifier || typeof binding.version !== 'string'
                    || !binding.version.startsWith('link:'))
                {
                    fail('a workspace declaration without its exact lock importer binding');
                }
                const link = binding.version.slice('link:'.length);
                const targetPath = path.resolve(root, importer.directory, link);
                if (!link || path.isAbsolute(link) || link.includes('\\') || link.includes('\0')
                    || targetPath !== path.join(root, target.directory))
                {
                    fail('a workspace link outside its exact declared Git target');
                }
                declared.add(name);
                aliases.push({ name, importer: importer.directory, section, specifier,
                    lockedLink: binding.version, sourceManifest: target.manifest,
                    logical: path.join(root, importer.directory, 'node_modules', name),
                    target: targetPath, ...workspaceVersion(specifier, target.source) });
            }
            for (const [name, binding] of Object.entries(locked))
            {
                if (record(binding) && (binding.specifier?.startsWith('workspace:') || binding.version?.startsWith('link:'))
                    && (!Object.hasOwn(dependencies, name) || dependencies[name] !== binding.specifier
                        || !dependencies[name].startsWith('workspace:')))
                {
                    fail('an undeclared lock workspace link');
                }
            }
        }
    }
    return { configured: true, selectors, members: members.map(({ source, ...member }) => ({ ...member,
        versionPresent: Object.hasOwn(source, 'version'), ...(Object.hasOwn(source, 'version') ? { version: source.version } : {}),
        private: source.private === true })), aliases };
}
