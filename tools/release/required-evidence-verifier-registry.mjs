import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const { canonicalize, validateRequiredEvidenceCatalog } = await import(new URL('../test-matrix/required-evidence-catalog.mjs', import.meta.url));
const { governanceContentDigest } = await import(new URL('../test/evidence-location-contract.mjs', import.meta.url));

export const domainVerifierRegistrySchema = 'fsusblog.required-evidence-domain-verifiers.v1';

function assert(condition, message)
{
    if (!condition)
    {
        throw new Error(message);
    }
}

function sourceFile(repositoryRoot, relative)
{
    assert(/^tools\/[a-zA-Z0-9_./-]+\.mjs$/u.test(relative)
        && !relative.split('/').includes('..'), 'owner verifier path is invalid');
    const file = path.resolve(repositoryRoot, relative);
    assert(fs.lstatSync(file).isFile() && !fs.lstatSync(file).isSymbolicLink(),
        'owner verifier must be a regular source file');
    assert(fs.realpathSync(file) === file, 'owner verifier source path contains a symlink');
    return file;
}

export function ownerVerifierSourceDigest(repositoryRoot, relative)
{
    return `sha256:${crypto.createHash('sha256')
        .update(fs.readFileSync(sourceFile(repositoryRoot, relative))).digest('hex')}`;
}

export function createDomainVerifierRegistry({ catalog, repositoryRoot })
{
    const errors = validateRequiredEvidenceCatalog(catalog, { root: repositoryRoot });
    assert(errors.length === 0, `required evidence catalog is invalid: ${errors.join('; ')}`);
    const entries = catalog.entries.map((entry) =>
    {
        const [source, api, extra] = entry.producerVerifier.split(':');
        assert(api && !extra && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(api),
            `${entry.authorityId}: owner verifier API must be explicit`);
        return {
            authorityId: entry.authorityId,
            owner: entry.canonicalOwner,
            ref: entry.producerVerifier,
            version: 1,
            sourceDigest: ownerVerifierSourceDigest(repositoryRoot, source)
        };
    });
    const body = {
        schema: domainVerifierRegistrySchema,
        version: 1,
        catalogSchema: catalog.catalogSchema,
        catalogVersion: catalog.version,
        catalogDigest: catalog.contentDigest,
        entries
    };
    return { ...body, contentDigest: governanceContentDigest(body) };
}

export function verifyDomainVerifierRegistry(registry, options)
{
    const expected = createDomainVerifierRegistry(options);
    assert(JSON.stringify(canonicalize(registry)) === JSON.stringify(canonicalize(expected)),
        'owner verifier registry missing/duplicate/unknown owner, version or source drift');
    return registry;
}

// The execution index consumes this catalog-derived closed source set. It is
// not a second authority/owner roster: catalog drift must regenerate it, while
// the registry and runtime loader still independently check exact ownership.
export function createDomainVerifierImportClosure({ catalog, repositoryRoot })
{
    const registry = createDomainVerifierRegistry({ catalog, repositoryRoot });
    const owner = 'tools/release/required-evidence-verifier-registry.mjs';
    const source = fs.readFileSync(sourceFile(repositoryRoot, owner), 'utf8');
    const expressions = source.match(/import\(moduleUrl\)/gu) ?? [];
    assert(expressions.length === 1, 'owner loader must have one explicit indexed import expression');
    return {
        owner,
        sourceDigest: ownerVerifierSourceDigest(repositoryRoot, owner),
        expressionDigest: `sha256:${crypto.createHash('sha256').update(expressions[0]).digest('hex')}`,
        kind: 'runtime-module-path',
        dependencies: [...new Set(registry.entries.map((entry) => entry.ref.split(':')[0]))].sort()
    };
}

export async function loadDomainVerifier({ registry, catalog, authorityId, repositoryRoot })
{
    verifyDomainVerifierRegistry(registry, { catalog, repositoryRoot });
    const descriptors = registry.entries.filter((entry) => entry.authorityId === authorityId);
    assert(descriptors.length === 1, 'owner verifier must be exact-one');
    const descriptor = descriptors[0];
    const [source, api] = descriptor.ref.split(':');
    const moduleUrl = pathToFileURL(sourceFile(repositoryRoot, source));
    moduleUrl.searchParams.set('ownerDigest', descriptor.sourceDigest);
    const module = await import(moduleUrl);
    const verifier = module[api];
    assert(verifier?.version === descriptor.version
        && typeof verifier.describe === 'function' && typeof verifier.verify === 'function'
        && Array.isArray(verifier.successStatuses) && verifier.successStatuses.length > 0
        && (verifier.correctnessClasses === undefined || (Array.isArray(verifier.correctnessClasses)
            && verifier.correctnessClasses.length > 0 && verifier.correctnessClasses.every((value) =>
            ['correctness', 'browser-contract'].includes(value)))),
    `${authorityId}: owner verifier API is missing or has an unsupported contract`);
    // Recheck bytes after import, including when Node returned a cached module.
    assert(ownerVerifierSourceDigest(repositoryRoot, source) === descriptor.sourceDigest,
        'owner verifier source drift during loading');
    return { descriptor, verifier };
}
