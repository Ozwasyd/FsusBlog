import assert from 'node:assert/strict';
import test from 'node:test';

import { AuditMacVaultObserver, ReadMacVaultObserver } from '../../tools/test/check-macos-vault-observer-source.mjs';

const sources = ReadMacVaultObserver(process.cwd());

test('actual observer source retains its read-only native boundary', () => {
    assert.deepEqual(AuditMacVaultObserver(sources.native, sources.managed), []);
});

for (const nativeMutation of [
    'write(1, "private body", 12);',
    'unlink("article.md");',
    'printf("private body");',
    'read(3, body, 32);',
    'open("article.md", O_RDWR | O_TRUNC);',
]) {
    test(`native observer rejects prohibited source mutation: ${nativeMutation.split('(')[0]}`, () => {
        assert.notEqual(AuditMacVaultObserver(`${sources.native}\n${nativeMutation}`, sources.managed).length, 0);
    });
}

for (const call of ['FSEventStreamStop(', 'FSEventStreamInvalidate(', 'dispatch_sync_f(',
    'FSEventStreamRelease(', 'dispatch_release(', 'close(vault->descriptor)', 'free(vault)']) {
    test(`native observer rejects missing teardown: ${call}`, () => {
        assert.ok(AuditMacVaultObserver(sources.native.replaceAll(call, 'RemovedLifecycleCall('), sources.managed)
            .includes('native-teardown-missing-or-unsafe-order'));
    });
}

test('raw facts cannot acquire a direct save or polling consumer', () => {
    for (const mutation of ['SaveLatest(fact);', 'File.ReadAllText(path);', 'Task.Delay(100);']) {
        const managed = { ...sources.managed,
            'MacVaultWatcherSession.cs': sources.managed['MacVaultWatcherSession.cs'] + mutation };
        assert.notEqual(AuditMacVaultObserver(sources.native, managed).length, 0);
    }
});

test('removing queue capacity or hiding overflow fails the source obligation', () => {
    for (const marker of ['_facts.Count >= capacity', '_overflow ??= fact', 'facts.Add(_overflow)']) {
        const managed = { ...sources.managed,
            'MacVaultRawFactBuffer.cs': sources.managed['MacVaultRawFactBuffer.cs'].replace(marker, 'RemovedBound') };
        assert.ok(AuditMacVaultObserver(sources.native, managed).includes('bounded-queue-or-preserved-overflow-required'));
    }
});
