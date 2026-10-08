#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseRepositoryClaims } from './doc-claim.mjs';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const readJson = (repositoryRoot, relative) => JSON.parse(readFileSync(path.join(repositoryRoot, relative), 'utf8'));
const sorted = (values) => [...values].sort();
const pairKey = (behaviorId, documentPath) => `${behaviorId}\0${documentPath}`;

function sameSet(left, right)
{
    return JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
}

function exactFields(value, keys, label)
{
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || !sameSet(Object.keys(value), keys))
    {
        throw new Error(`${label} has unsupported or missing fields`);
    }
}

function exactIds(actual, expected, label)
{
    if (!Array.isArray(actual) || actual.some((id) => typeof id !== 'string')
        || new Set(actual).size !== actual.length || !sameSet(actual, expected))
    {
        throw new Error(`${label} are not exact`);
    }
}

export function validateCatalogDocumentAuthoritiesData({ ledger, catalog, lifecycle, claims, sectionCatalog })
{
    const required = catalog.contracts.filter((contract) => contract.status === 'active'
        && contract.documentationPolicy === 'required' && (Object.hasOwn(contract, 'documentAuthorities')
            || ['protocol', 'release', 'deployment'].includes(contract.domain)));
    const entries = ledger.scopes.flatMap((scope) => scope.entries);
    const ownedClaims = new Set();
    const ownedSections = new Set();
    let authorityCount = 0;
    for (const contract of required)
    {
        if (!Array.isArray(contract.documentAuthorities))
        {
            throw new Error(`${contract.id} document authorities are invalid`);
        }
        exactIds(contract.documentAuthorities.map((authority) => authority.path), contract.documents,
            `${contract.id} document authority paths`);
        for (const authority of contract.documentAuthorities)
        {
            exactFields(authority, ['path', 'owner', 'anchor', 'claimIds', 'sectionIds', 'proofIds'],
                `${contract.id} document authority`);
            const current = lifecycle.documents.filter((document) => document.path === authority.path);
            if (current.length !== 1 || current[0].status !== 'current' || current[0].owner !== authority.owner
                || lifecycle.pathMigrations?.some((migration) => migration.from === authority.path))
            {
                throw new Error(`${contract.id} document authority ${authority.path} conflicts with current lifecycle owner`);
            }
            const bound = entries.filter((entry) => entry.behaviorId === contract.id && entry.documentPath === authority.path);
            if (bound.length !== 1)
            {
                throw new Error(`${contract.id} ${authority.path} requires exactly one ledger authority`);
            }
            const entry = bound[0];
            const parsedIds = claims.filter((claim) => claim.declaration.behaviorId === contract.id
                && claim.location.documentPath === authority.path && claim.location.documentStatus === 'current')
                .map((claim) => claim.declaration.claimId);
            const sectionIds = sectionCatalog.sections.filter((section) => section.behaviorId === contract.id
                && section.documentPath === authority.path).map((section) => section.sectionId);
            exactIds(authority.claimIds, entry.claimIds, `${contract.id} ${authority.path} catalog/ledger claim IDs`);
            exactIds(authority.claimIds, parsedIds, `${contract.id} ${authority.path} catalog/DocClaim IDs`);
            exactIds(authority.sectionIds, entry.generatedSectionIds, `${contract.id} ${authority.path} catalog/ledger section IDs`);
            exactIds(authority.sectionIds, sectionIds, `${contract.id} ${authority.path} catalog/generated section IDs`);
            for (const [ids, seen, label] of [[authority.claimIds, ownedClaims, 'claim'], [authority.sectionIds, ownedSections, 'section']])
            {
                for (const id of ids)
                {
                    if (seen.has(id)) throw new Error(`duplicate catalog ${label} owner ${id}`);
                    seen.add(id);
                }
            }
            authorityCount += 1;
        }
    }
    const behaviorIds = new Set(required.map((contract) => contract.id));
    exactIds([...ownedClaims], entries.filter((entry) => behaviorIds.has(entry.behaviorId)).flatMap((entry) => entry.claimIds),
        'reverse ledger/catalog claim IDs');
    exactIds([...ownedSections], entries.filter((entry) => behaviorIds.has(entry.behaviorId)).flatMap((entry) => entry.generatedSectionIds),
        'reverse ledger/catalog section IDs');
    return { authorityCount, claimCount: ownedClaims.size, sectionCount: ownedSections.size };
}

