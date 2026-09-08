import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    checkAuthoringCanvasOperationAuthority
} from '../../tools/governance/check-authoring-canvas-operation-authority.mjs';

const root = path.resolve(import.meta.dirname, '../..');

function write(repositoryRoot, relative, source)
{
    const absolute = path.join(repositoryRoot, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, source);
}

function fixture(t)
{
    const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-canvas-operation-'));
    t.after(() => fs.rmSync(repositoryRoot, { recursive: true, force: true }));
    write(repositoryRoot, 'src/backend/Services/Authoring/AuthoringCanvasOperationEngine.cs', `
public sealed class AuthoringCanvasOperationEngine
{
    public void Apply()
    {
        documentStore.ReadNodesAsync();
        documentStore.ReadEdgesAsync();
        var facts = entry.InverseFacts;
    }
    public void UndoAsync() {}
    public void RedoAsync() {}
}
`);
    write(repositoryRoot, 'src/backend/Services/Authoring/PostgresAuthoringCanvasOperationTransaction.cs', `
public sealed class PostgresAuthoringCanvasOperationTransaction : IAuthoringCanvasOperationTransaction
{
    public void Commit()
    {
        db.Ado.UseTranAsync();
        var sql = "pg_try_advisory_xact_lock";
        var kinds = new[] {
            AuthoringCanvasOperationKind.CreateReference,
            AuthoringCanvasOperationKind.PinTargetRevision,
            AuthoringCanvasOperationKind.UnpinTargetRevision
        };
    }
    public void ReadReceiptsAsync()
    {
        ValidateStoredReceipt(ReadReceipt(reader));
        AuthoringCanvasOperationContract.ComputeReceiptDigest(receipt);
    }
}
`);
    write(repositoryRoot, 'src/backend/Services/Authoring/AuthoringCanvasOperationVerifier.cs', `
public static class AuthoringCanvasOperationVerifier
{
    public static void VerifyEntry(AuthoringCanvasOperationReceipt receipt)
    {
        var facts = entry.InverseFacts;
    }
}
`);
    return repositoryRoot;
}

function violations(repositoryRoot)
{
    return checkAuthoringCanvasOperationAuthority(repositoryRoot).join('\n');
}

test('repository canvas operation authority satisfies the static boundary', () =>
{
    assert.deepEqual(checkAuthoringCanvasOperationAuthority(root), []);
});

test('inline minimal authority has one atomic engine transaction and independent verifier', (t) =>
{
    assert.equal(violations(fixture(t)), '');
});

test('rejects second engine transaction and verifier authorities', (t) =>
{
    const repositoryRoot = fixture(t);
    write(repositoryRoot, 'src/backend/Services/Authoring/SecondOperationAuthority.cs', `
public class AuthoringCanvasOperationEngine {}
public class PostgresAuthoringCanvasOperationTransaction {}
public class AuthoringCanvasOperationVerifier {}
`);

    const result = violations(repositoryRoot);
    for (const name of [
        'AuthoringCanvasOperationEngine',
        'PostgresAuthoringCanvasOperationTransaction',
        'AuthoringCanvasOperationVerifier'
    ])
    {
        assert.match(result, new RegExp(`expected exact-one ${name}`, 'u'));
    }
});

test('rejects cross-authority writes and persisted full snapshots', (t) =>
{
    const repositoryRoot = fixture(t);
    fs.appendFileSync(
        path.join(repositoryRoot, 'src/backend/Services/Authoring/AuthoringCanvasOperationEngine.cs'),
        '\npublic class IllicitWrite { void Run() { articleStore.UpdateAsync(); } }\n');
    fs.appendFileSync(
        path.join(repositoryRoot, 'src/backend/Services/Authoring/PostgresAuthoringCanvasOperationTransaction.cs'),
        '\npublic class IllicitSnapshot { string snapshot_payload = "all"; }\n');

    const result = violations(repositoryRoot);
    assert.match(result, /must not mutate article, relation, property, or workspace authorities/u);
    assert.match(result, /must not persist full-canvas snapshots/u);
});

test('rejects verifier reuse of engine transaction or database authority', (t) =>
{
    const repositoryRoot = fixture(t);
    fs.appendFileSync(
        path.join(repositoryRoot, 'src/backend/Services/Authoring/AuthoringCanvasOperationVerifier.cs'),
        '\npublic class IllicitVerifierReuse { void Run() { var engine = new AuthoringCanvasOperationEngine(); transaction.ReadJournal(); } }\n');

    assert.match(violations(repositoryRoot), /must not call the engine, transaction, or database authority/u);
});

test('rejects an unpin path without reference evidence', (t) =>
{
    const repositoryRoot = fixture(t);
    const transaction = path.join(
        repositoryRoot,
        'src/backend/Services/Authoring/PostgresAuthoringCanvasOperationTransaction.cs');
    fs.writeFileSync(
        transaction,
        fs.readFileSync(transaction, 'utf8').replace(
            'AuthoringCanvasOperationKind.UnpinTargetRevision',
            'AuthoringCanvasOperationKind.PinTargetRevision'));

    assert.match(violations(repositoryRoot), /create, pin, and unpin must all require reference evidence/u);
});

test('rejects stored receipt reads without digest validation', (t) =>
{
    const repositoryRoot = fixture(t);
    const transaction = path.join(
        repositoryRoot,
        'src/backend/Services/Authoring/PostgresAuthoringCanvasOperationTransaction.cs');
    fs.writeFileSync(
        transaction,
        fs.readFileSync(transaction, 'utf8').replace(
            'ValidateStoredReceipt(ReadReceipt(reader));',
            'ReadReceipt(reader);'));

    assert.match(violations(repositoryRoot), /stored receipts must be readable and digest-validated/u);
});

test('rejects client command loops and reference auto-linking', (t) =>
{
    const repositoryRoot = fixture(t);
    write(repositoryRoot, 'src/frontend/canvas-operation.ts', `
export const canvasOperation = (commands) => {
    for (const command of commands) applyOperation(command);
};
const localUndo = [];
localUndo.push(canvasOperation);
export const autoLink = () => CreateReference() && OperationKind.Connect();
`);

    const result = violations(repositoryRoot);
    assert.match(result, /client-side command loops or canvas array mutations are forbidden/u);
    assert.match(result, /client-local undo authority is forbidden/u);
    assert.match(result, /reference creation must not auto-link/u);
});
