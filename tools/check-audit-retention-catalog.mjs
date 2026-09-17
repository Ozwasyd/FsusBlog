#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';

const root = resolve(import.meta.dirname, '..');
const auditRecordPath = resolve(root, 'src/backend/Infrastructure/Audit/AuditRecord.cs');
const catalogPath = resolve(root, 'src/backend/Infrastructure/Audit/AuditRetentionCatalog.cs');
const cleanupPath = resolve(root, 'src/backend/Services/Background/LogCleanupService.cs');

const [auditRecord, catalog, cleanup] = await Promise.all([
    readFile(auditRecordPath, 'utf8'),
    readFile(catalogPath, 'utf8'),
    readFile(cleanupPath, 'utf8')
]);

const actionBlock = auditRecord.match(/public static class AuditActionCatalog\s*\{([\s\S]*?)\n\}/)?.[1];
if (!actionBlock)
{
    throw new Error('AuditActionCatalog was not found');
}

const constants = [...actionBlock.matchAll(/public const string\s+(\w+)\s*=\s*"([^"]+)"\s*;/g)];
if (constants.length === 0)
{
    throw new Error('AuditActionCatalog contains no machine-readable action constants');
}

const missing = constants
    .filter(([, name, value]) => !catalog.includes(`AuditActionCatalog.${name}`) && !catalog.includes(`"${value}"`))
    .map(([, name, value]) => `${name}=${value}`);

const requiredPolicyFields = [
    'MaxFullRecordAge',
    'MaxPseudonymAge',
    'AggregateAfter',
    'AnchorForever',
    'LegalHoldAllowed',
    'CryptographicEraseKeyDomain'
];
const missingFields = requiredPolicyFields.filter((field) => !catalog.includes(field));
const failures = [];
if (missing.length > 0)
{
    failures.push(`unregistered AuditActionCatalog values: ${missing.join(', ')}`);
}
if (missingFields.length > 0)
{
    failures.push(`missing policy fields: ${missingFields.join(', ')}`);
}
if (catalog.includes('TimeSpan.MaxValue') || /MaxFullRecordAge[^\n]*(forever|infinite)/i.test(catalog))
{
    failures.push('full-record retention must be finite');
}
if (!catalog.includes('audit_retention_policy_missing:'))
{
    failures.push('runtime unknown-action fail-closed gate is missing');
}
if (/is_high_value\s*=\s*false/i.test(cleanup) || /severity\s*<>/i.test(cleanup))
{
    failures.push('cleanup still permanently excludes high-value or Critical rows');
}
for (const surface of ['database', 'local-fallback', 'backup', 'wal', 'replica'])
{
    if (!catalog.includes(`"${surface}"`))
    {
        failures.push(`storage contract missing ${surface}`);
    }
}

if (failures.length > 0)
{
    for (const failure of failures)
    {
        console.error(`[audit-retention] ${failure}`);
    }
    process.exitCode = 1;
}
else
{
    console.log(`[audit-retention] ok: ${constants.length} declared actions, finite retention, storage contract present`);
}
