import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { discoverBoundedChannels, discoverUnboundedChannels, validateBoundedChannelCatalog } from '../../tools/governance/bounded-channel-contracts.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const factorySource = `namespace Queues;
public static class Factory {
    public static Channel<int> Build() => Channel.CreateBounded<int>(new BoundedChannelOptions(1) {
        FullMode = BoundedChannelFullMode.Wait
    });
}`;

function crossFileSources()
{
    return new Map([
        ['src/backend/Factory.cs', factorySource],
        ['src/backend/Outer.cs', 'namespace Queues; public static class Outer { public static Channel<int> Build() { return Factory.Build(); } }'],
        ['src/backend/Owner.cs', `namespace Queues;
public class Owner {
    private readonly Channel<int> _direct = Factory.Build();
    private readonly Channel<int> _indirect = Outer.Build();
}`]
    ]);
}

test('cross-file factories bind the assigned owner and complete creation provenance', () =>
{
    const discovered = discoverBoundedChannels({ sources: crossFileSources() });
    assert.deepEqual(discovered.map(({ discoveryKey, creationKind, fullMode }) => ({ discoveryKey, creationKind, fullMode })), [
        { discoveryKey: 'src/backend/Owner.cs#Owner._direct', creationKind: 'wrapped', fullMode: 'Wait' },
        { discoveryKey: 'src/backend/Owner.cs#Owner._indirect', creationKind: 'indirect', fullMode: 'Wait' }
    ]);
    assert.deepEqual(discovered[1].factorySources, [
        { file: 'src/backend/Outer.cs', ownerType: 'Outer', factory: 'Build', line: 1 },
        { file: 'src/backend/Factory.cs', ownerType: 'Factory', factory: 'Build', line: 3 }
    ]);
    const reversed = new Map([...crossFileSources()].reverse());
    assert.deepEqual(discoverBoundedChannels({ sources: reversed }), discovered);
});

test('an uncataloged cross-file factory owner is rejected by the validator', () =>
{
    const errors = validateBoundedChannelCatalog(undefined, { sources: crossFileSources() });
    assert.ok(errors.includes('bounded channel missing from catalog: src/backend/Owner.cs#Owner._direct'));
    assert.ok(errors.includes('bounded channel missing from catalog: src/backend/Owner.cs#Owner._indirect'));
});

test('same method names on unrelated types do not acquire bounded ownership', () =>
{
    const sources = crossFileSources();
    sources.set('src/backend/Other.cs', `namespace Queues;
public class Other {
    private int Build() => 42;
    private int _number;
    public Other() { _number = Build(); }
}`);
    assert.equal(discoverBoundedChannels({ sources }).length, 2);
});

test('fully qualified factories resolve duplicate type names in other namespaces', () =>
{
    const sources = new Map([
        ['src/One.cs', factorySource.replace('namespace Queues;', 'namespace One;')],
        ['src/Two.cs', factorySource.replace('namespace Queues;', 'namespace Two;')],
        ['src/Owner.cs', 'namespace Consumer; public class Owner { Channel<int> _queue = One.Factory.Build(); }']
    ]);
    const [queue] = discoverBoundedChannels({ sources });
    assert.equal(queue.discoveryKey, 'src/Owner.cs#Owner._queue');
    assert.equal(queue.factorySources[0].file, 'src/One.cs');
});

test('ambiguous cross-file factory calls fail closed instead of guessing an owner', () =>
{
    const sources = new Map([
        ['src/One.cs', factorySource.replace('namespace Queues;', 'namespace One;')],
        ['src/Two.cs', factorySource.replace('namespace Queues;', 'namespace Two;')],
        ['src/Owner.cs', 'namespace Consumer; public class Owner { Channel<int> _queue = Factory.Build(); }']
    ]);
    assert.throws(() => discoverBoundedChannels({ sources }), /src\/Owner.cs:1 channel factory call Factory.Build is ambiguous/u);
});

test('partial type factories resolve unqualified calls across files', () =>
{
    const sources = new Map([
        ['src/Factory.cs', 'namespace Queues; public partial class Owner { private static Channel<int> Build() => Channel.CreateBounded<int>(1); }'],
        ['src/Owner.cs', 'namespace Queues; public partial class Owner { Channel<int> _queue = Build(); }']
    ]);
    const [queue] = discoverBoundedChannels({ sources });
    assert.equal(queue.discoveryKey, 'src/Owner.cs#Owner._queue');
    assert.equal(queue.factorySources[0].file, 'src/Factory.cs');
});

test('generic cross-file factory calls retain their assigned owner', () =>
{
    const sources = new Map([
        ['src/Factory.cs', 'public static class Factory { public static Channel<T> Build<T>() => Channel.CreateBounded<T>(1); }'],
        ['src/Owner.cs', 'public class Owner { Channel<int> _queue = Factory.Build<int>(); }']
    ]);
    const [queue] = discoverBoundedChannels({ sources });
    assert.equal(queue.discoveryKey, 'src/Owner.cs#Owner._queue');
    assert.equal(queue.factorySources[0].file, 'src/Factory.cs');
});

test('unassigned cross-file bounded creation fails closed', () =>
{
    const sources = crossFileSources();
    sources.set('src/backend/Owner.cs', 'namespace Queues; public class Owner { public Owner() { Factory.Build(); } }');
    assert.throws(() => discoverBoundedChannels({ sources }), /bounded factory call has no stable assignment owner/u);
});

test('masked comments and strings do not create cross-file factory owners', () =>
{
    const sources = crossFileSources();
    sources.set('src/backend/Owner.cs', `namespace Queues; public class Owner {
        // Channel<int> _comment = Factory.Build();
        private const string Example = "Channel<int> _literal = Outer.Build();";
    }`);
    assert.deepEqual(discoverBoundedChannels({ sources }), []);
});

test('real source unbounded discovery is enforced without caller-supplied fixtures', () =>
{
    const forbidden = discoverUnboundedChannels();
    assert.deepEqual(forbidden, [{ file: 'src/backend/Infrastructure/Audit/AuditLogChannel.cs', line: 60 }]);
    assert.deepEqual(validateBoundedChannelCatalog(), [
        'unbounded channel is forbidden: src/backend/Infrastructure/Audit/AuditLogChannel.cs:60'
    ]);
});

for (const receipt of [false, true])
{
    test(`default CLI rejects real unbounded source${receipt ? ' before producing a receipt' : ''}`, () =>
    {
        const args = ['tools/governance/bounded-channel-contracts.mjs', ...(receipt ? ['--receipt'] : [])];
        const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' });
        assert.equal(result.error, undefined);
        assert.equal(result.status, 1);
        assert.equal(result.stdout, '');
        assert.equal(result.stderr.trim(), 'unbounded channel is forbidden: src/backend/Infrastructure/Audit/AuditLogChannel.cs:60');
    });
}
