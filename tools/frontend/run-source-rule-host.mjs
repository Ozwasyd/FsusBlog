#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
    buildFrontendStaticOwnerRegistry,
    validateFrontendStaticOwnerRegistry
} from './frontend-static-owner-registry.mjs';
import { fontSizeContractRule } from './rules/font-size-contract.mjs';
import { fontWeightContractRule } from './rules/font-weight-contract.mjs';
import {
    buildFrontendSourceIndex,
    sourceIndexEvidence,
    validateFrontendSourceIndex
} from './source-index.mjs';
import {
    executeSourceRules,
    validateRuleHostEvidence
} from './source-rule-host.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const defaultEvidenceRoot = path.join(repoRoot, '.tmp/frontend/source-rule-host');
const rules = [fontSizeContractRule, fontWeightContractRule];
const legacyCommands = new Map([
    ['font-size-contract', 'tests/frontend/checks/static/check-font-size-contract.mjs'],
    ['font-weight-contract', 'tests/frontend/checks/static/check-font-weight-contract.mjs']
]);

function sha256(value)
{
    return crypto.createHash('sha256').update(value).digest('hex');
}

function stable(value)
{
    if (Array.isArray(value))
    {
        return value.map(stable);
    }
    if (value && typeof value === 'object')
    {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
    }
    return value;
}

function evidenceDigest(value)
{
    return sha256(JSON.stringify(stable(value)));
}

function atomicJson(target, value)
{
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temporary = `${target}.next-${process.pid}`;
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
    fs.renameSync(temporary, target);
}

function serializableReceipt(receipt)
{
    const serializable = { ...receipt };
    delete serializable.ruleCompatibility;
    return serializable;
}

function runLegacyProcesses()
{
    return rules.map((rule) =>
    {
        const script = legacyCommands.get(rule.id);
        const result = spawnSync(process.execPath, [script], {
            cwd: repoRoot,
            encoding: 'utf8',
            env: process.env
        });
        return {
            ruleId: rule.id,
            processCount: 1,
            status: result.status === 0 ? 'pass' : 'fail',
            exitCode: result.status,
            signal: result.signal,
            stdoutDigest: sha256(result.stdout ?? ''),
            stderrDigest: sha256(result.stderr ?? '')
        };
    });
}

async function buildEquivalenceEvidence(index, hostedReceipts, registry)
{
    const legacyProcesses = runLegacyProcesses();
    const legacyMetrics = rules.map((rule) => rule.legacyMetrics(index));
    const metricTotal = (field) => legacyMetrics.reduce((sum, metrics) => sum + metrics[field], 0);
    const conclusions = [];
    for (const rule of rules)
    {
        const direct = await rule.evaluate(index);
        const hosted = hostedReceipts.find(({ ruleId }) => ruleId === rule.id);
        const directFindings = direct.findings.sort((left, right) => left.id.localeCompare(right.id));
        const directDigest = evidenceDigest(directFindings);
        conclusions.push({
            ruleId: rule.id,
            legacyProcessStatus: legacyProcesses.find((entry) => entry.ruleId === rule.id).status,
            directModuleStatus: directFindings.length === 0 ? 'pass' : 'fail',
            hostedStatus: hosted.status,
            directFindingIdentityDigest: directDigest,
            hostedFindingIdentityDigest: evidenceDigest(hosted.findings),
            equivalent: (directFindings.length === 0 ? 'pass' : 'fail') === hosted.status
        && directDigest === evidenceDigest(hosted.findings)
        });
    }
    return {
        schema: 'fsusblog.frontend-source-rule-migration-evidence.v1',
        sourceIdentity: {
            commit: index.identity.commit,
            worktreeFingerprint: index.identity.worktreeFingerprint,
            runId: index.identity.runId,
            inputTreeDigest: index.identity.inputTreeDigest
        },
        scope: {
            migratedRuleIds: rules.map(({ id }) => id),
            completeFrontendStaticCommandInventoryCount: registry.summary.commandCount,
            retainedRulesAreUnchanged: true
        },
        before: {
            nodeProcessCount: registry.summary.commandCount,
            migratedRuleNodeProcessCount: legacyProcesses.reduce((sum, entry) => sum + entry.processCount, 0),
            migratedRuleSourceInventoryCount: metricTotal('inventoryCount'),
            migratedRuleSourceReadCount: metricTotal('readCount'),
            migratedRuleSourcePrimaryParseCount: metricTotal('primaryParseCount'),
            legacyProcesses
        },
        after: {
            nodeProcessCount: registry.summary.commandCount - rules.length + 1,
            migratedRuleNodeProcessCount: 1,
            migratedRuleSourceInventoryCount: index.metrics.inventoryCount,
            migratedRuleSourceReadCount: index.metrics.readCount,
            migratedRuleSourcePrimaryParseCount: index.metrics.primaryParseCount
        },
        conclusions,
        conclusionEquivalent: conclusions.every(({ equivalent }) => equivalent)
    };
}

