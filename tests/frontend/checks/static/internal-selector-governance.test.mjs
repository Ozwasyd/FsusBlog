import assert from 'node:assert/strict';
import test from 'node:test';

import {
    scanInternalSelectors,
    validateInternalSelectorMigrationEvidence,
    validateInternalSelectorRegistry
} from './internal-selector-governance-lib.mjs';

const registryEntry = (override = {}) => ({
    path: 'src/frontend/src/views/admin/Example.vue',
    selector: '.el-input__wrapper',
    kind: 'deep',
    occurrences: 1,
    owner: 'FsusUI',
    reason: 'Temporary geometry compatibility while the public hook is implemented.',
    expiresOn: '2026-09-30',
    replacementIssue: 'Ozwasyd/FsusUI#999',
    ...override
});

test('scanner preserves balanced deep selectors and finds direct Element Plus overrides', () =>
{
    const findings = scanInternalSelectors([{
        path: 'src/frontend/src/views/admin/Example.vue',
        source: `<style scoped>
      :deep(:where(.el-input, .el-select):focus-visible) { outline: none; }
      :deep (.consumer-generated-node) { display: block; }
      /* :deep(.retired-selector) { display: none; } */
      .el-button { min-height: 44px; }
    </style>`
    }]);

    assert.deepEqual(findings.map(({ kind, selector }) => ({ kind, selector })), [
        {
            kind: 'deep',
            selector: ':where(.el-input, .el-select):focus-visible'
        },
        {
            kind: 'deep',
            selector: '.consumer-generated-node'
        },
        {
            kind: 'direct-el',
            selector: '.el-button'
        }
    ]);
});

test('registry fails closed for unregistered selectors and budget drift', () =>
{
    const findings = scanInternalSelectors([{
        path: 'src/frontend/src/views/admin/Example.vue',
        source: '<style scoped>:deep(.el-input__wrapper){} :deep(.el-input__inner){}</style>'
    }]);
    const registry = {
        schema: 'fsusblog.internal-selector-registry.v1',
        maximumDeepOccurrences: 1,
        entries: [registryEntry()]
    };

    assert.deepEqual(
        validateInternalSelectorRegistry({ findings, registry, today: '2026-07-24' }),
        [
            'unregistered deep selector: src/frontend/src/views/admin/Example.vue :: .el-input__inner',
            'deep selector budget mismatch: registered 1, discovered 2'
        ]
    );
});

test('registry requires a budget reduction when selectors are removed', () =>
{
    const findings = scanInternalSelectors([{
        path: 'src/frontend/src/views/admin/Example.vue',
        source: '<style scoped>:deep(.el-input__wrapper){}</style>'
    }]);
    const registry = {
        schema: 'fsusblog.internal-selector-registry.v1',
        maximumDeepOccurrences: 2,
        maximumDirectElOccurrences: 0,
        entries: [registryEntry()]
    };

    assert.deepEqual(
        validateInternalSelectorRegistry({ findings, registry, today: '2026-07-24' }),
        ['deep selector budget mismatch: registered 2, discovered 1']
    );
});

test('direct Element Plus overrides require registration and their own budget', () =>
{
    const findings = scanInternalSelectors([{
        path: 'src/frontend/src/views/admin/Example.vue',
        source: '<style scoped>.el-button{} .el-input__wrapper{}</style>'
    }]);
    const registry = {
        schema: 'fsusblog.internal-selector-registry.v1',
        maximumDeepOccurrences: 0,
        maximumDirectElOccurrences: 1,
        entries: []
    };

    assert.deepEqual(
        validateInternalSelectorRegistry({ findings, registry, today: '2026-07-24' }),
        [
            'unregistered direct Element Plus selector: src/frontend/src/views/admin/Example.vue :: .el-button',
            'unregistered direct Element Plus selector: src/frontend/src/views/admin/Example.vue :: .el-input__wrapper',
            'direct Element Plus selector budget mismatch: registered 1, discovered 2'
        ]
    );
});

