import assert from 'node:assert/strict';
import process from 'node:process';
import test from 'node:test';

const { locateInheritedCgroupV2Membership } = await import(new URL('../../tools/test/linux-cgroup-membership-locator.mjs', import.meta.url));
const { sampleLinuxCgroupV2HeadroomBytes } = await import(new URL('../../tools/test/system-memory.mjs', import.meta.url));

function fixture()
{
    const files = new Map([
        ['/proc/self/cgroup', '0::/'],
        ['/proc/self/mountinfo', '1 0 0:40 /.. /visible ro - cgroup2 cgroup rw'],
        ['/visible/cgroup.type', 'domain'],
        ['/visible/init/cgroup.type', 'domain'],
        ['/visible/init/cgroup.procs', String(process.pid)],
        ['/visible/other/cgroup.type', 'domain'],
        ['/visible/other/cgroup.procs', '999999999'],
        ['/visible/init/memory.max', 'max'],
        ['/visible/init/memory.current', '40'],
        ['/visible/memory.max', '1000'],
        ['/visible/memory.current', '300']
    ]);
    const reads = [];
    const options = {
        membership: '/', mountRoot: '/..', mountPath: '/visible',
        readText: (file) =>
        {
            reads.push(file);
            if (!files.has(file))
            {
                throw Object.assign(new Error('missing ' + file), { code: 'ENOENT' });
            }
            return files.get(file);
        },
        listChildren: () => ['init', 'other'],
        observeDirectory: (directory) => ({ directory: true, canonicalPath: directory, device: 40 })
    };
    return { files, reads, options };
}

test('Inherited locator accepts only the observed static namespace shape', () =>
{
    for (const changed of [{ membership: '/leaf' }, { mountRoot: '/' },
        { mountRoot: '/../sibling' }, { mountPath: '/visible/../escape' }])
    {
        assert.throws(() => locateInheritedCgroupV2Membership({ ...fixture().options, ...changed }),
            /unsupported namespace shape|invalid mount path/u);
    }
    assert.throws(() => locateInheritedCgroupV2Membership({
        ...fixture().options, listChildren: () => ['../escape']
    }), /invalid child component/u);
    assert.throws(() => locateInheritedCgroupV2Membership({
        ...fixture().options, listChildren: () => Array.from({ length: 65 }, (_, index) => `child${index}`)
    }), /incomplete or ambiguous child view/u);
});

test('Inherited locator returns only the unique real PID location', () =>
{
    const { options, reads } = fixture();
    assert.deepEqual(locateInheritedCgroupV2Membership(options), {
        mount: '/visible', leaf: '/visible/init', unmapped: false, requiredAncestors: true
    });
    assert.ok(reads.every((file) => !file.includes('/memory.')));
});

test('Inherited locator rejects missing required location data', () =>
{
    for (const file of ['/visible/cgroup.type', '/visible/init/cgroup.type', '/visible/other/cgroup.procs'])
    {
        const { options, files } = fixture();
        files.delete(file);
        assert.throws(() => locateInheritedCgroupV2Membership(options), /cannot read/u);
    }
    const { options, files } = fixture();
    files.set('/visible/init/cgroup.procs', '999999999');
    assert.throws(() => locateInheritedCgroupV2Membership(options), /missing or ambiguous self membership/u);
});

test('Inherited locator rejects ambiguous self membership', () =>
{
    const { options, files } = fixture();
    files.set('/visible/other/cgroup.procs', String(process.pid));
    assert.throws(() => locateInheritedCgroupV2Membership(options), /missing or ambiguous self membership/u);
});

test('Inherited sampler retains visible parent headroom and refuses missing ancestors', () =>
{
    assert.equal(sampleLinuxCgroupV2HeadroomBytes(fixture().options), 700);
    for (const file of ['/visible/memory.max', '/visible/memory.current', '/visible/init/memory.max'])
    {
        const { options, files } = fixture();
        files.delete(file);
        assert.throws(() => sampleLinuxCgroupV2HeadroomBytes(options), /unobservable required ancestor/u);
    }
});
