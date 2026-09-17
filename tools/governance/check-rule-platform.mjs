#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
    BuildComplexityBaseline,
    ComplexityPolicySchema,
    ComplexityViolations,
    DiscoverRules,
    ExemptionSchema,
    FileCategory,
    GlobToRegExp,
    MeasureComplexity,
    ReadJson,
    RegistrySchema,
    RepositoryInventory,
    SelectAffectedRules,
    StableJson,
    SummarySchema,
    ValidateExemptions,
    ValidateRegistry
} from './rule-platform.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const defaultRoot = path.resolve(path.dirname(scriptPath), '../..');
const defaultRegistry = 'config/governance/custom-rule-registry.json';
const defaultPolicy = 'config/governance/complexity-policy.json';
const defaultBaseline = 'config/governance/complexity-baseline.json';
const defaultExemptions = 'config/governance/complexity-exemptions.json';
const defaultSummary = '.tmp/governance/rule-platform-summary.json';

function ParseArguments(argv)
{
    const result = { mode: 'changed', files: [] };
    for (let index = 0; index < argv.length; index += 1)
    {
        const argument = argv[index];
        if (argument === '--write-registry' || argument === '--write-baseline')
        {
            result[argument.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())] = true;
            continue;
        }
        if (!['--root', '--mode', '--base', '--file', '--summary'].includes(argument))
        {
            throw new Error(`unknown argument ${argument}`);
        }
        const value = argv[index + 1];
        if (!value)
        {
            throw new Error(`${argument} requires a value`);
        }
        if (argument === '--file')
        {
            result.files.push(value);
        }
        else
        {
            result[argument.slice(2)] = value;
        }
        index += 1;
    }
    if (!['changed', 'full'].includes(result.mode))
    {
        throw new Error('--mode must be changed or full');
    }
    return result;
}

function ChangedFiles(root, base)
{
    const output = execFileSync('git', ['diff', '--name-only', '--diff-filter=ACMR', base, '--'], {
        cwd: root,
        encoding: 'utf8'
    });
    const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
        cwd: root,
        encoding: 'utf8'
    });
    return [...new Set(`${output}\n${untracked}`.split(/\r?\n/u).filter(Boolean))].sort();
}

function WriteJson(root, relative, value)
{
    const absolute = path.join(root, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, StableJson(value));
}

const args = ParseArguments(process.argv.slice(2));
const root = path.resolve(args.root ?? defaultRoot);
const registryPath = path.join(root, defaultRegistry);
const policyPath = path.join(root, defaultPolicy);
const baselinePath = path.join(root, defaultBaseline);
const exemptionsPath = path.join(root, defaultExemptions);
const summaryPath = args.summary ?? defaultSummary;
let summary = {
    schema: SummarySchema,
    status: 'running',
    mode: args.mode,
    authoritative: args.mode === 'full',
    sourceFingerprint: null,
    selectedRuleCount: 0,
    rules: [],
    inventory: null,
    violations: []
};

function PersistSummary(status)
{
    summary.status = status;
    WriteJson(root, summaryPath, summary);
}

for (const signal of ['SIGINT', 'SIGTERM'])
{
    process.once(signal, () =>
    {
        PersistSummary('cancelled');
        process.exit(signal === 'SIGINT' ? 130 : 143);
    });
}

