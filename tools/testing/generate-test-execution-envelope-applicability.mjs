#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parseMatrix } from '../test-matrix/parse-matrix.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const matrixFile = path.join(root, 'tests/matrix.yml');
const producerContractFile = path.join(
    root,
    'config/testing/producer-execution-class-contract.json'
);
const outputFile = path.join(
    root,
    'config/testing/test-execution-envelope-applicability.json'
);
const correctnessEvidenceClasses = new Set(['correctness', 'browser-contract']);
const observers = Object.freeze([
    ['browserRendering', 'browser-rendering-runtime', 'browser-runtime-identity'],
    ['directories', 'run-owned-directory-postflight', 'tools/test/execution-envelope-directories.mjs'],
    ['environment', 'minimal-child-environment', 'tools/test/execution-envelope-environment.mjs'],
    ['fontsLocale', 'font-locale-runtime', 'temporal-runtime-observation'],
    ['identity', 'planned-actual-envelope', 'tools/test-matrix/execution-envelope-policy.mjs'],
    ['network', 'sandbox-network-runtime', 'tools/test/execution-envelope-network.mjs'],
    ['platform', 'platform-runtime', 'physical-execution-authority'],
    ['resources', 'resource-limit-runtime', 'physical-execution-authority'],
    ['services', 'service-topology-runtime', 'tools/test/execution-envelope-services.mjs'],
    ['toolchain', 'executable-chain-identity', 'tools/test/execution-envelope-environment.mjs']
].map(([domain, id, implementationAuthority]) => ({
    id,
    domain,
    implementationAuthority
})));
const observerByDomain = new Map(observers.map((entry) => [entry.domain, entry.id]));

function evidenceClass(tier)
{
    return tier.evidenceClass ?? 'correctness';
}

function applicable(domain)
{
    return {
        status: 'required',
        observerId: observerByDomain.get(domain),
        notApplicableReason: null
    };
}

function notApplicable(domain, reason)
{
    return {
        status: 'not-applicable',
        observerId: null,
        notApplicableReason: reason
    };
}

function fieldApplicability(tier = {})
{
    const browserRequired = Boolean(tier.requiresPlaywright)
        && tier.requiresPlaywright !== 'none';
    const serviceRequired = (tier.services ?? []).length > 0
        || (tier.clusterFixtures ?? []).length > 0
        || !['', 'none'].includes(String(tier.coordinationStore ?? '').trim());
    return Object.fromEntries([
        ['platform', applicable('platform')],
        ['resources', applicable('resources')],
        ['environment', applicable('environment')],
        ['toolchain', applicable('toolchain')],
        ['browserRendering', browserRequired
            ? applicable('browserRendering')
            : notApplicable('browserRendering', 'matrix-requires-playwright-none')],
        ['services', serviceRequired
            ? applicable('services')
            : notApplicable('services', 'matrix-declares-no-services-or-coordination-store')],
        ['directories', applicable('directories')],
        ['network', applicable('network')],
        ['fontsLocale', applicable('fontsLocale')],
        ['identity', applicable('identity')]
    ]);
}

function allowedEnvironment(tier = {})
{
    const services = requiredServices(tier);
    return [
        'PATH',
        ...(tier.requiresDotnet ? ['DOTNET_ROOT'] : []),
        ...(tier.requiresPlaywright && tier.requiresPlaywright !== 'none'
            ? ['PLAYWRIGHT_BROWSERS_PATH']
            : []),
        ...(services.includes('postgres') ? ['FSUSBLOG_POSTGRES_PORT'] : []),
        ...(services.includes('redis') ? ['FSUSBLOG_REDIS_PORT'] : [])
    ].sort();
}

function requiredServices(tier = {})
{
    const values = new Set(tier.services ?? []);
    const coordinationStore = String(tier.coordinationStore ?? '').trim();
    if (!['', 'none'].includes(coordinationStore))
    {
        values.add(coordinationStore);
    }
    return [...values].sort();
}

function runnerInvocations(file)
{
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    if (file === 'config/governance/custom-rule-registry.json')
    {
        return JSON.parse(source).rules
            .map((rule) => String(rule.execution?.command ?? ''))
            .filter((command) => command.includes('run-deterministic-command.mjs'));
    }
    return [...source.matchAll(/run-deterministic-command\.mjs\b/gu)]
        .filter((match) => !source.slice(
            source.lastIndexOf('\n', match.index) + 1,
            match.index
        ).includes('--path'))
        .map((match) => source.slice(match.index, match.index + 1200));
}

