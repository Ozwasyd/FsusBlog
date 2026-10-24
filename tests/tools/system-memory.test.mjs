import assert from 'node:assert/strict';
import test from 'node:test';

const {
    availableMemoryBytes,
    parseDarwinMemoryPressureAvailableBytes,
    sampleLinuxCgroupV2HeadroomBytes
} = await import(new URL('../../tools/test/system-memory.mjs', import.meta.url));

test('Darwin memory pressure percentage resolves reusable memory', () =>
{
    assert.equal(
        parseDarwinMemoryPressureAvailableBytes('System-wide memory free percentage: 40%\n', 16 * 1024),
        6.4 * 1024
    );
});

test('Darwin available memory never undercuts the Node fallback', () =>
{
    assert.equal(availableMemoryBytes({
        platform: 'darwin',
        totalMemoryBytes: 16_000,
        fallbackFreeMemoryBytes: 2_000,
        darwinSampler: () => 1_000
    }), 2_000);
});

test('Darwin probe failure and non-Darwin hosts use the Node fallback', () =>
{
    let linuxSamples = 0;
    assert.equal(availableMemoryBytes({
        platform: 'darwin',
        totalMemoryBytes: 16_000,
        fallbackFreeMemoryBytes: 2_000,
        darwinSampler: () => null
    }), 2_000);
    assert.equal(availableMemoryBytes({
        platform: 'linux',
        totalMemoryBytes: 16_000,
        fallbackFreeMemoryBytes: 3_000,
        darwinSampler: () => 8_000,
        linuxSampler: () =>
        {
            linuxSamples += 1;
            return null;
        }
    }), 3_000);
    assert.equal(linuxSamples, 1);
});

test('Linux sampler failure never becomes the Node fallback', () =>
{
    const failure = new Error('Linux sample unavailable');
    assert.throws(() => availableMemoryBytes({
        platform: 'linux',
        fallbackFreeMemoryBytes: 3_000,
        linuxSampler: () =>
        {
            throw failure;
        }
    }), (error) => error === failure);
});

function linuxMemoryFixture({
    membership = '0::/init.scope',
    mountinfo = '1 0 0:40 / /sys/fs/cgroup rw - cgroup2 cgroup rw',
    controls = {}
} = {})
{
    const files = new Map([
        ['/proc/self/cgroup', membership],
        ['/proc/self/mountinfo', mountinfo],
        ['/sys/fs/cgroup/init.scope/memory.max', 'max'],
        ['/sys/fs/cgroup/init.scope/memory.current', '100'],
        ['/sys/fs/cgroup/memory.max', '4294967296'],
        ['/sys/fs/cgroup/memory.current', '2866802688'],
        ...Object.entries(controls)
    ]);
    const reads = [];
    const readText = (file) =>
    {
        reads.push(file);
        const value = files.get(file);
        if (value instanceof Error)
        {
            throw value;
        }
        if (value === undefined || value === null)
        {
            throw Object.assign(new Error('missing ' + file), { code: 'ENOENT' });
        }
        return typeof value === 'function' ? value() : value;
    };
    return { files, reads, readText };
}

function sampleFixture(options)
{
    return sampleLinuxCgroupV2HeadroomBytes(linuxMemoryFixture(options));
}

test('Linux unlimited leaf retains finite ancestor subtree headroom', () =>
{
    assert.equal(sampleFixture(), 1_428_164_608);
    for (const [free, expected] of [[7_000_000_000, 1_428_164_608], [1000, 1000]])
    {
        assert.equal(availableMemoryBytes({
            platform: 'linux',
            fallbackFreeMemoryBytes: free,
            linuxSampler: () => sampleFixture()
        }), expected);
    }
});

test('Linux walks every visible ancestor using each own subtree current', () =>
{
    const fixture = linuxMemoryFixture({
        membership: '0::/parent/leaf',
        controls: {
            '/sys/fs/cgroup/parent/leaf/memory.max': '8000',
            '/sys/fs/cgroup/parent/leaf/memory.current': '1000',
            '/sys/fs/cgroup/parent/memory.max': '10000',
            '/sys/fs/cgroup/parent/memory.current': '9000',
            '/sys/fs/cgroup/memory.max': 'max'
        }
    });
    assert.equal(sampleLinuxCgroupV2HeadroomBytes(fixture), 1000);
    assert.ok(fixture.reads.includes('/sys/fs/cgroup/parent/memory.current'));
    assert.ok(fixture.reads.includes('/sys/fs/cgroup/memory.max'));
});