export async function runSourceRuleHost({
    evidenceRoot = process.env.FSUSBLOG_FRONTEND_SOURCE_RULE_EVIDENCE_ROOT || defaultEvidenceRoot
} = {})
{
    const index = buildFrontendSourceIndex({ repoRoot });
    const indexErrors = validateFrontendSourceIndex(index);
    if (indexErrors.length > 0)
    {
        throw new Error(indexErrors.join('; '));
    }

    const registry = buildFrontendStaticOwnerRegistry({ repoRoot });
    const registryErrors = validateFrontendStaticOwnerRegistry(registry);
    if (registryErrors.length > 0)
    {
        throw new Error(registryErrors.join('; '));
    }

    const hosted = await executeSourceRules({ index, rules });
    const hostErrors = validateRuleHostEvidence(hosted, index, {
        expectedRuleIds: rules.map(({ id }) => id)
    });
    const migration = await buildEquivalenceEvidence(index, hosted.receipts, registry);

    atomicJson(path.join(evidenceRoot, 'source-index.json'), sourceIndexEvidence(index));
    atomicJson(path.join(evidenceRoot, 'owner-registry.json'), registry);
    atomicJson(path.join(evidenceRoot, 'rule-host.json'), {
        ...hosted,
        receipts: hosted.receipts.map(serializableReceipt)
    });
    for (const receipt of hosted.receipts)
    {
        atomicJson(path.join(evidenceRoot, 'receipts', `${receipt.ruleId}.json`), serializableReceipt(receipt));
    }
    atomicJson(path.join(evidenceRoot, 'migration-before-after.json'), migration);

    if (hostErrors.length > 0)
    {
        throw new Error(hostErrors.join('; '));
    }
    if (hosted.status !== 'pass')
    {
        throw new Error(`frontend source rule host failed: ${hosted.receipts
            .filter(({ status }) => status !== 'pass')
            .map(({ ruleId, status }) => `${ruleId}=${status}`)
            .join(', ')}`);
    }
    if (!migration.conclusionEquivalent)
    {
        throw new Error('frontend source rule migration conclusions differ');
    }
    return { index, registry, hosted, migration, evidenceRoot };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain)
{
    runSourceRuleHost().then(({ index, registry, hosted, migration, evidenceRoot }) =>
    {
        console.log(
            `[frontend-source-rule-host] ok rules=${hosted.receipts.length}`
      + ` inventory=${index.metrics.inventoryCount}`
      + ` reads=${index.metrics.readCount}`
      + ` parses=${index.metrics.primaryParseCount}`
      + ` processes=${migration.before.nodeProcessCount}->${migration.after.nodeProcessCount}`
      + ` registry=${registry.summary.commandCount}`
      + ` evidence=${path.relative(repoRoot, evidenceRoot)}`
        );
    }).catch((error) =>
    {
        console.error(`[frontend-source-rule-host] ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    });
}
