import fs from 'node:fs';
import path from 'node:path';

const NODE_TEST_PATTERN = /(?:^|\/)tests\/.*\.test\.(?:mjs|js)$/u;
const STATES = new Set([
    'canonical-execution',
    'projection',
    'summary',
    'conditional-governance',
    'manual-diagnostic',
    'migration-bound',
    'replacement-ready',
    'obsolete'
]);
const CATEGORIES = new Set([
    'matrix-tier',
    'package-script',
    'workflow-only',
    'repository-governance',
    'manual-diagnostic',
    'projection-contract',
    'replacement-ready',
    'obsolete'
]);
const CLASSIFICATIONS = new Set([
    'source-text',
    'behavior',
    'integration',
    'runtime',
    'perf',
    'migration',
    'compatibility-wrapper'
]);

export function isNodeTestFile(file)
{
    return NODE_TEST_PATTERN.test(String(file));
}

function hasTimeBasedRetirement(value, key = '')
{
    if (/date|age|days|deadline|expires|older|staleAfter/iu.test(key))
    {
        return true;
    }
    if (Array.isArray(value))
    {
        return value.some((entry) => hasTimeBasedRetirement(entry));
    }
    if (value && typeof value === 'object')
    {
        return Object.entries(value).some(([childKey, child]) => hasTimeBasedRetirement(child, childKey));
    }
    return typeof value === 'string' && /\b(?:day|days|week|weeks|month|months|year|years)\b/iu.test(value);
}

function ownerForFile(file, nodeEntry)
{
    if (nodeEntry)
    {
        return nodeEntry.owner;
    }
    if (file.tierIds.length > 0)
    {
        return `matrix:${file.tierIds[0]}`;
    }
    if (file.referencedBy.length > 0)
    {
        return `support:${file.referencedBy[0]}`;
    }
    return `retention:${file.retentionClass}`;
}

function lifecycleForFile(file, nodeEntry)
{
    if (nodeEntry)
    {
        return nodeEntry.lifecycle;
    }
    if (file.retentionClass === 'obsolete-candidate')
    {
        return 'obsolete';
    }
    if (file.tierIds.length > 0)
    {
        return 'canonical-execution';
    }
    if (file.referencedBy.length > 0)
    {
        return 'conditional-governance';
    }
    return 'manual-diagnostic';
}

export function validateLifecycleRegistry({ audit, registry })
{
    const errors = [];
    if (registry?.schema !== 'fsusblog.test-lifecycle-registry.v1')
    {
        errors.push('registry schema must be fsusblog.test-lifecycle-registry.v1');
    }
    const nodeFiles = audit.files.filter(({ path: file }) => isNodeTestFile(file)).map(({ path: file }) => file).sort();
    const entries = Array.isArray(registry?.nodeTests) ? registry.nodeTests : [];
    const byFile = new Map();
    for (const entry of entries)
    {
        if (!entry?.file || byFile.has(entry.file))
        {
            errors.push(`node test registry has missing or duplicate file: ${entry?.file ?? '<missing>'}`);
            continue;
        }
        byFile.set(entry.file, entry);
        if (!STATES.has(entry.lifecycle))
        {
            errors.push(`${entry.file} has invalid lifecycle: ${entry.lifecycle ?? '<missing>'}`);
        }
        if (!CATEGORIES.has(entry.executionCategory))
        {
            errors.push(`${entry.file} has invalid execution category: ${entry.executionCategory ?? '<missing>'}`);
        }
        if (!String(entry.owner ?? '').trim())
        {
            errors.push(`${entry.file} has no canonical owner`);
        }
        if (!Array.isArray(entry.classifications) || entry.classifications.length === 0
      || entry.classifications.some((classification) => !CLASSIFICATIONS.has(classification)))
        {
            errors.push(`${entry.file} needs valid semantic classifications`);
        }
        const count = Number(entry.physicalExecutionCount);
        if (!Number.isInteger(count) || count < 0)
        {
            errors.push(`${entry.file} has invalid physical execution count`);
        }
        if (entry.lifecycle === 'canonical-execution' && count !== 1)
        {
            errors.push(`${entry.file} canonical execution must have exactly one physical owner, found ${count}`);
        }
        if (['projection', 'summary'].includes(entry.lifecycle) && count !== 0)
        {
            errors.push(`${entry.file} ${entry.lifecycle} must not execute a producer`);
        }
        if (entry.lifecycle === 'migration-bound')
        {
            if (!entry.retireCondition || typeof entry.retireCondition !== 'object')
            {
                errors.push(`${entry.file} migration-bound entry needs a structured retire condition`);
            }
            else if (hasTimeBasedRetirement(entry.retireCondition))
            {
                errors.push(`${entry.file} retire condition must be product or compatibility state, not time or age`);
            }
        }
        if (['replacement-ready', 'obsolete'].includes(entry.lifecycle)
      && !(entry.replacementTestIds?.length > 0 || entry.unsupportedAssertionScope === true))
        {
            errors.push(`${entry.file} ${entry.lifecycle} entry needs replacement IDs or an unsupported-scope proof`);
        }
    }
    for (const file of nodeFiles)
    {
        if (!byFile.has(file))
        {
            errors.push(`unowned Node test: ${file}`);
        }
    }
    for (const file of byFile.keys())
    {
        if (!nodeFiles.includes(file))
        {
            errors.push(`registry references missing Node test: ${file}`);
        }
    }
    return errors;
}

