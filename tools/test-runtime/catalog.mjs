/* eslint-disable import-x/no-relative-parent-imports -- Repository contract tests and tool authorities intentionally compose sibling owner modules. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runtimeSteps } from '../test/bundles/bundle-steps.mjs';
import { digestCanonical, freezeDeep } from '../test-fixtures/receipt/canonical.mjs';
import { validateRuntimeStateDomainCatalog } from '../test-matrix/runtime-state-domain-catalog.mjs';

import { requireText, sortedUniqueStrings } from './contract.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const defaultCatalogPath = path.join(repositoryRoot, 'config/testing/runtime-state-domain-catalog.json');

function readJson(file, label)
{
    try
    {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    catch (error)
    {
        throw new Error(`${label} is unreadable`, { cause: error });
    }
}

export function runtimeCatalogDigest(catalog)
{
    return digestCanonical(catalog);
}

export function loadRuntimeStateAuthority({
    catalogPath = defaultCatalogPath,
    steps = runtimeSteps(),
    sourceOverrides
} = {})
{
    const absoluteCatalog = path.resolve(catalogPath);
    const errors = validateRuntimeStateDomainCatalog(absoluteCatalog, steps, sourceOverrides ? { sourceOverrides } : {});
    if (errors.length > 0)
    {
        throw new Error(`runtime state-domain catalog is invalid: ${errors.join('; ')}`);
    }
    const catalog = readJson(absoluteCatalog, 'runtime state-domain catalog');
    const registryPath = path.resolve(repositoryRoot, catalog.registry);
    const registry = readJson(registryPath, 'runtime state-domain registry');
    const bindings = registry.observerBindings ?? [];
    const domains = sortedUniqueStrings(registry.domains, 'runtime state domains', { allowEmpty: false });
    const domainSet = new Set(domains);
    const bindingByDomain = new Map();
    for (const binding of bindings)
    {
        const domain = requireText(binding?.domain, 'observer binding domain');
        if (!domainSet.has(domain) || bindingByDomain.has(domain))
        {
            throw new Error(`observer binding is missing, duplicate or unknown: ${domain}`);
        }
        bindingByDomain.set(domain, freezeDeep({
            domain,
            observerId: requireText(binding.observerId, `observer binding ${domain}.observerId`),
            observerVersion: requireText(binding.observerVersion, `observer binding ${domain}.observerVersion`),
            semanticClass: requireText(binding.semanticClass, `observer binding ${domain}.semanticClass`)
        }));
    }
    const missingBindings = domains.filter((domain) => !bindingByDomain.has(domain));
    if (missingBindings.length > 0)
    {
        throw new Error(`runtime state domains have no exact observer binding: ${missingBindings.join(', ')}`);
    }
    const stepById = new Map((catalog.steps ?? []).map((entry) => [entry.stepId, freezeDeep(entry)]));
    if (stepById.size !== (catalog.steps ?? []).length)
    {
        throw new Error('runtime state catalog has duplicate step IDs');
    }
    const accessedDomains = new Set();
    for (const entry of catalog.steps ?? [])
    {
        for (const field of ['reads', 'writes', 'creates', 'deletes', 'invalidates', 'exclusiveStateDomains'])
        {
            for (const domain of entry[field] ?? [])
            {
                accessedDomains.add(domain);
            }
        }
    }
    return freezeDeep({
        catalog,
        registry,
        catalogDigest: runtimeCatalogDigest(catalog),
        registryDigest: digestCanonical(registry),
        steps: Object.fromEntries([...stepById]),
        observerBindings: Object.fromEntries([...bindingByDomain]),
        accessedDomains: [...accessedDomains].sort()
    });
}

export function assertRuntimeAuthorityUnchanged(authority, { catalogPath = defaultCatalogPath } = {})
{
    const current = readJson(path.resolve(catalogPath), 'runtime state-domain catalog');
    const currentDigest = runtimeCatalogDigest(current);
    if (currentDigest !== authority?.catalogDigest)
    {
        throw new Error('runtime state-domain catalog drifted during execution');
    }
    return true;
}

export { defaultCatalogPath as runtimeStateDomainCatalogPath };
