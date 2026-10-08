#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readTemporalLedger } from './temporal-context.mjs';
import { readTemporalDomainProducerInventory } from './temporal-role-resolver.mjs';
import {
    readTemporalShapeCatalog,
    verifyAuthSessionPolicyRoles
} from './temporal-shape-catalog.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const testingConfigRoot = path.join(repositoryRoot, 'config/testing');
const temporalProducerBindingsPath = path.join(
    testingConfigRoot,
    'temporal-producer-bindings.json'
);

function fail(message)
{
    throw new Error(`temporal.governance-invalid: ${message}`);
}

function readJson(file)
{
    return JSON.parse(readFileSync(file, 'utf8'));
}

function jsonFiles(root)
{
    const files = [];
    const visit = (directory) =>
    {
        for (const entry of readdirSync(directory, { withFileTypes: true }))
        {
            const absolute = path.join(directory, entry.name);
            if (entry.isDirectory())
            {
                visit(absolute);
            }
            else if (entry.name.endsWith('.json'))
            {
                files.push(absolute);
            }
        }
    };
    visit(root);
    return files;
}

export function verifyTemporalShapeGovernance({
    catalogState = readTemporalShapeCatalog(),
    producerInventory = readTemporalDomainProducerInventory(),
    temporalProducerBindings = readJson(temporalProducerBindingsPath),
    configFiles = jsonFiles(testingConfigRoot),
    sourceOverrides = new Map(),
    temporalLedger = readTemporalLedger().document
} = {})
{
    const catalogAuthorities = [];
    for (const file of configFiles)
    {
        let document;
        try
        {
            document = readJson(file);
        }
        catch
        {
            continue;
        }
        if (document.schema === 'fsusblog.temporal-shape-catalog.v1'
          || Array.isArray(document.roleRegistry)
          || Array.isArray(document.shapes) && document.shapes.some((shape) =>
              Array.isArray(shape?.timestampRoles)))
        {
            catalogAuthorities.push(path.relative(repositoryRoot, file).replaceAll(path.sep, '/'));
        }
    }
    if (catalogAuthorities.length !== 1
      || catalogAuthorities[0] !== 'config/testing/temporal-shape-catalog.json')
    {
        fail(`exactly one temporal scenario/role authority is required: ${catalogAuthorities.join(', ')}`);
    }

    for (const shape of catalogState.catalog.shapes)
    {
        const offsets = new Set(shape.timestampRoles.map((role) => role.offsetMilliseconds));
        if (shape.timestampRoles.length > 2 && offsets.size === 1)
        {
            fail(`${shape.id} collapses every business field to one timestamp`);
        }
        if (shape.timestampRoles.some((role) =>
            !Number.isSafeInteger(role.offsetMilliseconds)))
        {
            fail(`${shape.id} uses random/fractional microsecond offsets`);
        }
    }
    verifyAuthSessionPolicyRoles(catalogState);

    const authProducerSource = sourceOverrides.get('tests/frontend/support/session-fixtures.mjs')
        ?? readFileSync(path.join(repositoryRoot, 'tests/frontend/support/session-fixtures.mjs'), 'utf8');
    const sessionPolicyBindings = [
        [
            'remember-me idle expiry',
            /rememberMe\s*\?\s*'session\.persistent-idle-expiry'\s*:\s*'session\.idle-expiry'/u
        ],
        [
            'remember-me absolute expiry',
            /rememberMe\s*\?\s*'session\.persistent-absolute-expiry'\s*:\s*'session\.absolute-expiry'/u
        ]
    ];
    for (const [label, pattern] of sessionPolicyBindings)
    {
        if (!pattern.test(authProducerSource))
        {
            fail(`tests/frontend/support/session-fixtures.mjs lacks exact ${label} role selection`);
        }
    }

    const authEndpointSource = sourceOverrides.get(
        'src/backend/Modules/Endpoints/LocalAuthFixtureEndpoints.cs'
    ) ?? readFileSync(
        path.join(repositoryRoot, 'src/backend/Modules/Endpoints/LocalAuthFixtureEndpoints.cs'),
        'utf8'
    );
    if (!/RequireInstant\("session\.persistent-idle-expiry"\)/u.test(authEndpointSource))
    {
        fail('LocalAuthFixtureEndpoints must bind the remember-me cookie to persistent idle expiry');
    }

    const bindingByProducer = new Map(temporalProducerBindings.producerBindings
        .map((binding) => [binding.producerId, binding]));
    const knownRoles = catalogState.roleIds;
    for (const producer of producerInventory.producerBindings)
    {
        const binding = bindingByProducer.get(producer.producerId);
        if (binding?.semanticRoleCarrier !== 'FSUSBLOG_RESOLVED_TEMPORAL_ROLES_JSON'
          || binding?.semanticRoleReceiptCarrier !== 'temporal-domain-producer-receipt.json')
        {
            fail(`${producer.producerId} lacks the canonical semantic role carriers`);
        }
        for (const mapping of producer.fieldMappings)
        {
            if (!knownRoles.has(mapping.roleId))
            {
                fail(`${producer.producerId}.${mapping.field} references unknown role ${mapping.roleId}`);
            }
        }
        for (const source of producer.implementations)
        {
            const text = sourceOverrides.get(source)
                ?? readFileSync(path.join(repositoryRoot, source), 'utf8');
            let semanticSource = text.replace(
                /generatedAt:\s*new Date\(\)\.toISOString\(\)/gu,
                'generatedAt: ARTIFACT_METADATA_CLOCK'
            );
            // The ledger owns exact, reviewed readiness delays. Business expiry
            // and unregistered waits remain forbidden; no file-wide exemption.
            for (const entry of temporalLedger.entries)
            {
                if (entry.path !== source || entry.api !== 'Task.Delay'
                    || entry.clockKind !== 'monotonic-measurement'
                    || entry.disposition !== 'monotonic-measurement'
                    || entry.authorityKind !== 'runtime-monotonic'
                    || entry.ingress !== 'runtime-monotonic' || entry.semanticEffect !== 'excluded')
                {
                    continue;
                }
                const anchor = entry.sourceAnchor;
                const first = text.indexOf(anchor);
                if (first < 0 || text.indexOf(anchor, first + anchor.length) >= 0
                    || [...anchor.matchAll(/\bTask\.Delay\s*\(/gu)].length !== 1)
                {
                    continue;
                }
                semanticSource = semanticSource.replace(anchor,
                    anchor.replace(/\bTask\.Delay\s*\(/u, 'REGISTERED_MONOTONIC_READINESS('));
            }
            const banned = [
                ['host Date.now', /\bDate\.now\s*\(\s*\)/u],
                ['host new Date', /\bnew\s+Date\s*\(\s*\)/u],
                ['host DateTime clock', /\bDateTime(?:Offset)?\.(?:UtcNow|Now|Today)\b/u],
                ['SQL wall clock', /\b(?:NOW\s*\(\s*\)|CURRENT_TIMESTAMP|clock_timestamp\s*\(\s*\))/iu],
                ['private epoch', /\b(?:CANONICAL_BUSINESS_EPOCH|BusinessNowUtc)\b/u],
                ['private offset arithmetic', /\.(?:AddMilliseconds|AddSeconds|AddMinutes|AddHours|AddDays)\s*\(/u],
                ['private SQL interval', /\binterval\s+'[^']+'/iu],
                ['real sleep', /(?:\bsleep\s+[0-9]|\bThread\.Sleep\s*\(|\bTask\.Delay\s*\()/u],
                ['random timestamp suffix', /(?:microsecond|random-millisecond|random timestamp)/iu]
            ].filter(([, pattern]) => pattern.test(semanticSource));
            if (banned.length > 0)
            {
                fail(`${source} retains ${banned.map(([label]) => label).join(', ')}`);
            }
        }
    }

    const resolverFiles = configFiles.filter((file) =>
        path.basename(file).includes('temporal-role-resolver'));
    if (resolverFiles.length > 0)
    {
        fail('temporal resolver configuration must not create a second resolver authority');
    }

    return Object.freeze({
        catalogDigest: catalogState.catalogDigest,
        producerCount: producerInventory.producerBindings.length,
        roleCount: catalogState.roleIds.size,
        shapeCount: catalogState.shapeIds.size,
        secondAuthorityCount: 0,
        residualPrivateClockCount: 0
    });
}

if (process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    const result = verifyTemporalShapeGovernance();
    process.stdout.write(`${JSON.stringify(result)}\n`);
}