export function buildLifecycleReport({ audit, registry })
{
    const errors = validateLifecycleRegistry({ audit, registry });
    if (errors.length > 0)
    {
        return { errors, report: null };
    }
    const nodeEntries = new Map(registry.nodeTests.map((entry) => [entry.file, entry]));
    const files = audit.files.map((file) =>
    {
        const entry = nodeEntries.get(file.path);
        return {
            file: file.path,
            lifecycle: lifecycleForFile(file, entry),
            executionCategory: entry?.executionCategory ?? (file.tierIds.length > 0 ? 'matrix-tier' : 'manual-diagnostic'),
            canonicalOwner: ownerForFile(file, entry),
            physicalExecutionCount: entry?.physicalExecutionCount ?? (file.tierIds.length > 0 ? 1 : 0),
            classifications: entry?.classifications ?? ['behavior'],
            coverageIds: file.coverageIds,
            replacementTestIds: entry?.replacementTestIds ?? [],
            retireCondition: entry?.retireCondition ?? null,
            tierIds: file.tierIds
        };
    });
    const filesByPath = new Map(files.map((file) => [file.file, file]));
    const testRecords = audit.testRecords.map((record) =>
    {
        const file = filesByPath.get(record.path);
        return {
            id: record.id,
            file: record.path,
            semanticAssertionTargets: record.assertionTargets,
            canonicalOwner: file.canonicalOwner,
            lifecycle: file.lifecycle,
            physicalExecutionCount: file.physicalExecutionCount,
            classifications: file.classifications,
            coverageIds: record.coverageIds,
            replacementTestIds: file.replacementTestIds,
            uniqueFailureEvidence: record.failureHistory?.failures > 0 ? record.failureHistory : null,
            equivalentBehaviorOwner: record.equivalentTo ?? null,
            observedTierInvocationCount: record.tierInvocationCount,
            currentContractIdentity: audit.sourceState
        };
    });
    return {
        errors: [],
        report: {
            schema: 'fsusblog.test-lifecycle-report.v1',
            generatedAt: new Date().toISOString(),
            sourceState: audit.sourceState,
            policy: {
                timeOrAgeMayDecideLifecycle: false,
                unownedFailsClosed: true,
                deletionRequiresReplacementOrUnsupportedScope: true
            },
            files,
            testRecords,
            decisions: files.map((file) => ({
                file: file.file,
                action: file.lifecycle === 'obsolete' ? 'delete'
                    : file.lifecycle === 'replacement-ready' ? 'merge-or-delete'
            : file.lifecycle === 'projection' ? 'project'
              : file.lifecycle === 'summary' ? 'merge'
                : file.lifecycle === 'conditional-governance' ? 'move-layer'
                  : 'retain',
                replacementTestIds: file.replacementTestIds,
                coverageIds: file.coverageIds
            })),
            duplicatePhysicalExecutions: testRecords
                .filter((record) => record.observedTierInvocationCount > 1)
                .map((record) => ({
                    id: record.id,
                    canonicalOwner: record.canonicalOwner,
                    observedTierInvocationCount: record.observedTierInvocationCount
                }))
        }
    };
}

export function renderLifecycleMatrix(report)
{
    const rows = report.decisions
        .map((entry) => `| \`${entry.file}\` | ${entry.action} | ${entry.replacementTestIds.join('<br>') || '-'} | ${entry.coverageIds.join('<br>') || '-'} |`);
    return [
        '# Test lifecycle candidate matrix',
        '',
        '> Generated by `node tools/check-test-lifecycle.mjs`; elapsed time and recent failure age are diagnostic only.',
        '',
        '| File | Decision | Replacement IDs | Coverage IDs |',
        '|---|---|---|---|',
        ...rows,
        ''
    ].join('\n');
}

export function classifyNodeRegistryEntry(root, file, source)
{
    const staticGovernance = fs.readFileSync(path.join(root, 'tools/test/lanes/static-governance.sh'), 'utf8');
    const workflowSources = fs.readdirSync(path.join(root, '.github/workflows'))
        .filter((name) => /\.ya?ml$/u.test(name))
        .map((name) => [name, fs.readFileSync(path.join(root, '.github/workflows', name), 'utf8')]);
    const frontendPackage = JSON.parse(fs.readFileSync(path.join(root, 'src/frontend/package.json'), 'utf8'));
    const token = path.basename(file);
    const classifications = [];
    if (/readFileSync|readFile\(|fs\.readFile/u.test(source))
    {
        classifications.push('source-text');
    }
    if (/compatib|legacy|wrapper/iu.test(source))
    {
        classifications.push('compatibility-wrapper');
    }
    if (/migration/iu.test(source))
    {
        classifications.push('migration');
    }
    if (/benchmark|performance|budget|throughput/iu.test(source))
    {
        classifications.push('perf');
    }
    if (/spawn|child_process|docker|postgres|redis/iu.test(source))
    {
        classifications.push('runtime');
    }
    if (classifications.length === 0)
    {
        classifications.push('behavior');
    }
    if (staticGovernance.includes(token))
    {
        return { owner: 'repository-governance:static-node-contracts', executionCategory: 'repository-governance', lifecycle: 'canonical-execution', physicalExecutionCount: 1, classifications };
    }
    const workflow = workflowSources.find(([, text]) => text.includes(token));
    if (workflow)
    {
        return { owner: `workflow-lint:${workflow[0]}`, executionCategory: 'workflow-only', lifecycle: 'conditional-governance', physicalExecutionCount: 1, classifications };
    }
    const script = Object.entries(frontendPackage.scripts ?? {}).find(([, command]) => String(command).includes(token));
    if (script)
    {
        return { owner: `package-script:${script[0]}`, executionCategory: 'package-script', lifecycle: 'canonical-execution', physicalExecutionCount: 1, classifications };
    }
    return {
        owner: `manual-diagnostic:${file}`,
        executionCategory: 'manual-diagnostic',
        lifecycle: 'manual-diagnostic',
        physicalExecutionCount: 0,
        classifications
    };
}
