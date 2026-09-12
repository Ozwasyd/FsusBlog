#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const serviceRoot = 'src/backend/Services/Authoring';
const engineFile = `${serviceRoot}/AuthoringCanvasOperationEngine.cs`;
const transactionFile = `${serviceRoot}/PostgresAuthoringCanvasOperationTransaction.cs`;
const verifierFile = `${serviceRoot}/AuthoringCanvasOperationVerifier.cs`;
const authorities = new Map([
    ['AuthoringCanvasOperationEngine', engineFile],
    ['PostgresAuthoringCanvasOperationTransaction', transactionFile],
    ['AuthoringCanvasOperationVerifier', verifierFile]
]);

function walk(directory, extensions)
{
    if (!existsSync(directory))
    {
        return [];
    }
    const files = [];
    const pending = [directory];
    while (pending.length > 0)
    {
        const current = pending.pop();
        for (const entry of readdirSync(current, { withFileTypes: true }))
        {
            const absolute = path.join(current, entry.name);
            if (entry.isDirectory())
            {
                pending.push(absolute);
            }
            else if (entry.isFile() && extensions.some((extension) => entry.name.endsWith(extension)))
            {
                files.push(absolute);
            }
        }
    }
    return files.sort();
}

function codeOnly(source)
{
    return source
        .replace(/\/\*[\s\S]*?\*\//gu, '')
        .replace(/\/\/.*$/gmu, '');
}

function count(source, pattern)
{
    return (source.match(pattern) ?? []).length;
}

export function checkAuthoringCanvasOperationAuthority(repositoryRoot = root)
{
    const violations = [];
    const backendFiles = walk(path.join(repositoryRoot, serviceRoot), ['.cs']);
    const sources = new Map(backendFiles.map((absolute) => [
        path.relative(repositoryRoot, absolute),
        readFileSync(absolute, 'utf8')
    ]));

    for (const [className, expectedFile] of authorities)
    {
        const declaration = new RegExp(`\\bclass\\s+${className}\\b`, 'u');
        const owners = [...sources]
            .filter(([, source]) => declaration.test(codeOnly(source)))
            .map(([relative]) => relative);
        if (owners.length !== 1 || owners[0] !== expectedFile)
        {
            violations.push(
                `expected exact-one ${className} in ${expectedFile}, found ${owners.join(', ') || '<none>'}`);
        }
    }

    if (![engineFile, transactionFile, verifierFile].every((relative) => sources.has(relative)))
    {
        return violations;
    }
    const engine = codeOnly(sources.get(engineFile));
    const transaction = codeOnly(sources.get(transactionFile));
    const verifier = codeOnly(sources.get(verifierFile));
    const operationSources = [...sources]
        .filter(([relative]) => /AuthoringCanvasOperation|PostgresAuthoringCanvasOperation/u.test(relative))
        .map(([, source]) => codeOnly(source))
        .join('\n');

    if (count(engine, /documentStore\.ReadNodesAsync\s*\(/gu) !== 1
        || count(engine, /documentStore\.ReadEdgesAsync\s*\(/gu) !== 1)
    {
        violations.push(`${engineFile}: engine must load one bounded full canvas snapshot path`);
    }
    if (!/\bUndoAsync\s*\(/u.test(engine)
        || !/\bRedoAsync\s*\(/u.test(engine)
        || !/\bInverseFacts\b/u.test(engine))
    {
        violations.push(`${engineFile}: undo and redo must stay canvas-local and use sealed inverse facts`);
    }
    if (!/:\s*IAuthoringCanvasOperationTransaction\b/u.test(transaction)
        || !/\bUseTranAsync\s*\(/u.test(transaction)
        || !/\bpg_try_advisory_xact_lock\b/u.test(transaction))
    {
        violations.push(`${transactionFile}: transaction must be the atomic canvas-local adapter`);
    }
    if (![
        'CreateReference',
        'PinTargetRevision',
        'UnpinTargetRevision'
    ].every((kind) => transaction.includes(`AuthoringCanvasOperationKind.${kind}`)))
    {
        violations.push(`${transactionFile}: create, pin, and unpin must all require reference evidence`);
    }
    if (!/\bReadReceiptsAsync\s*\(/u.test(transaction)
        || !/\bValidateStoredReceipt\s*\(\s*ReadReceipt\s*\(/u.test(transaction)
        || !/\bComputeReceiptDigest\s*\(/u.test(transaction))
    {
        violations.push(`${transactionFile}: stored receipts must be readable and digest-validated`);
    }
    if (!/\bAuthoringCanvasOperationReceipt\b/u.test(verifier)
        || !/\bVerifyEntry\s*\(/u.test(verifier)
        || !/\bInverseFacts\b/u.test(verifier))
    {
        violations.push(`${verifierFile}: verifier must replay sealed facts and verify receipts independently`);
    }
    if (/\bnew\s+AuthoringCanvasOperationEngine\b/u.test(verifier)
        || /\b(?:transaction|documentStore|db)\s*\.\s*(?:Commit|ReadHistory|ReadJournal|Execute|UseTran)/u
            .test(verifier))
    {
        violations.push(`${verifierFile}: verifier must not call the engine, transaction, or database authority`);
    }

    if (/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:article|relation|property|workspace)\b/iu
        .test(operationSources)
        || /\b(?:article|relation|property|workspace)\w*\s*\.\s*(?:Create|Update|Delete|Put|Upsert|Insert|Remove|Save|Commit)(?:Async)?\s*\(/iu
            .test(operationSources))
    {
        violations.push('canvas operations must not mutate article, relation, property, or workspace authorities');
    }
    if (/\b(?:full_snapshot|snapshot_payload|FullSnapshot|SnapshotPayload)\b/u.test(transaction)
        || /JsonSerializer\.Serialize\s*\([^)]*snapshot/iu.test(transaction))
    {
        violations.push(`${transactionFile}: undo history must not persist full-canvas snapshots`);
    }

    const clientFiles = walk(path.join(repositoryRoot, 'src/frontend'), ['.ts', '.tsx', '.js', '.vue']);
    for (const absolute of clientFiles)
    {
        const relative = path.relative(repositoryRoot, absolute);
        const source = codeOnly(readFileSync(absolute, 'utf8'));
        if (!/(?:AuthoringCanvasOperation|canvasOperation|canvas[-_ ]operation)/iu.test(source))
        {
            continue;
        }
        if (/(?:\bfor\s*\(|\.forEach\s*\(|\bwhile\s*\()[\s\S]{0,600}?\b(?:applyOperation|commitOperation|ApplyAsync|CommitAsync)\s*\(/iu
            .test(source)
            || /\b(?:canvasNodes|canvasEdges|commands)\s*\.\s*(?:push|splice|pop|shift|unshift)\s*\(/iu
                .test(source))
        {
            violations.push(`${relative}: client-side command loops or canvas array mutations are forbidden`);
        }
        if (/\b(?:localUndo|localRedo|undoStack|redoStack|canvasHistory)\b[\s\S]{0,300}?(?:push|pop|localStorage)/iu
            .test(source))
        {
            violations.push(`${relative}: client-local undo authority is forbidden`);
        }
        if (/CreateReference[\s\S]{0,600}?(?:CreateEdge|AuthoringCanvasEdge|OperationKind\.Connect)/u
            .test(source))
        {
            violations.push(`${relative}: reference creation must not auto-link or forge relation semantics`);
        }
    }

    return violations;
}

if (process.argv[1] === fileURLToPath(import.meta.url))
{
    const violations = checkAuthoringCanvasOperationAuthority();
    if (violations.length > 0)
    {
        console.error('[authoring-canvas-operation-authority] failed');
        for (const violation of violations)
        {
            console.error(`- ${violation}`);
        }
        process.exitCode = 1;
    }
    else
    {
        console.log('[authoring-canvas-operation-authority] passed: exact-one engine/transaction/verifier, sealed local undo, atomic full-snapshot CAS, receipt verification, and no cross-authority writes');
    }
}
