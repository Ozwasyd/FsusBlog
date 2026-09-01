#!/usr/bin/env node
// Guards the single-source-of-truth relationship between the canonical
// SugarTable entities, the migration catalog definitions, and the schema
// verifier's allowedExtraTables allowlist.
//
// The server runtime must not reference the migration assembly (see
// check-migration-assembly-boundary.mjs), so s_allowedExtraTables is the
// server-side register of tables that exist outside the canonical entity
// set (migration-created runtime tables, schema state rows, statistics).
// Two drift modes must stay impossible:
//   1. a SugarTable entity also listed in allowedExtraTables (dead entry —
//      the verifier already sees the entity in the expected model);
//   2. a migration-created table without any entity, missing from the
//      allowlist (the verifier would reject it as a branded extra table).
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const argRootIndex = process.argv.indexOf('--root');
const root = resolve(
    argRootIndex >= 0 ? process.argv[argRootIndex + 1]
    : dirname(fileURLToPath(import.meta.url)), argRootIndex >= 0 ? '' : '../..'
);
const failures = [];

function fail(message) {
    failures.push(message);
}

function collectFileNames(dir, suffix) {
    const names = [];
    if (!existsSync(dir)) return names;
    for (const entry of readdirSync(dir)) {
        if (entry.endsWith(suffix)) {
            names.push(join(dir, entry));
        }
    }
    return names;
}

function sourceFilesRecursive(dir, suffix) {
    const files = [];
    if (!existsSync(dir)) return files;
    const stack = [dir];
    while (stack.length > 0) {
        const current = stack.pop();
        for (const entry of readdirSync(current, { withFileTypes: true })) {
            const full = join(current, entry.name);
            if (entry.isDirectory()) {
                stack.push(full);
            } else if (entry.isFile() && entry.name.endsWith(suffix)) {
                files.push(full);
            }
        }
    }
    return files;
}

// 1. All canonical entity table names (SugarTable attribute).
const entityTables = new Set();
for (const file of sourceFilesRecursive(join(root, 'src/backend'), '.cs')) {
    const src = readFileSync(file, 'utf8');
    for (const match of src.matchAll(/SugarTable\("([a-z_0-9]+)"\)/gu)) {
        entityTables.add(match[1]);
    }
}

// 2. All migration-created table names (CREATE TABLE / CREATE TABLE IF NOT EXISTS).
const migrationTables = new Set();
for (const file of collectFileNames(join(root, 'src/migration/Definitions'), '.cs')) {
    const src = readFileSync(file, 'utf8');
    for (const match of src.matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+([a-z_0-9]+)/gu)) {
        migrationTables.add(match[1]);
    }
}

// 3. The verifier allowlist.
const runnerPath = join(
    root,
    'src/backend/Infrastructure/SchemaMigration/SchemaMigrationRunner.cs'
);
const runnerSrc = readFileSync(runnerPath, 'utf8');
const allowedStart = runnerSrc.indexOf('s_allowedExtraTables =');
const allowedEnd = runnerSrc.indexOf('];', allowedStart);
if (allowedStart < 0 || allowedEnd < 0) {
    fail('SchemaMigrationRunner.cs: s_allowedExtraTables block not found');
    process.exitCode = 1;
    for (const issue of failures) process.stderr.write(`[schema-allowed-extra-tables] ${issue}\n`);
    process.exit(1);
}
const allowedTables = new Set();
for (const match of runnerSrc.slice(allowedStart, allowedEnd).matchAll(/"([a-z_0-9]+)"/gu)) {
    allowedTables.add(match[1]);
}

// Invariant 1: no dead entries (entity table also listed as allowed).
for (const table of allowedTables) {
    if (entityTables.has(table)) {
        fail(
            `${rel(runnerPath)}: "${table}" is a SugarTable entity; it must not be listed in `
            + 's_allowedExtraTables (the canonical expected model already covers it)'
        );
    }
}

// Invariant 2: no missing migration tables (migration-created, no entity,
// but absent from the allowlist).
for (const table of migrationTables) {
    if (!entityTables.has(table) && !allowedTables.has(table)) {
        fail(
            `${rel(runnerPath)}: migration-created table "${table}" has no SugarTable entity and `
            + 'is not listed in s_allowedExtraTables; the verifier would reject it as an extra table'
        );
    }
}

function rel(file) {
    return file.slice(root.length + 1).replaceAll('\\', '/');
}

if (failures.length > 0) {
    for (const issue of failures) process.stderr.write(`[schema-allowed-extra-tables] ${issue}\n`);
    process.exitCode = 1;
} else {
    process.stdout.write(
        `[schema-allowed-extra-tables] ok entities=${entityTables.size} migration=${migrationTables.size} allowed=${allowedTables.size}\n`
    );
}