test('Linux all unlimited ancestors and absent v2 preserve fallback', () =>
{
    assert.equal(sampleFixture({ controls: { '/sys/fs/cgroup/memory.max': 'max' } }), null);
    assert.equal(sampleFixture({ membership: '3:memory:/legacy' }), null);
    assert.equal(sampleFixture({
        mountinfo: '1 0 0:40 / /sys/fs/cgroup rw - cgroup cgroup rw'
    }), null);
    const absent = linuxMemoryFixture();
    absent.files.delete('/proc/self/cgroup');
    assert.equal(sampleLinuxCgroupV2HeadroomBytes(absent), null);
    assert.equal(availableMemoryBytes({
        platform: 'linux', fallbackFreeMemoryBytes: 500, linuxSampler: () => null
    }), 500);
    assert.equal(sampleFixture({ membership: '3:memory:/legacy\n0::/init.scope' }), 1_428_164_608);
});

test('Linux verifies non-root global and namespace-relative mapping by actual process membership', () =>
{
    const controls = {
        '/visible/leaf/memory.max': 'max',
        '/visible/leaf/memory.current': '40',
        '/visible/leaf/cgroup.procs': String(process.pid),
        '/visible/cgroup.procs': String(process.pid),
        '/visible/memory.max': '1000',
        '/visible/memory.current': '300'
    };
    const mountinfo = '1 0 0:40 /tenant /visible rw - cgroup2 cgroup rw';
    for (const membership of ['0::/tenant/leaf', '0::/leaf', '0::/'])
    {
        assert.equal(sampleFixture({ membership, mountinfo, controls }), 700);
    }
});

test('Linux decodes mount escapes and skips bind views not covering self', () =>
{
    assert.equal(sampleFixture({
        membership: '0::/',
        mountinfo: '1 0 0:40 / /visible\\040space rw - cgroup2 cgroup rw',
        controls: { '/visible space/memory.max': '1000', '/visible space/memory.current': '50' }
    }), 950);
    assert.equal(sampleFixture({
        mountinfo: '2 0 0:40 /unrelated /narrow rw - cgroup2 cgroup rw\n'
            + '1 0 0:40 / /sys/fs/cgroup rw - cgroup2 cgroup rw',
        controls: {
            '/narrow/init.scope/memory.max': '1',
            '/narrow/init.scope/memory.current': '1',
            '/narrow/init.scope/cgroup.procs': '999999999'
        }
    }), 1_428_164_608);
    assert.equal(sampleFixture({
        mountinfo: '2 0 0:40 /init.scope /narrow rw - cgroup2 cgroup rw\n'
            + '1 0 0:40 / /sys/fs/cgroup rw - cgroup2 cgroup rw',
        controls: { '/narrow/cgroup.procs': String(process.pid) }
    }), 1_428_164_608);
});

test('Linux directory existence and prefix collisions cannot prove namespace mapping', () =>
{
    const fixture = linuxMemoryFixture({
        membership: '0::/tenant2/leaf',
        mountinfo: '1 0 0:40 /tenant /visible rw - cgroup2 cgroup rw',
        controls: {
            '/visible/tenant2/leaf/memory.max': 'max',
            '/visible/tenant2/leaf/memory.current': '100',
            '/visible/tenant2/leaf/cgroup.procs': '999999999',
            '/visible/memory.max': '1000',
            '/visible/memory.current': '300'
        }
    });
    assert.throws(() => sampleLinuxCgroupV2HeadroomBytes(fixture),
        /unmapped membership.*visible headroom=700/u);
    assert.ok(fixture.reads.includes('/visible/memory.max'));
    assert.ok(!fixture.reads.includes('/visible/2/leaf/memory.max'));
});

test('Linux rejects ambiguous namespace mappings and contradictory verified roots', () =>
{
    const members = String(process.pid);
    assert.throws(() => sampleFixture({
        membership: '0::/tenant/leaf',
        mountinfo: '1 0 0:40 /tenant /visible rw - cgroup2 cgroup rw',
        controls: {
            '/visible/leaf/cgroup.procs': members,
            '/visible/tenant/leaf/cgroup.procs': members
        }
    }), /ambiguous namespace membership/u);
    assert.throws(() => sampleFixture({
        membership: '0::/leaf',
        mountinfo: '1 0 0:40 /one /visible rw - cgroup2 cgroup rw\n'
            + '2 0 0:40 /two /other rw - cgroup2 cgroup rw',
        controls: { '/visible/leaf/cgroup.procs': members, '/other/leaf/cgroup.procs': members }
    }), /ambiguous cgroup2 mount roots/u);
});