test('registry requires actionable metadata and a live expiry', () =>
{
    const findings = scanInternalSelectors([{
        path: 'src/frontend/src/views/admin/Example.vue',
        source: '<style scoped>:deep(.el-input__wrapper){}</style>'
    }]);
    const registry = {
        schema: 'fsusblog.internal-selector-registry.v1',
        maximumDeepOccurrences: 1,
        entries: [registryEntry({
            owner: '',
            reason: '',
            expiresOn: '2026-07-01',
            replacementIssue: ''
        })]
    };

    assert.deepEqual(
        validateInternalSelectorRegistry({ findings, registry, today: '2026-07-24' }),
        [
            'registry entry requires owner: src/frontend/src/views/admin/Example.vue :: .el-input__wrapper',
            'registry entry requires reason: src/frontend/src/views/admin/Example.vue :: .el-input__wrapper',
            'registry entry expired on 2026-07-01: src/frontend/src/views/admin/Example.vue :: .el-input__wrapper',
            'registry entry requires replacementIssue: src/frontend/src/views/admin/Example.vue :: .el-input__wrapper'
        ]
    );
});

test('path groups apply ownership metadata to every registered selector', () =>
{
    const findings = scanInternalSelectors([{
        path: 'src/frontend/src/views/admin/Example.vue',
        source: '<style scoped>:deep(.el-input__wrapper){} :deep(.el-input__inner){}</style>'
    }]);
    const base = registryEntry();
    const registry = {
        schema: 'fsusblog.internal-selector-registry.v1',
        maximumDeepOccurrences: 2,
        entries: [{
            path: base.path,
            owner: base.owner,
            reason: base.reason,
            expiresOn: base.expiresOn,
            replacementIssue: base.replacementIssue,
            selectors: [
                { kind: 'deep', selector: '.el-input__wrapper', occurrences: 1 },
                { kind: 'deep', selector: '.el-input__inner', occurrences: 1 }
            ]
        }]
    };

    assert.deepEqual(
        validateInternalSelectorRegistry({ findings, registry, today: '2026-07-24' }),
        []
    );
});

test('PublicShell internal selectors are never exempted', () =>
{
    const findings = scanInternalSelectors([{
        path: 'src/frontend/src/components/public/PublicBlogLayoutShell.vue',
        source: '<style scoped>:deep(.el-public-shell__main){}</style>'
    }]);
    const registry = {
        schema: 'fsusblog.internal-selector-registry.v1',
        maximumDeepOccurrences: 1,
        entries: [registryEntry({
            path: 'src/frontend/src/components/public/PublicBlogLayoutShell.vue',
            selector: '.el-public-shell__main'
        })]
    };

    assert.deepEqual(
        validateInternalSelectorRegistry({ findings, registry, today: '2026-07-24' }),
        [
            'PublicShell internal selector is forbidden: src/frontend/src/components/public/PublicBlogLayoutShell.vue :: .el-public-shell__main'
        ]
    );
});

test('migration evidence reconciles the baseline, reductions and current registry', () =>
{
    const registry = {
        maximumDeepOccurrences: 51,
        maximumDirectElOccurrences: 8
    };
    const evidence = {
        schema: 'fsusblog.internal-selector-migration-evidence.v1',
        baseline: {
            deepOccurrences: 103,
            publicShellInternalOccurrences: 0
        },
        current: {
            deepOccurrences: 51,
            directElementPlusOccurrences: 8,
            publicShellInternalOccurrences: 0
        },
        migrations: [
            { removedDeepOccurrences: 19 },
            {
                surface: 'Example',
                owner: 'FsusUI',
                removedDeepOccurrences: 33,
                fsusUiIssue: 'Ozwasyd/FsusUI#999',
                fsusUiCommit: 'a'.repeat(40)
            }
        ]
    };

    assert.deepEqual(
        validateInternalSelectorMigrationEvidence({ evidence, registry }),
        []
    );

    evidence.current.deepOccurrences = 52;
    assert.deepEqual(
        validateInternalSelectorMigrationEvidence({ evidence, registry }),
        [
            'migration evidence deep total mismatch: baseline 103, removed 52, current 52',
            'migration evidence current deep count 52 does not match registry 51'
        ]
    );
});