function optionValue(invocation, name)
{
    const pattern = new RegExp(`--${name}\\s+(?:["']([^"']+)["']|([^\\s"'\\\\]+))`, 'u');
    return invocation.match(pattern)?.slice(1).find(Boolean) ?? null;
}

function canonicalRunnerProducerIds(producerContract)
{
    const values = [];
    for (const [file, expectedKeys] of Object.entries(
        producerContract?.canonicalRunnerInvocations ?? {}
    ))
    {
        const invocations = runnerInvocations(file);
        for (const key of expectedKeys)
        {
            const matches = invocations.filter((invocation) => optionValue(invocation, 'key') === key);
            if (matches.length !== 1)
            {
                throw new Error(`${file}: canonical runner ${key} must have exactly one invocation`);
            }
            const declaredProducerId = optionValue(matches[0], 'producer-id');
            if (!declaredProducerId)
            {
                throw new Error(`${file}: canonical runner ${key} lacks --producer-id`);
            }
            values.push(declaredProducerId.startsWith('$') ? key : declaredProducerId);
        }
    }
    return [...new Set(values)].sort();
}

export function generateApplicability(matrix, producerContract)
{
    const matrixProducers = matrix.tiers
        .filter((tier) => correctnessEvidenceClasses.has(evidenceClass(tier)))
        .map((tier) => ({
            producerId: tier.id,
            sourceKind: 'matrix-tier',
            policyId: 'correctness-hermetic-v1',
            evidenceClass: evidenceClass(tier),
            executionClass: tier.executionClass,
            allowedEnvironment: allowedEnvironment(tier),
            requiredServices: requiredServices(tier),
            fieldApplicability: fieldApplicability(tier)
        }));
    const matrixIds = new Set(matrixProducers.map((entry) => entry.producerId));
    const runnerProducers = canonicalRunnerProducerIds(producerContract)
        .filter((producerId) => !matrixIds.has(producerId))
        .map((producerId) => ({
            producerId,
            sourceKind: 'canonical-runner',
            policyId: 'correctness-hermetic-v1',
            evidenceClass: 'correctness',
            executionClass: 'static-governance',
            allowedEnvironment: allowedEnvironment(),
            requiredServices: [],
            fieldApplicability: fieldApplicability()
        }));
    const producers = [...matrixProducers, ...runnerProducers]
        .sort((left, right) => left.producerId.localeCompare(right.producerId));
    return {
        schema: 'fsusblog.test-execution-envelope-applicability.v1',
        version: 1,
        matrixSource: 'tests/matrix.yml',
        producerContractSource: 'config/testing/producer-execution-class-contract.json',
        generationFields: [
            'tier.id',
            'tier.evidenceClass',
            'tier.executionClass',
            'tier.requiresDotnet',
            'tier.requiresPlaywright',
            'tier.services',
            'tier.clusterFixtures',
            'tier.coordinationStore',
            'canonicalRunner.--producer-id'
        ],
        observers,
        producers,
        excludedEvidenceClasses: [
            {
                evidenceClass: 'diagnostic',
                reason: 'diagnostic producers are non-qualifying and cannot emit correctness evidence'
            }
        ]
    };
}

function serialized(value)
{
    return `${JSON.stringify(value, null, 4)}\n`;
}

function main(argv)
{
    const generated = serialized(generateApplicability(
        parseMatrix(fs.readFileSync(matrixFile, 'utf8')),
        JSON.parse(fs.readFileSync(producerContractFile, 'utf8'))
    ));
    if (argv.includes('--check'))
    {
        if (!fs.existsSync(outputFile) || fs.readFileSync(outputFile, 'utf8') !== generated)
        {
            throw new Error(
                'test execution envelope applicability catalog is stale; regenerate it'
            );
        }
        console.log('[execution-envelope-applicability] current');
        return;
    }
    fs.writeFileSync(outputFile, generated);
    console.log(`[execution-envelope-applicability] wrote ${path.relative(root, outputFile)}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href)
{
    main(process.argv.slice(2));
}