test('Linux rejects ambiguous membership hierarchies and malformed mapping', () =>
{
    const cases = [
        { membership: '0::/init.scope\n0::/other' },
        { membership: '0:memory:/init.scope' },
        { membership: '0::/../escape' },
        { membership: '0::/scope/./leaf' },
        { membership: '0::relative' },
        { mountinfo: '1 0 0:40 / /sys/fs/cgroup rw cgroup2 cgroup rw' },
        { mountinfo: '1 0 invalid / /sys/fs/cgroup rw - cgroup2 cgroup rw' },
        { mountinfo: '1 0 0:40 / /visible\\777 rw - cgroup2 cgroup rw' },
        { mountinfo: '1 0 0:40 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n'
            + '2 0 0:41 / /other rw - cgroup2 cgroup rw' }
    ];
    for (const fixture of cases)
    {
        assert.throws(() => sampleFixture(fixture), /Linux cgroup memory/u);
    }
    const missing = linuxMemoryFixture();
    missing.files.delete('/proc/self/mountinfo');
    assert.throws(() => sampleLinuxCgroupV2HeadroomBytes(missing), /missing mountinfo/u);
});

test('Linux missing leaf controller continues to finite root but missing leaf never means unlimited', () =>
{
    const fixture = linuxMemoryFixture({
        controls: {
            '/sys/fs/cgroup/init.scope/memory.max': null,
            '/sys/fs/cgroup/init.scope/memory.current': null,
            '/sys/fs/cgroup/init.scope/cgroup.procs': ''
        }
    });
    assert.equal(sampleLinuxCgroupV2HeadroomBytes(fixture), 1_428_164_608);
    fixture.files.delete('/sys/fs/cgroup/init.scope/cgroup.procs');
    assert.throws(() => sampleLinuxCgroupV2HeadroomBytes(fixture),
        /unmapped membership.*visible headroom=1428164608/u);
});

test('Linux finite ceilings require current and propagate permission and I/O failures', () =>
{
    for (const file of ['/proc/self/cgroup', '/proc/self/mountinfo',
        '/sys/fs/cgroup/init.scope/memory.max', '/sys/fs/cgroup/memory.current'])
    {
        for (const code of ['EACCES', 'EIO'])
        {
            const fixture = linuxMemoryFixture();
            fixture.files.set(file, Object.assign(new Error('denied'), { code }));
            assert.throws(() => sampleLinuxCgroupV2HeadroomBytes(fixture), (error) =>
            {
                assert.match(error.message, /cannot read/u);
                assert.equal(error.cause.code, code);
                return true;
            });
        }
    }
    assert.throws(() => sampleFixture({
        controls: { '/sys/fs/cgroup/memory.current': null }
    }), /invalid integer/u);
    assert.throws(() => sampleFixture({
        membership: '0::/leaf',
        mountinfo: '1 0 0:40 /tenant /visible rw - cgroup2 cgroup rw',
        controls: { '/visible/leaf/cgroup.procs': 'not-a-pid' }
    }), /invalid cgroup.procs/u);
});

test('Linux rejects migration and a limit disappearing during sampling', () =>
{
    let membershipReads = 0;
    const fixture = linuxMemoryFixture();
    fixture.files.set('/proc/self/cgroup', () =>
    {
        membershipReads += 1;
        return membershipReads === 1 ? '0::/init.scope' : '0::/other';
    });
    assert.throws(() => sampleLinuxCgroupV2HeadroomBytes(fixture), /membership changed/u);
    let limitReads = 0;
    fixture.files.set('/proc/self/cgroup', '0::/init.scope');
    fixture.files.set('/sys/fs/cgroup/memory.max', () =>
    {
        limitReads += 1;
        if (limitReads > 1)
        {
            throw Object.assign(new Error('removed'), { code: 'ENOENT' });
        }
        return '1000';
    });
    assert.throws(() => sampleLinuxCgroupV2HeadroomBytes(fixture), /limit disappeared/u);
});