try
{
    const policy = ReadJson(policyPath);
    if (policy.schema !== ComplexityPolicySchema)
    {
        throw new Error(`complexity policy schema must be ${ComplexityPolicySchema}`);
    }
    const inventory = new RepositoryInventory(root, policy.inventory.ignoredPaths);
    const discoveredRules = DiscoverRules(root, policy, inventory);
    if (args.writeRegistry)
    {
        WriteJson(root, defaultRegistry, {
            schema: RegistrySchema,
            generatedBy: 'tools/governance/check-rule-platform.mjs --write-registry',
            inventory: {
                packageScriptCount: discoveredRules.filter((rule) => rule.execution.mode === 'delegated-command').length,
                implementationCount: discoveredRules.filter((rule) => rule.execution.mode === 'delegated-implementation').length
            },
            rules: discoveredRules
        });
    }
    const registry = ReadJson(registryPath);
    const registryErrors = ValidateRegistry(root, registry, discoveredRules);
    if (registryErrors.length > 0)
    {
        summary.violations.push(...registryErrors.map((message) => ({ rule: 'Governance.RegistryIntegrity', message })));
    }
    let baseline;
    if (args.writeBaseline)
    {
        baseline = BuildComplexityBaseline(root, policy, inventory);
        WriteJson(root, defaultBaseline, baseline);
    }
    else
    {
        baseline = ReadJson(baselinePath);
    }
    const files = inventory.Files();
    const sourceFiles = files.filter((file) => policy.sourceExtensions.includes(path.posix.extname(file)));
    const complexityStarted = performance.now();
    const currentMetrics = Object.fromEntries(sourceFiles.map((file) => [
        file,
        MeasureComplexity(file, inventory.Read(file))
    ]));
    const exemptions = ReadJson(exemptionsPath);
    if (exemptions.schema !== ExemptionSchema)
    {
        summary.violations.push({ rule: 'Governance.ExemptionValidity', message: `exemption schema must be ${ExemptionSchema}` });
    }
    summary.violations.push(...ValidateExemptions(root, exemptions, currentMetrics).map((message) => ({
        rule: 'Governance.ExemptionValidity',
        message
    })));
    const changed = args.files.length > 0
        ? args.files
        : args.mode === 'full'
            ? sourceFiles
            : ChangedFiles(root, args.base ?? policy.changedDefaultBase);
    const selectedRules = args.mode === 'full' ? registry.rules : SelectAffectedRules(registry.rules, changed);
    summary.selectedRuleCount = selectedRules.length;
    summary.rules = selectedRules.map((rule) => ({
        id: rule.id,
        status: 'registered',
        engine: rule.engine,
        executionKey: rule.execution.executionKey,
        durationMs: 0,
        filesScanned: changed.filter((file) => rule.sourceScopes.some((scope) => GlobToRegExp(scope).test(file))).length,
        cacheHits: inventory.stats.contentCacheHits,
        violations: 0
    }));
    const complexityFiles = changed.filter((file) => currentMetrics[file]);
    summary.violations.push(...ComplexityViolations(policy, baseline, currentMetrics, exemptions, complexityFiles));
    summary.rules.push({
        id: 'Governance.ComplexityBudget',
        status: 'executed',
        engine: policy.complexityEngine.engine,
        textRationale: policy.complexityEngine.reason,
        durationMs: Number((performance.now() - complexityStarted).toFixed(3)),
        filesScanned: complexityFiles.length,
        cacheHits: inventory.stats.contentCacheHits,
        violations: summary.violations.filter((entry) => entry.rule === 'Governance.ComplexityBudget').length,
        categories: [...new Set(complexityFiles.map(FileCategory))].sort()
    });
    summary.sourceFingerprint = inventory.Fingerprint([
        defaultRegistry,
        defaultPolicy,
        defaultBaseline,
        defaultExemptions,
        ...changed.filter((file) => files.includes(file))
    ]);
    summary.inventory = inventory.stats;
    PersistSummary(summary.violations.length === 0 ? 'passed' : 'failed');
    if (summary.violations.length > 0)
    {
        for (const violation of summary.violations)
        {
            console.error(`[rule-platform] ${violation.rule}: ${violation.file ? `${violation.file}: ` : ''}${violation.message}`);
        }
        process.exitCode = 1;
    }
    else
    {
        console.log(`[rule-platform] ${args.mode} passed: ${selectedRules.length} registered rules, ${complexityFiles.length} complexity files, inventory=${inventory.stats.inventoryBuilds}, reads=${inventory.stats.contentReads}, cacheHits=${inventory.stats.contentCacheHits}`);
    }
}
catch (error)
{
    summary.violations.push({ rule: 'Governance.PlatformRuntime', message: error.message });
    PersistSummary('failed');
    console.error(`[rule-platform] ${error.stack ?? error.message}`);
    process.exitCode = 1;
}