export function validateMigrationLedgerData({ ledger, catalog, lifecycle, claims, sectionCatalog })
{
    if (ledger?.schema !== 'fsusblog.document-claim-migration-ledger.v1' || !Array.isArray(ledger.scopes))
    {
        throw new Error('migration ledger schema is invalid');
    }
    exactFields(ledger, ['schema', 'scopes'], 'migration ledger');
    for (const scope of ledger.scopes)
    {
        exactFields(scope, ['scopeId', 'behaviorIds', 'entries'], 'migration scope');
        for (const entry of scope.entries)
        {
            exactFields(entry, ['behaviorId', 'documentPath', 'claimIds', 'generatedSectionIds'], 'migration entry');
        }
    }
    const currentDocuments = new Set(lifecycle.documents.filter((entry) => entry.status === 'current').map((entry) => entry.path));
    const contracts = new Map(catalog.contracts.map((contract) => [contract.id, contract]));
    const claimsById = new Map(claims.map((claim) => [claim.declaration.claimId, claim]));
    const sectionsById = new Map(sectionCatalog.sections.map((section) => [section.sectionId, section]));
    const scopeIds = new Set();
    const requiredBehaviorIds = catalog.contracts
        .filter((contract) => contract.status === 'active' && contract.documentationPolicy === 'required')
        .map((contract) => contract.id);
    const ledgerBehaviorIds = ledger.scopes.flatMap((scope) => scope.behaviorIds);
    if (!sameSet(requiredBehaviorIds, ledgerBehaviorIds)
        || new Set(ledgerBehaviorIds).size !== ledgerBehaviorIds.length)
    {
        throw new Error('migration ledger behavior roster does not exactly match active required BehaviorCatalog contracts');
    }
    const ledgerClaimIds = new Set();
    const ledgerSectionIds = new Set();

    for (const scope of ledger.scopes)
    {
        if (scopeIds.has(scope.scopeId))
        {
            throw new Error(`duplicate migration scope ${scope.scopeId}`);
        }
        scopeIds.add(scope.scopeId);
        const expectedPairs = [];
        for (const behaviorId of scope.behaviorIds)
        {
            const contract = contracts.get(behaviorId);
            if (!contract || contract.status !== 'active' || contract.documentationPolicy !== 'required')
            {
                throw new Error(`${scope.scopeId} references non-required active behavior ${behaviorId}`);
            }
            for (const documentPath of contract.documents)
            {
                if (!currentDocuments.has(documentPath))
                {
                    throw new Error(`${documentPath} is not current`);
                }
                expectedPairs.push(pairKey(behaviorId, documentPath));
            }
        }
        const actualPairs = scope.entries.map((entry) => pairKey(entry.behaviorId, entry.documentPath));
        if (!sameSet(expectedPairs, actualPairs) || new Set(actualPairs).size !== actualPairs.length)
        {
            throw new Error(`${scope.scopeId} ledger does not exactly match BehaviorCatalog current documents`);
        }
        for (const entry of scope.entries)
        {
            if (!currentDocuments.has(entry.documentPath))
            {
                throw new Error(`${entry.documentPath} is not a current lifecycle authority`);
            }
            const expectedClaims = claims
                .filter((claim) => claim.declaration.behaviorId === entry.behaviorId
                    && claim.location.documentPath === entry.documentPath
                    && claim.location.documentStatus === 'current')
                .map((claim) => claim.declaration.claimId);
            if (!sameSet(expectedClaims, entry.claimIds)
                || new Set(entry.claimIds).size !== entry.claimIds.length)
            {
                throw new Error(`${entry.documentPath} claims do not exactly match ledger`);
            }
            for (const claimId of entry.claimIds)
            {
                if (ledgerClaimIds.has(claimId))
                {
                    throw new Error(`duplicate ledger claim ${claimId}`);
                }
                ledgerClaimIds.add(claimId);
                const claim = claimsById.get(claimId);
                if (!claim || claim.declaration.behaviorId !== entry.behaviorId || claim.location.documentPath !== entry.documentPath)
                {
                    throw new Error(`${entry.documentPath} missing bound claim ${claimId}`);
                }
                if (claim.location.documentStatus !== 'current')
                {
                    throw new Error(`${claimId} is bound to stale lifecycle authority ${claim.location.documentStatus}`);
                }
            }
            const expectedSections = sectionCatalog.sections
                .filter((section) => section.behaviorId === entry.behaviorId && section.documentPath === entry.documentPath)
                .map((section) => section.sectionId);
            if (!sameSet(expectedSections, entry.generatedSectionIds))
            {
                throw new Error(`${entry.documentPath} generated sections do not exactly match ledger`);
            }
            for (const sectionId of entry.generatedSectionIds)
            {
                if (ledgerSectionIds.has(sectionId))
                {
                    throw new Error(`duplicate ledger generated section ${sectionId}`);
                }
                ledgerSectionIds.add(sectionId);
                const section = sectionsById.get(sectionId);
                if (!section)
                {
                    throw new Error(`missing generated section ${sectionId}`);
                }
                const claimOwnsSection = entry.claimIds.some((claimId) => claimsById.get(claimId)?.declaration.generatedSectionId === sectionId);
                if (!claimOwnsSection)
                {
                    throw new Error(`${sectionId} has no ledger-bound DocClaim`);
                }
            }
            for (const claimId of entry.claimIds)
            {
                const declaration = claimsById.get(claimId).declaration;
                if (declaration.claimType === 'generated-section'
                    && !entry.generatedSectionIds.includes(declaration.generatedSectionId))
                {
                    throw new Error(`${claimId} generated claim is missing its ledger section`);
                }
                if (declaration.claimType !== 'generated-section' && declaration.generatedSectionId != null)
                {
                    throw new Error(`${claimId} prose claim cannot own a generated section`);
                }
            }
        }
    }
    const requiredClaims = claims.filter((claim) => requiredBehaviorIds.includes(claim.declaration.behaviorId)
        && claim.location.documentStatus === 'current');
    if (!sameSet(requiredClaims.map((claim) => claim.declaration.claimId), [...ledgerClaimIds]))
    {
        throw new Error('migration ledger claims are not bidirectionally exact');
    }
    const requiredSections = sectionCatalog.sections
        .filter((section) => requiredBehaviorIds.includes(section.behaviorId))
        .map((section) => section.sectionId);
    if (!sameSet(requiredSections, [...ledgerSectionIds]))
    {
        throw new Error('migration ledger generated sections are not bidirectionally exact');
    }
    validateCatalogDocumentAuthoritiesData({ ledger, catalog, lifecycle, claims, sectionCatalog });
    return {
        scopeCount: ledger.scopes.length,
        entryCount: ledger.scopes.reduce((sum, scope) => sum + scope.entries.length, 0),
        requiredBehaviorCount: requiredBehaviorIds.length,
        generatedClaimCount: requiredClaims.filter((claim) => claim.declaration.claimType === 'generated-section').length,
        proseClaimCount: requiredClaims.filter((claim) => claim.declaration.claimType !== 'generated-section').length
    };
}

export function validateRepositoryMigrationLedger(repositoryRoot = root)
{
    return validateMigrationLedgerData({
        ledger: readJson(repositoryRoot, 'config/contracts/document-claim-migration-ledger.json'),
        catalog: readJson(repositoryRoot, 'config/contracts/behavior-contracts.json'),
        lifecycle: readJson(repositoryRoot, 'config/development/document-lifecycle.json'),
        claims: parseRepositoryClaims(repositoryRoot).claims,
        sectionCatalog: readJson(repositoryRoot, 'config/contracts/generated-fact-sections.json')
    });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    try
    {
        const result = validateRepositoryMigrationLedger(root);
        console.log(`[document-claim-migration-ledger] ok scopes=${result.scopeCount} entries=${result.entryCount}`);
    }
    catch (error)
    {
        console.error(`[document-claim-migration-ledger] ${error.message}`);
        process.exitCode = 1;
    }
}