test('Linux samples shrinking expanding and unlimited transitions conservatively', () =>
{
    for (const [before, after, expected] of [
        ['1000', '700', 500], ['700', '1000', 500], ['max', '700', 500], ['700', 'max', 500]
    ])
    {
        let reads = 0;
        assert.equal(sampleFixture({
            controls: {
                '/sys/fs/cgroup/memory.max': () =>
                {
                    reads += 1;
                    return reads === 1 ? before : after;
                },
                '/sys/fs/cgroup/memory.current': '200'
            }
        }), expected);
    }
});

test('Linux BigInt subtraction is exact and exhausted headroom stays zero', () =>
{
    assert.equal(sampleFixture({
        controls: {
            '/sys/fs/cgroup/memory.max': '18446744073709551615',
            '/sys/fs/cgroup/memory.current': '18446744073709551608'
        }
    }), 7);
    assert.equal(sampleFixture({
        controls: {
            '/sys/fs/cgroup/memory.max': '18446744073709551615',
            '/sys/fs/cgroup/memory.current': '0'
        }
    }), Number.MAX_SAFE_INTEGER);
    for (const usage of ['1000', '1001'])
    {
        assert.equal(sampleFixture({
            controls: { '/sys/fs/cgroup/memory.max': '1000', '/sys/fs/cgroup/memory.current': usage }
        }), 0);
    }
    assert.equal(availableMemoryBytes({
        platform: 'linux', fallbackFreeMemoryBytes: 1000, linuxSampler: () => 0
    }), 0);
});

test('Linux malformed and overflow values never become unrestricted memory', () =>
{
    for (const invalid of ['-1', '1.5', '', 'NaN', 'Infinity', '18446744073709551616'])
    {
        for (const file of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory.current'])
        {
            assert.throws(() => sampleFixture({ controls: { [file]: invalid } }),
                /invalid integer|integer overflow/u);
        }
    }
    for (const invalid of [-1, 1.5, NaN, Infinity, undefined])
    {
        assert.throws(() => availableMemoryBytes({
            platform: 'linux', fallbackFreeMemoryBytes: 1000, linuxSampler: () => invalid
        }), /invalid headroom/u);
    }
});

test('Linux unlimited usage need not be numeric but never hides finite parents', () =>
{
    assert.equal(sampleFixture({
        controls: { '/sys/fs/cgroup/init.scope/memory.current': 'unused' }
    }), 1_428_164_608);
    assert.throws(() => sampleFixture({
        controls: { '/sys/fs/cgroup/memory.current': 'unused' }
    }), /invalid integer/u);
});

test('Darwin and Windows never invoke the Linux reader', () =>
{
    const linuxSampler = () =>
    {
        throw new Error('unexpected Linux sample');
    };
    assert.equal(availableMemoryBytes({
        platform: 'win32', fallbackFreeMemoryBytes: 1000, linuxSampler
    }), 1000);
    assert.equal(availableMemoryBytes({
        platform: 'darwin', totalMemoryBytes: 2000, fallbackFreeMemoryBytes: 1000,
        darwinSampler: () =>
        {
            throw new Error('existing Darwin fallback');
        },
        linuxSampler
    }), 1000);
});

test('Linux missing intermediate controllers still retain a finite visible ancestor', () =>
{
    assert.equal(sampleFixture({
        membership: '0::/parent/leaf',
        controls: {
            '/sys/fs/cgroup/parent/leaf/memory.max': 'max',
            '/sys/fs/cgroup/parent/leaf/memory.current': '0'
        }
    }), 1_428_164_608);
});

test('Linux namespace proof permission failure and membership loss fail closed', () =>
{
    assert.throws(() => sampleFixture({
        membership: '0::/leaf',
        mountinfo: '1 0 0:40 /tenant /visible rw - cgroup2 cgroup rw',
        controls: {
            '/visible/leaf/cgroup.procs': Object.assign(new Error('denied'), { code: 'EACCES' })
        }
    }), /cannot read/u);
    let reads = 0;
    const fixture = linuxMemoryFixture();
    fixture.files.set('/proc/self/cgroup', () =>
    {
        reads += 1;
        if (reads > 1)
        {
            throw Object.assign(new Error('removed'), { code: 'ENOENT' });
        }
        return '0::/init.scope';
    });
    assert.throws(() => sampleLinuxCgroupV2HeadroomBytes(fixture), /membership changed/u);
});
