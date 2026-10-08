import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateJsonSchema } from '../test-matrix/schema-validator/validate.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const schema = JSON.parse(fs.readFileSync(path.join(root, 'config/security/asset-security-contract.schema.json'), 'utf8'));

export function loadAssetSecurityContract(bytes, repository = root)
{
    const contract = JSON.parse(bytes);
    const errors = validateJsonSchema(contract, schema);
    const unique = (items, label) =>
    {
        if (new Set(items).size !== items.length) errors.push(`${label}: duplicate identity`);
    };
    if (errors.length) throw new Error(`asset_security_contract_invalid: ${errors.join('; ')}`);
    unique(contract.roots.map(value => value.property), 'roots.property');
    unique(contract.roots.map(value => value.classification), 'roots.classification');
    unique(contract.staticMappings.map(value => value.id), 'staticMappings.id');
    unique(contract.staticMappings.map(value => `${value.source}:${value.member}:${value.api}`), 'staticMappings.site');
    if (!contract.identity.canonicalTables.includes(contract.identity.referenceTable)) errors.push('identity.referenceTable: missing canonical owner');
    if (contract.identity.canonicalTables.some(value => contract.identity.retiredTables.includes(value))) errors.push('identity: retired canonical table');
    const sources = [
        ...contract.assetServiceSources, ...contract.composeSources,
        ...contract.staticMappings.map(value => value.source), contract.gateway.source,
        contract.policy.input, contract.policy.schema, contract.policy.generator, ...contract.policy.outputs
    ];
    const canonicalRoot = fs.realpathSync(repository);
    for (const source of sources)
    {
        const parts = source.split('/');
        if (parts.some(value => value === '.' || value === '..' || value.length === 0))
        {
            errors.push(`${source}: source path escapes contract root`);
            continue;
        }
        const candidate = path.resolve(repository, source);
        if (!fs.existsSync(candidate))
        {
            errors.push(`${source}: owner source missing`);
            continue;
        }
        const relative = path.relative(canonicalRoot, fs.realpathSync(candidate));
        if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) errors.push(`${source}: realpath escapes contract root`);
    }
    if (errors.length) throw new Error(`asset_security_contract_invalid: ${errors.join('; ')}`);
    return contract;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href)
{
    if (process.argv.length !== 3 || process.argv[2] !== '--validate') throw new Error('usage: node asset-security-contract.mjs --validate (validates input only; not a static acceptance scanner)');
    const contract = loadAssetSecurityContract(fs.readFileSync(path.join(root, 'config/security/asset-security-contract.json')));
    console.log(JSON.stringify({ kind: 'asset-security-contract-input-validation', schemaVersion: contract.schemaVersion, staticAcceptance: false, mappingSites: contract.staticMappings.length }));
}
