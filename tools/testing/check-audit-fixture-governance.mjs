import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const scanRoots = ['config/testing', 'docs', 'src', 'tests', 'tools'];
const sourceExtensions = new Set(['.cs', '.json', '.md', '.mjs', '.sh', '.sql', '.ts']);
const productionWriter = 'src/backend/Infrastructure/Audit/AuditLogStore.cs';
const producerId = 'audit-records';
const scannerSources = new Set([
    'tests/tools/audit-fixture-governance.test.mjs',
    'tools/testing/check-audit-fixture-governance.mjs'
]);

export function scanAuditFixtureGovernance(repositoryRoot = root)
{
    const errors = [];
    const files = scanRoots.flatMap((relativeRoot) => walk(path.join(repositoryRoot, relativeRoot)))
        .filter((file) => sourceExtensions.has(path.extname(file)))
        .map((file) => path.relative(repositoryRoot, file).split(path.sep).join('/'))
        .sort();
    for (const relative of files)
    {
        if (scannerSources.has(relative))
        {
            continue;
        }
        const text = fs.readFileSync(path.join(repositoryRoot, relative), 'utf8');
        if (/anti-crawler\.demo-signal|comment\.moderation\.demo-pending/u.test(text))
        {
            errors.push(`${relative}: retired unknown positive audit action`);
        }
        if (/INSERT\s+INTO\s+sys_audit_log/iu.test(text) && relative !== productionWriter)
        {
            errors.push(`${relative}: direct audit SQL outside production store`);
        }
        if (/fixture.*(?:fake|fixed).*(?:signer|record[_-]?mac|record[_-]?hash)/iu.test(text)
            && !relative.includes('/Fixtures/'))
        {
            errors.push(`${relative}: fixture-local fake audit signer/hash`);
        }
        if (/(?:audit|fixture)/iu.test(relative)
            && /audit.*(?:compat|alias).*(?:writer|action|retention)/iu.test(text))
        {
            errors.push(`${relative}: audit compatibility authority`);
        }
    }

    const capabilities = readJson(repositoryRoot, 'config/testing/fixture-capability-catalog.json');
    const producers = readJson(repositoryRoot, 'config/testing/fixture-producer-registry.json');
    const variants = readJson(repositoryRoot, 'config/testing/fixture-variant-catalog.json');
    const auditCapabilities = capabilities.capabilities
        .filter((item) => item.id.startsWith('audit.'));
    const owners = producers.producers.filter((item) => item.id === producerId);
    if (owners.length !== 1
        || auditCapabilities.some((item) => item.ownerProducerId !== producerId)
        || owners[0]?.provides.length !== auditCapabilities.length)
    {
        errors.push('audit capabilities must have exactly one producer owner');
    }
    for (const capabilityId of ['audit.tamper-negative', 'audit.unknown-action-negative'])
    {
        const capability = auditCapabilities.find((item) => item.id === capabilityId);
        const bound = variants.variants.filter((item) => item.capabilityId === capabilityId);
        if (JSON.stringify(capability?.validityClasses) !== JSON.stringify(['negative-invalid'])
            || bound.length !== 1
            || bound[0].validityClass !== 'negative-invalid'
            || bound[0].allowedExecutionClasses.some((item) => item !== 'security'))
        {
            errors.push(`${capabilityId}: negative-only execution boundary drifted`);
        }
    }

    const body = {
        schema: 'fsusblog.audit-fixture-governance.v1',
        producerId,
        scannedFileCount: files.length,
        auditCapabilityCount: auditCapabilities.length,
        directAuditSqlOwners: files.filter((relative) => {
            if (scannerSources.has(relative))
            {
                return false;
            }
            const text = fs.readFileSync(path.join(repositoryRoot, relative), 'utf8');
            return /INSERT\s+INTO\s+sys_audit_log/iu.test(text);
        }),
        errors: errors.sort(),
        warnings: []
    };
    return Object.freeze({
        ...body,
        contentDigest: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
        status: errors.length === 0 ? 'verified' : 'failed'
    });
}

function readJson(repositoryRoot, relative)
{
    return JSON.parse(fs.readFileSync(path.join(repositoryRoot, relative), 'utf8'));
}

function walk(directory)
{
    if (!fs.existsSync(directory))
    {
        return [];
    }
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory())
        {
            return entry.name === 'bin' || entry.name === 'node_modules' || entry.name === 'obj'
                ? []
                : walk(absolute);
        }
        return entry.isFile() ? [absolute] : [];
    });
}

if (process.argv[1] === fileURLToPath(import.meta.url))
{
    const result = scanAuditFixtureGovernance();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.status !== 'verified')
    {
        process.exitCode = 1;
    }
}
