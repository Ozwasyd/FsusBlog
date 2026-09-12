import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    checkRevisionCompareAuthority,
    checkRevisionCompareAuthoritySources,
    readRevisionCompareSources
} from '../../tools/governance/check-revision-compare-authority.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function sources()
{
    return new Map(readRevisionCompareSources(root));
}

function diagnostics(mutator)
{
    const fixture = sources();
    mutator(fixture);
    return checkRevisionCompareAuthoritySources(fixture).join('\n');
}

test('repository has one revision compare authority chain and closed admission guards', () =>
{
    assert.deepEqual(checkRevisionCompareAuthority(root), []);
});

test('second planner and package-reader authorities fail closed', () =>
{
    assert.match(
        diagnostics((fixture) => fixture.set(
            'src/core/Services/Articles/AlternativeRevisionComparePlanner.cs',
            'public sealed class AlternativeRevisionComparePlanner { }'
        )),
        /expected exact-one revision compare planner/u
    );
    assert.match(
        diagnostics((fixture) => fixture.set(
            'src/backend/Services/Authoring/AlternativeRevisionComparePackageReader.cs',
            'public sealed class AlternativeRevisionComparePackageReader : IRevisionComparePackageReader { }'
        )),
        /expected exact-one revision compare package reader/u
    );
});

test('rendered HTML, browser-local, latest-scan, and UI metadata authorities fail closed', () =>
{
    const forbidden = [
        [
            'src/backend/Services/Authoring/RenderedRevisionCompareAuthority.cs',
            'public sealed class RenderedRevisionCompareAuthority { string RenderedHtml; }',
            /rendered HTML or DOM authority/u
        ],
        [
            'src/frontend/src/revisionCompareLocal.ts',
            'export const revisionCompareLocal = localStorage.getItem("revision");',
            /browser-local authority/u
        ],
        [
            'src/backend/Services/Authoring/LatestRevisionCompareAuthority.cs',
            'public sealed class LatestRevisionCompareAuthority { void Read() => GetLatestRevision(); }',
            /latest revision scan/u
        ],
        [
            'src/frontend/src/revisionCompareMetadata.ts',
            'export const revisionCompareMetadata = {};',
            /UI metadata map/u
        ]
    ];

    for (const [relative, source, expected] of forbidden)
    {
        assert.match(diagnostics((fixture) => fixture.set(relative, source)), expected);
    }
});

test('cross-article guards and exact runtime registrations cannot be removed or duplicated', () =>
{
    assert.match(
        diagnostics((fixture) =>
        {
            const relative = 'src/core/Services/Articles/RevisionComparePlanner.cs';
            fixture.set(
                relative,
                fixture.get(relative).replace(
                    'basePackage.ArticleId != comparePackage.ArticleId',
                    'basePackage.ArticleId == comparePackage.ArticleId'
                )
            );
        }),
        /exact cross-article admission guard is required/u
    );
    assert.match(
        diagnostics((fixture) =>
        {
            const relative = 'src/backend/Infrastructure/Bootstrap/RuntimeDomainServiceCollectionExtensions.cs';
            const source = fixture.get(relative);
            fixture.set(
                relative,
                `${source}\nservices.AddScoped<RevisionComparePlanner>();\n`
            );
        }),
        /expected exact-one AddScoped<RevisionComparePlanner>; found 2/u
    );
});

test('metadata authority remains core-owned and exact-one', () =>
{
    assert.match(
        diagnostics((fixture) => fixture.set(
            'src/frontend/src/revisionCompareMetadataAuthority.ts',
            'export class RevisionCompareMetadataMap { }'
        )),
        /expected exact-one revision compare metadata authority/u
    );
});

test('checker source stays in the approved exclusive paths', () =>
{
    assert.ok(fs.existsSync(path.join(root, 'tools/governance/check-revision-compare-authority.mjs')));
    assert.ok(fs.existsSync(path.join(root, 'tests/tools/revision-compare-authority.test.mjs')));
});
