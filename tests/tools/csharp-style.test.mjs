import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const checker = path.join(root, 'tools/dotnet/check-csharp-style.mjs');
const editorConfig = readFileSync(path.join(root, '.editorconfig'), 'utf8');
const sourcePolicy = JSON.parse(readFileSync(path.join(root, 'config/development/csharp-style-policy.json'), 'utf8'));
const importCompatibilityPath = 'config/development/csharp-import-compatibility.json';
const sourceImportCompatibility = JSON.parse(readFileSync(path.join(root, importCompatibilityPath), 'utf8'));
const compatibleImportOwner = 'tests/backend/Unit/RedisOperationExecutorTests.cs';

function writeFixture(fixtureRoot, relativePath, content)
{
    const target = path.join(fixtureRoot, relativePath);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
}

function createFixture()
{
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'fsusblog-csharp-style-'));
    writeFixture(fixtureRoot, '.editorconfig', editorConfig);
    const policy = {
        ...sourcePolicy,
        workspace: 'missing.slnx',
        baseline: 'config/csharp-style-baseline.json'
    };
    writeFixture(fixtureRoot, 'config/csharp-style-policy.json', `${JSON.stringify(policy, null, 2)}\n`);
    writeFixture(fixtureRoot, importCompatibilityPath, `${JSON.stringify(sourceImportCompatibility, null, 2)}\n`);
    return fixtureRoot;
}

function runChecker(fixtureRoot, args, env = {})
{
    return spawnSync(process.execPath, [
        checker,
        '--root', fixtureRoot,
        '--policy', path.join(fixtureRoot, 'config/csharp-style-policy.json'),
        ...args
    ], {
        cwd: fixtureRoot,
        encoding: 'utf8',
        env: { ...process.env, ...env },
        timeout: 60_000
    });
}

function output(result)
{
    return `${result.stdout}\n${result.stderr}`;
}

function withFixture(callback)
{
    const fixtureRoot = createFixture();
    try
    {
        callback(fixtureRoot);
    }
    finally
    {
        rmSync(fixtureRoot, { recursive: true, force: true });
    }
}

const validSource = `using System;

namespace Fixture;

public sealed class GoodType
{
    private static int s_count;
    private int _value;

    public int Value => _value;

    public string Name { get; set; } = string.Empty;

    public int MutableValue
    {
        get; private set;
    }

    internal static int CurrentValue => 0;

    internal int InstanceValue => _value;

    public int ReadValue(int amount)
    {
        foreach (GoodType item in Array.Empty<GoodType>())
        {
            _ = item;
        }
        int result = amount + _value + s_count;
        return result;
    }

    public (bool Success, int Value) ReadPair(int amount)
    {
        return (true, amount);
    }
}
`;

test('C# style governance accepts Microsoft-style C# through the changed-file gate', () =>
{
    withFixture((fixtureRoot) =>
    {
        writeFixture(fixtureRoot, 'src/sample/GoodType.cs', validSource);
        const result = runChecker(fixtureRoot, ['--mode', 'changed', '--file', 'src/sample/GoodType.cs']);
        assert.equal(result.status, 0, output(result));
        assert.match(result.stdout, /\[csharp-style\] ok files=1 violations=0 new=0/u);
    });
});

test('C# style governance full mode ignores tracked files deleted in the working tree', () =>
{
    withFixture((fixtureRoot) =>
    {
        const relativePath = 'src/sample/DeletedType.cs';
        writeFixture(fixtureRoot, relativePath, validSource);
        for (const args of [
            ['init'],
            ['config', 'user.email', 'fixture@example.invalid'],
            ['config', 'user.name', 'Fixture'],
            ['add', '.'],
            ['commit', '-m', 'fixture']
        ])
        {
            const result = spawnSync('git', args, { cwd: fixtureRoot, encoding: 'utf8' });
            assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
        }
        rmSync(path.join(fixtureRoot, relativePath));
        const result = runChecker(fixtureRoot, ['--mode', 'full']);
        assert.equal(result.status, 0, output(result));
        assert.match(result.stdout, /\[csharp-style\] ok files=0 violations=0 new=0/u);
    });
});

test('C# style governance accepts Roslyn expression braces and multiline verbatim content', () =>
{
    withFixture((fixtureRoot) =>
    {
        writeFixture(
            fixtureRoot,
            'src/sample/ExpressionBraces.cs',
            `namespace Fixture;

public sealed record ExpressionBraces(string Name)
{
    public string Render()
    {
        object payload = new
        {
            Name
        };
        if (payload is { } present)
        {
            _ = present;
        }
        else if (payload is { } fallback)
        {
            _ = fallback;
        }
        ExpressionBraces record = this;
        _ = ComputeRecord(
            record with
            {
                Name = Name.Trim()
            });
        ExpressionBraces normalized = this with
        {
            Name = Name.Trim()
        };
        string diagnostic = $"items: {string.Join("; ", new[] { Name })}";
        string nested = $"checksum:{Compute($"{Name}:{diagnostic}")}";
        string verbatimNested = $@"items: {string.Join("; ", new[] { Name })}";
        return @"if (ready) {
  run();
}" + normalized.Name + nested + verbatimNested;
    }

    private static string Compute(string value) => value;

    private static ExpressionBraces ComputeRecord(ExpressionBraces value) => value;
}

public sealed record MultiLineRecord(
    string DisplayName,
    int ItemCount,
    string? Error = null) : IRecordContract;

public interface IRecordContract
{
}

public readonly record struct StringWrapper(string Value)
{
    public static implicit operator string(StringWrapper value) => value.Value;
}
`
        );
        const result = runChecker(fixtureRoot, ['--mode', 'changed', '--file', 'src/sample/ExpressionBraces.cs']);
        assert.equal(result.status, 0, output(result));

        writeFixture(
            fixtureRoot,
            'src/sample/InterpolatedStatements.cs',
            `namespace Fixture;

public sealed class InterpolatedStatements
{
    public void Run()
    {
        string first = $"{1}"; string second = "still a separate statement";
    }

    public void InlinePatternBlock(object payload)
    {
        if (payload is { } present) { _ = present; }
    }
}
`
        );
        const multipleStatements = runChecker(fixtureRoot, [
            '--mode', 'changed',
            '--file', 'src/sample/InterpolatedStatements.cs'
        ]);
        assert.notEqual(multipleStatements.status, 0);
        assert.match(output(multipleStatements), / one-statement:/u);
        assert.match(output(multipleStatements), / allman-brace:/u);
    });
});

test('C# style governance enforces System-first import order across root namespace groups', () =>
{
    withFixture((fixtureRoot) =>
    {
        writeFixture(
            fixtureRoot,
            'src/sample/ImportOrder.cs',
            `using Vendor;
using System;
using FsusBlog;

namespace Fixture;

public sealed class ImportOrder
{
}
`
        );
        const result = runChecker(fixtureRoot, ['--mode', 'changed', '--file', 'src/sample/ImportOrder.cs']);
        assert.notEqual(result.status, 0);
        assert.match(output(result), / using-order:/u);
    });
});

test('C# style governance fixes imports into the same System-first order enforced by the gate', () =>
{
    withFixture((fixtureRoot) =>
    {
        const relativePath = 'src/sample/ImportFix.cs';
        writeFixture(
            fixtureRoot,
            relativePath,
            `using Vendor;
using System.Text;
using FsusBlog;
using System;

namespace Fixture;

public sealed class ImportFix
{
}
`
        );
        const result = runChecker(fixtureRoot, ['--mode', 'full', '--fix', '--file', relativePath]);
        assert.equal(result.status, 0, output(result));
        assert.equal(
            readFileSync(path.join(fixtureRoot, relativePath), 'utf8'),
            `using System;
using System.Text;

using FsusBlog;

using Vendor;

namespace Fixture;

public sealed class ImportFix
{
}
`
        );
    });
});

const compatibleImports = `using System;

using Microsoft.Extensions.Logging;

using NSubstitute;

using StackExchange.Redis;

using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Execution;

namespace Fixture;

public sealed class ImportCompatibility
{
}
`;
const migrationImports = compatibleImports.replace(
    'using Microsoft.Extensions.Logging;\n\nusing NSubstitute;\n\nusing StackExchange.Redis;\n\nusing FsusBlog.Server.Infrastructure.Cache;\nusing FsusBlog.Server.Infrastructure.Execution;',
    'using FsusBlog.Server.Infrastructure.Cache;\nusing FsusBlog.Server.Infrastructure.Execution;\n\nusing Microsoft.Extensions.Logging;\n\nusing NSubstitute;\n\nusing StackExchange.Redis;'
);

test('exact import compatibility accepts the declared unit owner without baseline debt', () =>
{
    withFixture((fixtureRoot) =>
    {
        writeFixture(fixtureRoot, compatibleImportOwner, compatibleImports);
        const result = runChecker(fixtureRoot, ['--mode', 'full', '--file', compatibleImportOwner]);
        assert.equal(result.status, 0, output(result));
        assert.match(result.stdout, /ok files=1 violations=0 new=0/u);
    });
});

test('exact import compatibility fix shares the declared comparator without changing other files', () =>
{
    withFixture((fixtureRoot) =>
    {
        const other = 'tests/backend/Unit/UnregisteredImports.cs';
        writeFixture(fixtureRoot, compatibleImportOwner, migrationImports);
        writeFixture(fixtureRoot, other, migrationImports);
        const result = runChecker(fixtureRoot, ['--mode', 'full', '--fix', '--file', compatibleImportOwner]);
        assert.equal(result.status, 0, output(result));
        assert.equal(readFileSync(path.join(fixtureRoot, compatibleImportOwner), 'utf8'), compatibleImports);
        assert.equal(readFileSync(path.join(fixtureRoot, other), 'utf8'), migrationImports);
    });
});

test('exact import compatibility does not change the migration comparator for an unregistered file', () =>
{
    withFixture((fixtureRoot) =>
    {
        const other = 'tests/backend/Unit/UnregisteredImports.cs';
        writeFixture(fixtureRoot, other, migrationImports);
        const result = runChecker(fixtureRoot, ['--mode', 'full', '--file', other]);
        assert.equal(result.status, 0, output(result));
    });
});

test('exact import compatibility retains valid static and alias groups without a repository-rank override', () =>
{
    withFixture((fixtureRoot) =>
    {
        writeFixture(fixtureRoot, compatibleImportOwner, compatibleImports.replace('namespace Fixture;',
            'using static FsusBlog.Alpha;\n\nusing static Vendor.Zeta;\n\nusing AVendor = Vendor;\nusing ZRepo = FsusBlog.Server.Infrastructure.Cache;\n\nnamespace Fixture;'));
        const result = runChecker(fixtureRoot, ['--mode', 'full', '--file', compatibleImportOwner]);
        assert.equal(result.status, 0, output(result));
    });
});

for (const other of [
    'src/sample/RedisOperationExecutorTests.cs',
    'tests/backend/Unit/OtherExecutorTests.cs',
    'tests/backend/Unit/redisOperationExecutorTests.cs'
])
{
    test(`exact import compatibility rejects leakage to ${other}`, () =>
    {
        withFixture((fixtureRoot) =>
        {
            writeFixture(fixtureRoot, other, compatibleImports);
            const result = runChecker(fixtureRoot, ['--mode', 'full', '--file', other]);
            assert.notEqual(result.status, 0, output(result));
            assert.match(output(result), / using-order:/u);
        });
    });
}

test('exact import compatibility does not grant a symlink alias the target registration', () =>
{
    withFixture((fixtureRoot) =>
    {
        const alias = 'tests/backend/Unit/ExecutorAlias.cs';
        writeFixture(fixtureRoot, compatibleImportOwner, compatibleImports);
        symlinkSync(path.join(fixtureRoot, compatibleImportOwner), path.join(fixtureRoot, alias));
        const result = runChecker(fixtureRoot, ['--mode', 'full', '--file', alias]);
        assert.notEqual(result.status, 0, output(result));
        assert.match(output(result), / using-order:/u);
    });
});

test('exact import compatibility rejects a declared owner implemented by a symlink', () =>
{
    withFixture((fixtureRoot) =>
    {
        writeFixture(fixtureRoot, 'src/sample/Imports.cs', migrationImports);
        mkdirSync(path.join(fixtureRoot, 'tests/backend/Unit'), { recursive: true });
        symlinkSync(path.join(fixtureRoot, 'src/sample/Imports.cs'), path.join(fixtureRoot, compatibleImportOwner));
        const result = runChecker(fixtureRoot, ['--mode', 'full', '--file', compatibleImportOwner]);
        assert.notEqual(result.status, 0, output(result));
        assert.match(output(result), /import compatibility requires a regular canonical source/u);
    });
});

test('exact import compatibility rejects a symlink ancestor of the declared owner', () =>
{
    withFixture((fixtureRoot) =>
    {
        writeFixture(fixtureRoot, 'owned/RedisOperationExecutorTests.cs', migrationImports);
        mkdirSync(path.join(fixtureRoot, 'tests/backend'), { recursive: true });
        symlinkSync(path.join(fixtureRoot, 'owned'), path.join(fixtureRoot, 'tests/backend/Unit'));
        const result = runChecker(fixtureRoot, ['--mode', 'full', '--file', compatibleImportOwner]);
        assert.notEqual(result.status, 0, output(result));
        assert.match(output(result), /import compatibility requires a regular canonical source/u);
    });
});

for (const [name, source] of [
    ['System last', compatibleImports.replace('using System;\n\n', '').replace('namespace Fixture;', 'using System;\n\nnamespace Fixture;')],
    ['third-party roots reversed', compatibleImports.replace('using Microsoft.Extensions.Logging;\n\nusing NSubstitute;', 'using NSubstitute;\n\nusing Microsoft.Extensions.Logging;')],
    ['repository namespaces reversed', compatibleImports.replace('using FsusBlog.Server.Infrastructure.Cache;\nusing FsusBlog.Server.Infrastructure.Execution;', 'using FsusBlog.Server.Infrastructure.Execution;\nusing FsusBlog.Server.Infrastructure.Cache;')],
    ['repository before third-party', migrationImports],
    ['FsusBlog lookalike is not repository-owned', compatibleImports.replace('using FsusBlog.Server.Infrastructure.Cache;', 'using FsusBlogExtra;\n\nusing FsusBlog.Server.Infrastructure.Cache;')],
    ['static imports reversed', compatibleImports.replace('namespace Fixture;', 'using static Vendor.Zeta;\n\nusing static FsusBlog.Alpha;\n\nnamespace Fixture;')],
    ['alias imports reversed', compatibleImports.replace('namespace Fixture;', 'using ZRepo = FsusBlog.Server.Infrastructure.Cache;\nusing AVendor = Vendor;\n\nnamespace Fixture;')]
])
{
    test(`exact import compatibility still rejects ${name}`, () =>
    {
        withFixture((fixtureRoot) =>
        {
            writeFixture(fixtureRoot, compatibleImportOwner, source);
            const result = runChecker(fixtureRoot, ['--mode', 'full', '--file', compatibleImportOwner]);
            assert.notEqual(result.status, 0, output(result));
            assert.match(output(result), / using-order:/u);
        });
    });
}

test('exact import compatibility preserves root groups and other style requirements', () =>
{
    withFixture((fixtureRoot) =>
    {
        writeFixture(fixtureRoot, compatibleImportOwner, compatibleImports
            .replace('using StackExchange.Redis;\n\nusing FsusBlog', 'using StackExchange.Redis;\nusing FsusBlog')
            .replace('class ImportCompatibility', 'class bad_type'));
        const result = runChecker(fixtureRoot, ['--mode', 'full', '--file', compatibleImportOwner]);
        assert.notEqual(result.status, 0, output(result));
        assert.match(output(result), / using-group:/u);
        assert.match(output(result), / type-name:/u);
    });
});

for (const [name, mutate] of [
    ['unknown schema', (value) => ({ ...value, schema: 'unknown' })],
    ['unknown declaration field', (value) => ({ ...value, checked: true })],
    ['unknown entry field', (value) => ({ ...value, entries: [{ ...value.entries[0], waive: true }] })],
    ['duplicate entry', (value) => ({ ...value, entries: [...value.entries, value.entries[0]] })],
    ['wildcard path', (value) => ({ ...value, entries: [{ ...value.entries[0], path: 'tests/backend/Unit/*.cs' }] })],
    ['same-directory foreign declaration', (value) => ({ ...value, entries: [{ ...value.entries[0], path: 'tests/backend/Unit/OtherExecutorTests.cs' }] })],
    ['noncanonical declaration alias', (value) => ({ ...value, entries: [{ ...value.entries[0], path: 'tests/backend/Unit/../Unit/RedisOperationExecutorTests.cs' }] })],
    ['unknown order', (value) => ({ ...value, entries: [{ ...value.entries[0], order: 'unchecked' }] })],
    ['missing compatibility reason', (value) => ({ ...value, entries: [{ path: value.entries[0].path, order: value.entries[0].order }] })]
])
{
    test(`exact import compatibility fails closed on ${name}`, () =>
    {
        withFixture((fixtureRoot) =>
        {
            writeFixture(fixtureRoot, compatibleImportOwner, migrationImports);
            writeFixture(fixtureRoot, importCompatibilityPath, `${JSON.stringify(mutate(sourceImportCompatibility), null, 2)}\n`);
            const result = runChecker(fixtureRoot, ['--mode', 'full', '--file', compatibleImportOwner]);
            assert.notEqual(result.status, 0, output(result));
            assert.match(output(result), /import compatibility/u);
        });
    });
}

test('exact import compatibility fails closed on a missing declaration', () =>
{
    withFixture((fixtureRoot) =>
    {
        writeFixture(fixtureRoot, compatibleImportOwner, migrationImports);
        rmSync(path.join(fixtureRoot, importCompatibilityPath));
        const result = runChecker(fixtureRoot, ['--mode', 'full', '--file', compatibleImportOwner]);
        assert.notEqual(result.status, 0, output(result));
        assert.match(output(result), /import compatibility/u);
    });
});

test('C# style governance preserves single scenario separators only for test and benchmark method identifiers', () =>
{
    withFixture((fixtureRoot) =>
    {
        const source = `namespace Fixture;

public sealed class ScenarioNames
{
    public void ReadAsync_3_MissingItem_ReturnsNull()
    {
    }
}
`;
        writeFixture(fixtureRoot, 'tests/backend/Unit/ScenarioNames.cs', source);
        writeFixture(fixtureRoot, 'src/sample/ScenarioNames.cs', source);

        const allowed = runChecker(fixtureRoot, ['--mode', 'changed', '--file', 'tests/backend/Unit/ScenarioNames.cs']);
        assert.equal(allowed.status, 0, output(allowed));

        const rejected = runChecker(fixtureRoot, ['--mode', 'changed', '--file', 'src/sample/ScenarioNames.cs']);
        assert.notEqual(rejected.status, 0);
        assert.match(output(rejected), / method-name:/u);
    });
});

test('C# style governance keeps enum source compatibility exceptions exact and rejects undeclared singular flags names', () =>
{
    withFixture((fixtureRoot) =>
    {
        writeFixture(
            fixtureRoot,
            'src/backend/Infrastructure/PublicReadArtifacts/PublicHotArtifactUpdateQueue.cs',
            `using System;

namespace Fixture;

[Flags]
public enum PublicHotArtifactDirtyReason
{
    None = 0,
    Article = 1
}
`
        );
        const compatible = runChecker(fixtureRoot, [
            '--mode', 'changed',
            '--file', 'src/backend/Infrastructure/PublicReadArtifacts/PublicHotArtifactUpdateQueue.cs'
        ]);
        assert.equal(compatible.status, 0, output(compatible));

        writeFixture(
            fixtureRoot,
            'src/sample/Permission.cs',
            `using System;

namespace Fixture;

[Flags]
public enum Permission
{
    None = 0,
    Read = 1
}
`
        );
        const rejected = runChecker(fixtureRoot, ['--mode', 'changed', '--file', 'src/sample/Permission.cs']);
        assert.notEqual(rejected.status, 0);
        assert.match(output(rejected), / flags-enum-name:/u);
    });
});

test('C# style governance requires every Roslyn naming suppression to match an exact compatibility registration', () =>
{
    withFixture((fixtureRoot) =>
    {
        const compatiblePath = 'src/backend/Infrastructure/Filters/BannedUserMiddleware.cs';
        const declaration = `namespace Fixture;

#pragma warning disable IDE1006
public sealed class BannedUserMiddleware(object _next)
#pragma warning restore IDE1006
{
    public object Next => _next;
}
`;
        writeFixture(fixtureRoot, compatiblePath, declaration);
        const compatible = runChecker(fixtureRoot, ['--mode', 'changed', '--file', compatiblePath]);
        assert.equal(compatible.status, 0, output(compatible));

        writeFixture(
            fixtureRoot,
            compatiblePath,
            declaration.replace('#pragma warning disable IDE1006\n', '').replace('#pragma warning restore IDE1006\n', '')
        );
        const missingScope = runChecker(fixtureRoot, ['--mode', 'changed', '--file', compatiblePath]);
        assert.notEqual(missingScope.status, 0);
        assert.match(output(missingScope), / roslyn-exception-contract:/u);

        writeFixture(
            fixtureRoot,
            compatiblePath,
            declaration
                .replace('disable IDE1006', 'disable IDE1006, IDE0055')
                .replace('restore IDE1006', 'restore IDE1006, IDE0055')
        );
        const combinedScope = runChecker(fixtureRoot, ['--mode', 'changed', '--file', compatiblePath]);
        assert.notEqual(combinedScope.status, 0);
        assert.match(output(combinedScope), / roslyn-exception-scope:/u);

        writeFixture(
            fixtureRoot,
            compatiblePath,
            declaration
                .replace('disable IDE1006', 'disable')
                .replace('restore IDE1006', 'restore')
        );
        const bareScope = runChecker(fixtureRoot, ['--mode', 'changed', '--file', compatiblePath]);
        assert.notEqual(bareScope.status, 0);
        assert.match(output(bareScope), / roslyn-exception-scope:/u);

        writeFixture(
            fixtureRoot,
            compatiblePath,
            declaration.replace('object _next)', 'object _next, object _undeclared)')
        );
        const extraParameter = runChecker(fixtureRoot, ['--mode', 'changed', '--file', compatiblePath]);
        assert.notEqual(extraParameter.status, 0);
        assert.match(output(extraParameter), / roslyn-exception-contract:/u);

        writeFixture(
            fixtureRoot,
            compatiblePath,
            `namespace Fixture;

#pragma warning disable IDE1006
// BannedUserMiddleware(object _next) must not satisfy the registration.
public sealed class Replacement(object _undeclared)
#pragma warning restore IDE1006
{
    public object Next => _undeclared;
}
`
        );
        const commentSpoof = runChecker(fixtureRoot, ['--mode', 'changed', '--file', compatiblePath]);
        assert.notEqual(commentSpoof.status, 0);
        assert.match(output(commentSpoof), / roslyn-exception-contract:/u);

        writeFixture(
            fixtureRoot,
            compatiblePath,
            declaration.replace(
                '#pragma warning restore IDE1006',
                `{\n    public object bad_member => _next;\n#pragma warning restore IDE1006\n}`
            )
        );
        const widenedScope = runChecker(fixtureRoot, ['--mode', 'changed', '--file', compatiblePath]);
        assert.notEqual(widenedScope.status, 0);
        assert.match(output(widenedScope), / roslyn-exception-contract:/u);

        writeFixture(
            fixtureRoot,
            compatiblePath,
            declaration.replace(
                'object _next)',
                'object _next) : Base { public object bad_member => _next;'
            )
        );
        const inlineWidenedScope = runChecker(fixtureRoot, ['--mode', 'changed', '--file', compatiblePath]);
        assert.notEqual(inlineWidenedScope.status, 0);
        assert.match(output(inlineWidenedScope), / roslyn-exception-contract:/u);

        const fieldPath = 'src/backend/Infrastructure/Helpers/Security/ModernAcAutomaton.cs';
        writeFixture(
            fixtureRoot,
            fieldPath,
            `namespace Fixture;

public sealed class ModernAcAutomaton
{
#pragma warning disable IDE1006
    [ThreadStatic]
    private static int[]? t_ruleRemainingScratch;
    [ThreadStatic]
    private static int[]? t_touchedRuleScratch;
    private static (int Left, int Right) BadField;
#pragma warning restore IDE1006
}
`
        );
        const complexField = runChecker(fixtureRoot, ['--mode', 'changed', '--file', fieldPath]);
        assert.notEqual(complexField.status, 0);
        assert.match(output(complexField), / roslyn-exception-contract:/u);

        const unregisteredPath = 'src/sample/UnregisteredNamingSuppression.cs';
        writeFixture(
            fixtureRoot,
            unregisteredPath,
            `namespace Fixture;

#pragma warning disable IDE1006
public sealed class UnregisteredNamingSuppression(object _value)
#pragma warning restore IDE1006
{
    public object Value => _value;
}
`
        );
        const unregistered = runChecker(fixtureRoot, ['--mode', 'changed', '--file', unregisteredPath]);
        assert.notEqual(unregistered.status, 0);
        assert.match(output(unregistered), / roslyn-exception-registration:/u);
    });
});

test('C# style governance aggregates tabs braces indentation using naming and line-ending failures', () =>
{
    withFixture((fixtureRoot) =>
    {
        writeFixture(
            fixtureRoot,
            'src/sample/BadStyle.cs',
            'namespace Fixture;\r\nusing System;\r\npublic class bad_type {\r\n\tprivate int wrongField;  \r\n  public void bad_method(int BadParameter) { int first = 1; int second = 2; }\r\n}\r\n'
        );
        const result = runChecker(fixtureRoot, ['--mode', 'changed', '--file', 'src/sample/BadStyle.cs']);
        const combined = output(result);
        assert.notEqual(result.status, 0);
        for (const rule of [
            'line-ending',
            'using-placement',
            'type-name',
            'allman-brace',
            'tab',
            'trailing-whitespace',
            'indent',
            'private-field-name',
            'method-name',
            'parameter-name',
            'one-statement'
        ])
        {
            assert.match(combined, new RegExp(` ${rule}:`, 'u'), `missing ${rule} in ${combined}`);
        }
    });
});

test('C# style governance excludes explicitly generated C# files', () =>
{
    withFixture((fixtureRoot) =>
    {
        writeFixture(fixtureRoot, 'src/generated/Bad.generated.cs', 'public class bad_type {\t}\r\n');
        writeFixture(fixtureRoot, 'src/core/Algorithms/AedsFrameType.cs', 'public class bad_type {\t}\r\n');
        const result = runChecker(fixtureRoot, [
            '--mode', 'changed',
            '--file', 'src/generated/Bad.generated.cs',
            '--file', 'src/core/Algorithms/AedsFrameType.cs'
        ]);
        assert.equal(result.status, 0, output(result));
        assert.match(result.stdout, /ok files=0 violations=0 new=0/u);
    });
});

test('C# style governance requires XML documentation only in declared public contract scopes', () =>
{
    withFixture((fixtureRoot) =>
    {
        writeFixture(
            fixtureRoot,
            'src/shared/Contracts/UndocumentedContract.cs',
            `namespace Fixture;

public sealed class UndocumentedContract
{
    public int ReadValue(int amount)
    {
        return amount;
    }
}
`
        );
        const result = runChecker(fixtureRoot, ['--mode', 'changed', '--file', 'src/shared/Contracts/UndocumentedContract.cs']);
        assert.notEqual(result.status, 0);
        assert.match(output(result), / xml-documentation:/u);
    });
});

test('C# style governance rejects empty XML summaries and undocumented public codec members', () =>
{
    withFixture((fixtureRoot) =>
    {
        writeFixture(
            fixtureRoot,
            'src/core/Algorithms/UndocumentedCodec.cs',
            `namespace Fixture;

/// <summary></summary>
public sealed class UndocumentedCodec
{
    public int Decode(int value)
    {
        return value;
    }
}
`
        );
        const result = runChecker(fixtureRoot, ['--mode', 'changed', '--file', 'src/core/Algorithms/UndocumentedCodec.cs']);
        assert.notEqual(result.status, 0);
        const matches = output(result).match(/ xml-documentation:/gu) ?? [];
        assert.equal(matches.length, 2, output(result));
    });
});

test('C# style governance preserves external names in mapping metadata without leaking them into C# identifiers', () =>
{
    withFixture((fixtureRoot) =>
    {
        writeFixture(
            fixtureRoot,
            'src/shared/Contracts/ExternalContract.cs',
            `using System.Text.Json.Serialization;

namespace Fixture;

/// <summary>Represents a wire-compatible fixture.</summary>
public sealed class ExternalContract
{
    /// <summary>Gets the value mapped from the stable external key.</summary>
    [JsonPropertyName("legacy_user__id")]
    public string UserId => string.Empty;

    private struct Scratch
    {
        public int Value;
    }
}
`
        );
        const result = runChecker(fixtureRoot, ['--mode', 'changed', '--file', 'src/shared/Contracts/ExternalContract.cs']);
        assert.equal(result.status, 0, output(result));
    });
});

test('C# style governance full mode accepts only unchanged baseline debt and strict-full exposes it', () =>
{
    withFixture((fixtureRoot) =>
    {
        const relativePath = 'src/legacy/LegacyStyle.cs';
        const legacy = `namespace Fixture;

public sealed class LegacyStyle
{
    public void legacy_name()
    {
    }
}
`;
        writeFixture(fixtureRoot, relativePath, legacy);
        const update = runChecker(fixtureRoot, ['--mode', 'full', '--update-baseline']);
        assert.equal(update.status, 0, output(update));
        assert.match(update.stdout, /baseline updated violations=1/u);

        const full = runChecker(fixtureRoot, ['--mode', 'full', '--file', relativePath]);
        assert.equal(full.status, 0, output(full));

        const strict = runChecker(fixtureRoot, ['--mode', 'strict-full', '--file', relativePath]);
        assert.notEqual(strict.status, 0);
        assert.match(output(strict), / method-name:/u);

        writeFixture(fixtureRoot, relativePath, legacy.replace('    {\n    }', '    {\n        int value = 0;\n    }'));
        const changedContent = runChecker(fixtureRoot, ['--mode', 'full', '--file', relativePath]);
        assert.notEqual(changedContent.status, 0);
        assert.match(output(changedContent), / method-name:/u);
    });
});

test('C# style governance emits the same aggregate diagnostics in local and CI environments', () =>
{
    withFixture((fixtureRoot) =>
    {
        const relativePath = 'src/sample/BadName.cs';
        writeFixture(
            fixtureRoot,
            relativePath,
            `namespace Fixture;

public sealed class BadName
{
    public void bad_name(int BadParameter)
    {
    }
}
`
        );
        const local = runChecker(fixtureRoot, ['--mode', 'changed', '--file', relativePath], { CI: '' });
        const ci = runChecker(fixtureRoot, ['--mode', 'changed', '--file', relativePath], { CI: 'true' });
        assert.notEqual(local.status, 0);
        assert.notEqual(ci.status, 0);
        const diagnostics = (result) => output(result)
            .split(/\r?\n/u)
            .filter((line) => /BadName\.cs:\d+ (?:method-name|parameter-name):/u.test(line))
            .sort();
        assert.deepEqual(diagnostics(ci), diagnostics(local));
        assert.equal(diagnostics(local).length, 2, output(local));
    });
});

test('C# style governance blame ignore preserves its reviewed mechanical C# commits', () =>
{
    const lines = readFileSync(path.join(root, '.git-blame-ignore-revs'), 'utf8')
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'));
    const reviewedRevisions = [
        '892489472e27c85d277fb98c2c35969851294b58',
        'b5c116cd54e7a0a86fd243059502a3e23f364074',
        '4839b4e1bc9f8c181fad14889414c729cba3108c'
    ];
    for (const revision of reviewedRevisions)
    {
        assert.ok(lines.includes(revision), `missing C# style governance blame-ignore revision: ${revision}`);
    }

    for (const revision of reviewedRevisions)
    {
        const commit = spawnSync('git', ['cat-file', '-e', `${revision}^{commit}`], {
            cwd: root,
            encoding: 'utf8'
        });
        assert.equal(commit.status, 0, output(commit));

        const names = spawnSync('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', revision], {
            cwd: root,
            encoding: 'utf8'
        });
        assert.equal(names.status, 0, output(names));
        const changed = names.stdout.split(/\r?\n/u).filter(Boolean);
        assert.ok(changed.length > 0);
        assert.ok(changed.every((file) => file.endsWith('.cs')), names.stdout);
    }
});

test('full static governance runs only the full C# gate', () =>
{
    const lane = readFileSync(path.join(root, 'tools/test/lanes/static-governance.sh'), 'utf8');
    const implementation = lane.match(/StaticCsharpStyle\(\) \{([\s\S]*?)\n\}/u)?.[1] ?? '';
    assert.match(implementation, /check-csharp-style\.mjs" --mode full/u);
    assert.doesNotMatch(implementation, /--mode changed/u);
});

for (const owner of [
    'tests/migration/OfflineMigrationFingerprintCommandTests.cs',
    'tests/migration/OfflineMigrationOwnedPlanningAuthorityReaderTests.cs',
    'tests/migration/PgLegacyCurrentSchemaPreparationTests.cs',
    'tests/migration/OfflineMigrationBackupAdmissionTests.cs',
    'tests/migration/PgLegacyNonArticlePreparationTests.cs',
    'tests/migration/PgLegacyNonArticleRecoveryTests.cs',
    'src/backend/Infrastructure/SchemaMigration/SchemaMigrationRunner.cs',
    'src/migration/OfflineMigrationCurrentSchemaArtifactReader.cs'
])
{
    test(`exact import compatibility accepts and normalizes the restored owner ${owner}`, () =>
    {
        withFixture((fixtureRoot) =>
        {
            const source = owner === 'tests/migration/PgLegacyNonArticlePreparationTests.cs'
                || owner === 'tests/migration/PgLegacyNonArticleRecoveryTests.cs'
                ? compatibleImports.replace('Logging;\n\nusing NSubstitute;', 'Logging;\nusing NSubstitute;')
                    .replace('NSubstitute;\n\nusing StackExchange.Redis;', 'NSubstitute;\nusing StackExchange.Redis;')
                : compatibleImports;
            writeFixture(fixtureRoot, owner, source);
            const readResult = runChecker(fixtureRoot, ['--mode', 'full', '--file', owner]);
            assert.equal(readResult.status, 0, output(readResult));
            writeFixture(fixtureRoot, owner, migrationImports);
            const fixResult = runChecker(fixtureRoot, ['--mode', 'full', '--fix', '--file', owner]);
            assert.equal(fixResult.status, 0, output(fixResult));
            assert.equal(readFileSync(path.join(fixtureRoot, owner), 'utf8'), source);
        });
    });
}

for (const owner of sourceImportCompatibility.entries.map((entry) => entry.path))
{
    test(`exact import compatibility rejects an incomplete roster missing ${owner}`, () =>
    {
        withFixture((fixtureRoot) =>
        {
            const declaration = {
                ...sourceImportCompatibility,
                entries: sourceImportCompatibility.entries.filter((entry) => entry.path !== owner)
            };
            writeFixture(fixtureRoot, importCompatibilityPath, `${JSON.stringify(declaration, null, 2)}\n`);
            writeFixture(fixtureRoot, compatibleImportOwner, compatibleImports);
            const result = runChecker(fixtureRoot, ['--mode', 'full', '--file', compatibleImportOwner]);
            assert.notEqual(result.status, 0, output(result));
            assert.match(output(result), /import compatibility/u);
        });
    });
}

for (const [name, mutate] of [
    ['same-count duplicate owner', (entries) => [entries[0], entries[0], ...entries.slice(2)]],
    ['additional foreign owner', (entries) => [...entries, { ...entries[0], path: 'tests/migration/OtherTests.cs' }]],
    ['same-count wildcard owner', (entries) => entries.map((entry, index) => index === 1 ? { ...entry, path: 'tests/migration/*.cs' } : entry)],
    ['same-count invalid order', (entries) => entries.map((entry, index) => index === 1 ? { ...entry, order: 'unchecked' } : entry)],
    ['same-count short reason', (entries) => entries.map((entry, index) => index === 1 ? { ...entry, reason: 'short' } : entry)],
    ['same-count unknown field', (entries) => entries.map((entry, index) => index === 1 ? { ...entry, waive: true } : entry)]
])
{
    test(`exact import compatibility rejects ${name} in the complete roster`, () =>
    {
        withFixture((fixtureRoot) =>
        {
            const declaration = { ...sourceImportCompatibility, entries: mutate(sourceImportCompatibility.entries) };
            writeFixture(fixtureRoot, importCompatibilityPath, `${JSON.stringify(declaration, null, 2)}\n`);
            writeFixture(fixtureRoot, compatibleImportOwner, compatibleImports);
            const result = runChecker(fixtureRoot, ['--mode', 'full', '--file', compatibleImportOwner]);
            assert.notEqual(result.status, 0, output(result));
            assert.match(output(result), /import compatibility/u);
        });
    });
}

test('exact import compatibility keeps a restored-owner peer unregistered', () =>
{
    withFixture((fixtureRoot) =>
    {
        const peer = 'tests/migration/OtherPlanningAuthorityReaderTests.cs';
        writeFixture(fixtureRoot, peer, compatibleImports);
        const result = runChecker(fixtureRoot, ['--mode', 'full', '--file', peer]);
        assert.notEqual(result.status, 0, output(result));
        assert.match(output(result), / using-order:/u);
        writeFixture(fixtureRoot, peer, migrationImports);
        const legacyResult = runChecker(fixtureRoot, ['--mode', 'full', '--file', peer]);
        assert.equal(legacyResult.status, 0, output(legacyResult));
    });
});

test('exact import compatibility rejects a restored owner with a symlink leaf', () =>
{
    withFixture((fixtureRoot) =>
    {
        const owner = 'tests/migration/OfflineMigrationFingerprintCommandTests.cs';
        writeFixture(fixtureRoot, 'owned/Source.cs', compatibleImports);
        mkdirSync(path.join(fixtureRoot, 'tests/migration'), { recursive: true });
        symlinkSync(path.join(fixtureRoot, 'owned/Source.cs'), path.join(fixtureRoot, owner));
        const result = runChecker(fixtureRoot, ['--mode', 'full', '--file', owner]);
        assert.notEqual(result.status, 0, output(result));
        assert.match(output(result), /import compatibility requires a regular canonical source/u);
    });
});

const attributedParameters = `using System.Runtime.InteropServices;

namespace Fixture;

internal static class NativeMethods
{
    [DllImport("libc", EntryPoint = "link", SetLastError = true)]
    private static extern int Link([MarshalAs(UnmanagedType.LPUTF8Str)] string existingPath,
        [MarshalAs(UnmanagedType.LPUTF8Str)] string newPath);
}
`;

test('parameter attributes keep framework enum arguments separate from multiline parameter names', () =>
{
    withFixture((fixtureRoot) =>
    {
        const file = 'src/sample/NativeMethods.cs';
        writeFixture(fixtureRoot, file, attributedParameters);
        const result = runChecker(fixtureRoot, ['--mode', 'full', '--file', file]);
        assert.equal(result.status, 0, output(result));
    });
});

for (const [name, source, evidence] of [
    ['first multiline parameter', attributedParameters.replace('string existingPath', 'string ExistingPath'), 'ExistingPath'],
    ['continuation parameter', attributedParameters.replace('string newPath', 'string NewPath'), 'NewPath'],
    ['named attribute argument', attributedParameters.replace('LPUTF8Str)] string newPath', 'LPUTF8Str, SizeConst = 1)] string NewPath'), 'NewPath'],
    ['multiple attributes', attributedParameters.replace(')] string newPath', ')][In] string NewPath'), 'NewPath'],
    ['ordinary parameter', attributedParameters.replace('[MarshalAs(UnmanagedType.LPUTF8Str)] string existingPath', 'string ExistingPath'), 'ExistingPath']
])
{
    test(`parameter attributes still reject an uppercase ${name}`, () =>
    {
        withFixture((fixtureRoot) =>
        {
            const file = 'src/sample/NativeMethods.cs';
            writeFixture(fixtureRoot, file, source);
            const result = runChecker(fixtureRoot, ['--mode', 'full', '--file', file]);
            assert.notEqual(result.status, 0, output(result));
            assert.match(output(result), / parameter-name:/u);
            assert.ok(output(result).includes(`[${evidence}]`), output(result));
            assert.doesNotMatch(output(result), /\[LPUTF8Str\]/u);
        });
    });
}

const sharedThirdPartyImports = `using System;

using Npgsql;
using Xunit;

using FsusBlog.Contracts.Migration;
using FsusBlog.Contracts.Schema;

namespace Fixture;

public sealed class ImportCompatibility
{
}
`;

for (const owner of [
    'tests/migration/PgLegacyNonArticlePreparationTests.cs',
    'tests/migration/PgLegacyNonArticleRecoveryTests.cs'
])
{
    test(`exact import compatibility shares the mother-standard third-party group for ${owner}`, () =>
    {
        withFixture((fixtureRoot) =>
        {
            writeFixture(fixtureRoot, owner, sharedThirdPartyImports);
            const result = runChecker(fixtureRoot, ['--mode', 'full', '--file', owner]);
            assert.equal(result.status, 0, output(result));
            const reversed = sharedThirdPartyImports.replace('using Npgsql;\nusing Xunit;', 'using Xunit;\nusing Npgsql;');
            writeFixture(fixtureRoot, owner, reversed);
            const fixed = runChecker(fixtureRoot, ['--mode', 'full', '--fix', '--file', owner]);
            assert.equal(fixed.status, 0, output(fixed));
            assert.equal(readFileSync(path.join(fixtureRoot, owner), 'utf8'), sharedThirdPartyImports);
        });
    });

    for (const [name, source, rule] of [
        ['reversed third-party order', sharedThirdPartyImports.replace('using Npgsql;\nusing Xunit;', 'using Xunit;\nusing Npgsql;'), 'using-order'],
        ['missing System separation', sharedThirdPartyImports.replace('System;\n\nusing Npgsql;', 'System;\nusing Npgsql;'), 'using-group'],
        ['missing repository separation', sharedThirdPartyImports.replace('Xunit;\n\nusing FsusBlog', 'Xunit;\nusing FsusBlog'), 'using-group'],
        ['third-party subgroup blank', sharedThirdPartyImports.replace('Npgsql;\nusing Xunit;', 'Npgsql;\n\nusing Xunit;'), 'using-group'],
        ['repository before third-party', sharedThirdPartyImports.replace('using Npgsql;\nusing Xunit;\n\nusing FsusBlog.Contracts.Migration;\nusing FsusBlog.Contracts.Schema;', 'using FsusBlog.Contracts.Migration;\nusing FsusBlog.Contracts.Schema;\n\nusing Npgsql;\nusing Xunit;'), 'using-order'],
        ['ordinal third-party order', sharedThirdPartyImports.replace('using Npgsql;\nusing Xunit;', 'using lowercase;\nusing Uppercase;'), 'using-order'],
        ['reversed static imports', sharedThirdPartyImports.replace('namespace Fixture;', 'using static Vendor.Zeta;\n\nusing static FsusBlog.Alpha;\n\nnamespace Fixture;'), 'using-order'],
        ['reversed aliases', sharedThirdPartyImports.replace('namespace Fixture;', 'using ZRepo = FsusBlog.Contracts.Migration;\nusing AVendor = Vendor;\n\nnamespace Fixture;'), 'using-order']
    ])
    {
        test(`exact import compatibility rejects ${name} for ${owner}`, () =>
        {
            withFixture((fixtureRoot) =>
            {
                writeFixture(fixtureRoot, owner, source);
                const result = runChecker(fixtureRoot, ['--mode', 'full', '--file', owner]);
                assert.notEqual(result.status, 0, output(result));
                assert.ok(output(result).includes(` ${rule}:`), output(result));
            });
        });
    }
}

test('exact import compatibility keeps shared third-party groups exclusive to the two new owners', () =>
{
    withFixture((fixtureRoot) =>
    {
        for (const owner of [
            ...sourceImportCompatibility.entries.map((entry) => entry.path).filter((file) =>
                file !== 'tests/migration/PgLegacyNonArticlePreparationTests.cs'
                && file !== 'tests/migration/PgLegacyNonArticleRecoveryTests.cs'),
            'tests/migration/PgLegacyNonArticleOtherTests.cs'
        ])
        {
            writeFixture(fixtureRoot, owner, sharedThirdPartyImports);
            const result = runChecker(fixtureRoot, ['--mode', 'full', '--file', owner]);
            assert.notEqual(result.status, 0, output(result));
            assert.match(output(result), / using-group:/u);
        }
    });
});

test('C# source lexer preserves the three character-class regex match contracts', () =>
{
    const source = readFileSync(checker, 'utf8');
    const start = source.indexOf('function checkFile(');
    const end = source.indexOf('\nfunction loadBaseline()', start);
    const body = source.slice(start, end);
    const oldClass = String.raw`[\w<>,.?\[\]]`;
    const newClass = String.raw`[\w<>,.?[\]]`;
    const patterns = [...body.matchAll(/\/([^\n]+?)\/u/gu)]
        .map((match) => match[1])
        .filter((pattern) => pattern.includes(newClass));
    assert.equal(patterns.length, 3);
    assert.equal(body.includes(oldClass), false);
    const samples = [];
    for (const type of ['int', 'int[]', 'List<int[]>', 'Dictionary<string,int[]>', 'Type?.Member[,]', 'bad-type', 'Å', '😀'])
    {
        samples.push(
            `${type} first, second;`,
            `const ${type} first, second;`,
            `private ${type} _values;`,
            `private static readonly ${type} s_values = null;`,
            `public ${type} Values => null;`,
            `${type} values = null;`,
            `${type} Values = null;`,
            `not ${type} values = null;`
        );
    }
    for (const pattern of patterns)
    {
        const original = new RegExp(pattern.replace(newClass, oldClass), 'u');
        const current = new RegExp(pattern, 'u');
        for (const sample of samples)
        {
            assert.deepEqual(current.exec(sample), original.exec(sample), `${pattern}: ${sample}`);
        }
    }
    const originalClass = new RegExp(`^${oldClass}$`, 'u');
    const currentClass = new RegExp(`^${newClass}$`, 'u');
    for (let code = 0; code < 128; code += 1)
    {
        const character = String.fromCodePoint(code);
        assert.equal(currentClass.test(character), originalClass.test(character), `ASCII ${code}`);
    }
    for (const character of ['Å', '中', '😀', '\ud800'])
    {
        assert.equal(currentClass.test(character), originalClass.test(character));
    }
});

test('C# source lexer retains real array and generic naming and declaration refusals', () =>
{
    withFixture((fixtureRoot) =>
    {
        const file = 'src/sample/TypeTokens.cs';
        const source = `namespace Fixture;

internal sealed class TypeTokens
{
    private int[] _values;
    private Dictionary<string,int[]> _mapping;

    private void Capture()
    {
        int[] values = null;
        Dictionary<string,int[]> mapping = null;
    }
}
`;
        writeFixture(fixtureRoot, file, source);
        const accepted = runChecker(fixtureRoot, ['--mode', 'full', '--file', file]);
        assert.equal(accepted.status, 0, output(accepted));
        const refusedSource = source.replace('int[] _values', 'int[] Values')
            .replace('int[] values = null;', 'int[] Values = null;')
            .replace('Dictionary<string,int[]> mapping = null;', 'Dictionary<string,int[]> mapping = null;\n        int[] first, second;');
        writeFixture(fixtureRoot, file, refusedSource);
        const refused = runChecker(fixtureRoot, ['--mode', 'full', '--file', file]);
        assert.notEqual(refused.status, 0, output(refused));
        for (const rule of ['private-field-name', 'local-name', 'one-declaration'])
        {
            assert.ok(output(refused).includes(` ${rule}:`), output(refused));
        }
    });
});


test('contextual record expressions do not exempt lowercase types named with', () =>
{
    withFixture((fixtureRoot) =>
    {
        for (const declaration of [
            'record with;',
            'record with(int Value);',
            'record class with;',
            'class with',
            'struct with',
            'record lowerCase;',
            '[System.Obsolete]\npublic class Container\n{\n    record with;\n}',
            '#nullable enable\npublic class Container(int Value)\n{\n    record with;\n}',
            '[System.Xml.Serialization.XmlInclude(typeof(int[]))]\npublic class Container(int value)\n{\n    record with;\n}',
            '[System.Xml.Serialization.XmlInclude(\n    typeof(int[]))]\npublic class Container(int value)\n{\n    record with;\n}',
            '[Some(new int[] { 1 })]\npublic class Container(int value)\n{\n    record with;\n}',
            '[System.Obsolete]\n[Some(new int[] { 1 })]\npublic class Container(int value)\n{\n    record with;\n}',
            'public class Container([Some(new int[] { 1 })] int value)\n{\n    record with;\n}',
            'public class @Container(int value)\n{\n    record with;\n}',
            'public class ΔContainer(int value)\n{\n    record with;\n}',
            String.raw`public class \u0043ontainer(int value)
{
    record with;
}`,
            'public class @new(int value)\n{\n    record with;\n}',
            'namespace @new\n{\n    record with;\n}',
            'public class Container(SomeRecord record) : Base(\n    record with\n    {\n        Name = "Updated"\n    })\n{\n    record with;\n}',
            'public class Container() : Base(() =>\n{\n    return 1;\n})\n{\n    record with;\n}'
        ])
        {
            writeFixture(fixtureRoot, 'src/sample/BadType.cs', `namespace Fixture;\n\n${declaration}${/[;}]$/u.test(declaration) ? '\n' : '\n{\n}\n'}`);
            const result = runChecker(fixtureRoot, ['--mode', 'full']);
            assert.notEqual(result.status, 0, output(result));
            assert.match(output(result), / type-name:/u);
        }
    });
});

test('singular Miss enums and plural flags retain both naming refusal controls', () =>
{
    withFixture((fixtureRoot) =>
    {
        for (const [name, flags, rule] of [
            ['PublicHotReadServingMiss', false, null],
            ['PublicHotReadServingMisses', false, 'enum-name'],
            ['Permissions', false, 'enum-name'],
            ['Permissions', true, null],
            ['Permission', true, 'flags-enum-name'],
            ['PublicHotReadServingMiss', true, 'flags-enum-name']
        ])
        {
            writeFixture(fixtureRoot, 'src/sample/Enum.cs', `using System;\n\nnamespace Fixture;\n\n${flags ? '[Flags]\n' : ''}public enum ${name}\n{\n    None = 0\n}\n`);
            const result = runChecker(fixtureRoot, ['--mode', 'full']);
            assert.equal(result.status, rule ? 1 : 0, output(result));
            if (rule)
            {
                assert.match(output(result), new RegExp(` ${rule}:`, 'u'));
            }
        }
    });
});

test('policy-only rebind preserves the real original baseline and refuses substituted inputs', () =>
{
    withFixture((fixtureRoot) =>
    {
        const policyPath = 'config/development/csharp-style-policy.json';
        const baselinePath = 'config/development/csharp-style-baseline.json';
        const original = spawnSync('git', ['show', 'b19b3dc715691b871f0e3cab598ec5da8f27633c:' + baselinePath], {
            cwd: root, encoding: 'utf8', env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' }
        });
        assert.equal(original.status, 0, original.stderr);
        const originalBytes = original.stdout;
        assert.equal(crypto.createHash('sha256').update(originalBytes).digest('hex'),
            '0ab4b1ebfecbba054015209fcb30f62dbd6395a1390da67a87b9e9fd057fd011');
        const missPolicy = structuredClone(sourcePolicy);
        missPolicy.enumNaming.acceptedSingularSuffixes = missPolicy.enumNaming.acceptedSingularSuffixes.filter((suffix) => suffix !== 'Access');
        const candidatePolicy = `${JSON.stringify(missPolicy, null, 4)}\n`;
        writeFixture(fixtureRoot, policyPath, candidatePolicy);
        const run = (args = []) => spawnSync(process.execPath, [checker, '--root', fixtureRoot,
            '--mode', 'full', '--rebind-baseline-policy', ...args], { cwd: fixtureRoot, encoding: 'utf8' });
        writeFixture(fixtureRoot, baselinePath, originalBytes);
        const stale = spawnSync(process.execPath, [checker, '--root', fixtureRoot, '--mode', 'full'], {
            cwd: fixtureRoot, encoding: 'utf8'
        });
        assert.equal(stale.status, 1, output(stale));
        assert.match(output(stale), /policy digest is stale/u);
        const accepted = run();
        assert.equal(accepted.status, 0, output(accepted));
        const rebound = readFileSync(path.join(fixtureRoot, baselinePath), 'utf8');
        const expected = JSON.parse(originalBytes);
        expected.policySha256 = crypto.createHash('sha256').update(candidatePolicy).digest('hex');
        assert.deepEqual(JSON.parse(rebound), expected);
        assert.equal(run().status, 0);
        const ordinary = spawnSync(process.execPath, [checker, '--root', fixtureRoot, '--mode', 'full'], {
            cwd: fixtureRoot, encoding: 'utf8'
        });
        assert.equal(ordinary.status, 0, output(ordinary));
        for (const mutate of [
            (value) =>
            {
                value.schema = 'wrong';
            },
            (value) =>
            {
                value.generatedFrom = 'wrong';
            },
            (value) =>
            {
                value.violationCount += 1;
            },
            (value) =>
            {
                value.fileCount += 1;
            },
            (value) =>
            {
                value.policySha256 = '0'.repeat(64);
            },
            (value) =>
            {
                value.files[0].sourceSha256 = '0'.repeat(64);
            },
            (value) =>
            {
                value.files[0].violationDigest = '0'.repeat(64);
            },
            (value) =>
            {
                value.files[0].rules['type-name'] += 1;
            },
            (value) =>
            {
                value.files[0].path = 'src/other.cs';
            },
            (value) =>
            {
                value.files.push(value.files[0]);
            }
        ])
        {
            const corrupted = JSON.parse(originalBytes);
            mutate(corrupted);
            const bytes = `${JSON.stringify(corrupted, null, 4)}\n`;
            writeFixture(fixtureRoot, baselinePath, bytes);
            const result = run();
            assert.equal(result.status, 1, output(result));
            assert.match(output(result), /intact original baseline/u);
            assert.equal(readFileSync(path.join(fixtureRoot, baselinePath), 'utf8'), bytes);
        }
        writeFixture(fixtureRoot, baselinePath, originalBytes);
        for (const extra of [['--fix'], ['--update-baseline'], ['--file', 'src/Other.cs'], ['--mode', 'strict-full'], ['--base', 'HEAD'], ['--policy', path.join(fixtureRoot, 'config/csharp-style-policy.json')]])
        {
            assert.equal(run(extra).status, 1);
            assert.equal(readFileSync(path.join(fixtureRoot, baselinePath), 'utf8'), originalBytes);
        }
        const expanded = structuredClone(missPolicy);
        expanded.excludedPaths.push('src/**');
        writeFixture(fixtureRoot, policyPath, `${JSON.stringify(expanded, null, 4)}\n`);
        assert.equal(run().status, 1);
        assert.equal(readFileSync(path.join(fixtureRoot, baselinePath), 'utf8'), originalBytes);
        writeFixture(fixtureRoot, policyPath, candidatePolicy);
        rmSync(path.join(fixtureRoot, baselinePath));
        assert.equal(run().status, 1);
        writeFixture(fixtureRoot, 'original-baseline.json', originalBytes);
        symlinkSync(path.join(fixtureRoot, 'original-baseline.json'), path.join(fixtureRoot, baselinePath));
        assert.equal(run().status, 1);
        assert.equal(readFileSync(path.join(fixtureRoot, 'original-baseline.json'), 'utf8'), originalBytes);
    });
});


test('array-valued attributes retain genuine contextual record expressions', () =>
{
    withFixture((fixtureRoot) =>
    {
        writeFixture(fixtureRoot, 'src/sample/AttributedRecord.cs', `namespace Fixture;

[System.Xml.Serialization.XmlInclude(typeof(int[]))]
public sealed record AttributedRecord(string Name)
{
    public AttributedRecord Normalize(AttributedRecord record)
    {
        return Copy(
            record with
            {
                Name = Name.Trim()
            });
    }

    private static AttributedRecord Copy(AttributedRecord value) => value;
}
`);
        const result = runChecker(fixtureRoot, ['--mode', 'changed', '--file', 'src/sample/AttributedRecord.cs']);
        assert.equal(result.status, 0, output(result));
    });
});


test('singular Access retains the eight ordinary and flags controls', () =>
{
    withFixture((fixtureRoot) =>
    {
        for (const [name, flags, rule] of [
            ['GpuPeerAllocationAccess', false, null],
            ['GpuPeerAllocationAccesses', false, 'enum-name'],
            ['GpuPeerAllocationAccesses', true, null],
            ['GpuPeerAllocationAccess', true, 'flags-enum-name'],
            ['PublicHotReadServingMiss', false, null],
            ['PublicHotReadServingMisses', false, 'enum-name'],
            ['Permissions', true, null],
            ['Permission', true, 'flags-enum-name']
        ])
        {
            writeFixture(fixtureRoot, 'src/sample/Enum.cs', `using System;\n\nnamespace Fixture;\n\n${flags ? '[Flags]\n' : ''}public enum ${name}\n{\n    Read,\n    ExclusiveWrite\n}\n`);
            const result = runChecker(fixtureRoot, ['--mode', 'full']);
            assert.equal(result.status, rule ? 1 : 0, output(result));
            if (rule)
            {
                assert.match(output(result), new RegExp(` ${rule}:`, 'u'));
            }
        }
    });
});


test('Access-only rebind preserves the merged Miss baseline and refuses substituted inputs', () =>
{
    withFixture((fixtureRoot) =>
    {
        const policyPath = 'config/development/csharp-style-policy.json';
        const baselinePath = 'config/development/csharp-style-baseline.json';
        const original = spawnSync('git', ['show', 'b9c076e4b763130075218ff9d50f9a6c36784f59:' + baselinePath], {
            cwd: root, encoding: 'utf8', env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' }
        });
        assert.equal(original.status, 0, original.stderr);
        const originalBytes = original.stdout;
        assert.equal(crypto.createHash('sha256').update(originalBytes).digest('hex'),
            '4351155657a6f448d27f2e7eb54dfd430d2a9246b8e0b4f463f5143ace6b204e');
        const candidatePolicy = `${JSON.stringify(sourcePolicy, null, 4)}\n`;
        writeFixture(fixtureRoot, policyPath, candidatePolicy);
        const run = (args = []) => spawnSync(process.execPath, [checker, '--root', fixtureRoot,
            '--mode', 'full', '--rebind-access-baseline-policy', ...args], { cwd: fixtureRoot, encoding: 'utf8' });
        writeFixture(fixtureRoot, baselinePath, originalBytes);
        const stale = spawnSync(process.execPath, [checker, '--root', fixtureRoot, '--mode', 'full'], {
            cwd: fixtureRoot, encoding: 'utf8'
        });
        assert.equal(stale.status, 1, output(stale));
        assert.match(output(stale), /policy digest is stale/u);
        const accepted = run();
        assert.equal(accepted.status, 0, output(accepted));
        const rebound = readFileSync(path.join(fixtureRoot, baselinePath), 'utf8');
        const expected = JSON.parse(originalBytes);
        expected.policySha256 = crypto.createHash('sha256').update(candidatePolicy).digest('hex');
        assert.deepEqual(JSON.parse(rebound), expected);
        assert.equal(run().status, 0);
        const ordinary = spawnSync(process.execPath, [checker, '--root', fixtureRoot, '--mode', 'full'], {
            cwd: fixtureRoot, encoding: 'utf8'
        });
        assert.equal(ordinary.status, 0, output(ordinary));
        for (const mutate of [
            (value) =>
            {
                value.schema = 'wrong';
            },
            (value) =>
            {
                value.generatedFrom = 'wrong';
            },
            (value) =>
            {
                value.violationCount += 1;
            },
            (value) =>
            {
                value.fileCount += 1;
            },
            (value) =>
            {
                value.policySha256 = '0'.repeat(64);
            },
            (value) =>
            {
                value.files[0].sourceSha256 = '0'.repeat(64);
            },
            (value) =>
            {
                value.files[0].violationDigest = '0'.repeat(64);
            },
            (value) =>
            {
                value.files[0].rules['type-name'] += 1;
            },
            (value) =>
            {
                value.files[0].path = 'src/other.cs';
            },
            (value) =>
            {
                value.files.push(value.files[0]);
            }
        ])
        {
            const corrupted = JSON.parse(originalBytes);
            mutate(corrupted);
            const bytes = `${JSON.stringify(corrupted, null, 4)}\n`;
            writeFixture(fixtureRoot, baselinePath, bytes);
            const result = run();
            assert.equal(result.status, 1, output(result));
            assert.match(output(result), /intact original baseline/u);
            assert.equal(readFileSync(path.join(fixtureRoot, baselinePath), 'utf8'), bytes);
        }
        writeFixture(fixtureRoot, baselinePath, originalBytes);
        for (const extra of [['--rebind-baseline-policy'], ['--fix'], ['--update-baseline'], ['--file', 'src/Other.cs'], ['--mode', 'strict-full'], ['--base', 'HEAD'], ['--policy', path.join(fixtureRoot, 'config/csharp-style-policy.json')]])
        {
            assert.equal(run(extra).status, 1);
            assert.equal(readFileSync(path.join(fixtureRoot, baselinePath), 'utf8'), originalBytes);
        }
        const legacy = spawnSync(process.execPath, [checker, '--root', fixtureRoot,
            '--mode', 'full', '--rebind-baseline-policy'], { cwd: fixtureRoot, encoding: 'utf8' });
        assert.equal(legacy.status, 1, output(legacy));
        assert.match(output(legacy), /canonical Miss suffix extension/u);
        assert.equal(readFileSync(path.join(fixtureRoot, baselinePath), 'utf8'), originalBytes);
        const withoutAccess = structuredClone(sourcePolicy);
        withoutAccess.enumNaming.acceptedSingularSuffixes.pop();
        writeFixture(fixtureRoot, policyPath, `${JSON.stringify(withoutAccess, null, 4)}\n`);
        assert.equal(run().status, 1);
        assert.equal(readFileSync(path.join(fixtureRoot, baselinePath), 'utf8'), originalBytes);
        writeFixture(fixtureRoot, policyPath, candidatePolicy);
        const expanded = structuredClone(sourcePolicy);
        expanded.excludedPaths.push('src/**');
        writeFixture(fixtureRoot, policyPath, `${JSON.stringify(expanded, null, 4)}\n`);
        assert.equal(run().status, 1);
        assert.equal(readFileSync(path.join(fixtureRoot, baselinePath), 'utf8'), originalBytes);
        writeFixture(fixtureRoot, policyPath, candidatePolicy);
        rmSync(path.join(fixtureRoot, baselinePath));
        assert.equal(run().status, 1);
        writeFixture(fixtureRoot, 'original-baseline.json', originalBytes);
        symlinkSync(path.join(fixtureRoot, 'original-baseline.json'), path.join(fixtureRoot, baselinePath));
        assert.equal(run().status, 1);
        assert.equal(readFileSync(path.join(fixtureRoot, 'original-baseline.json'), 'utf8'), originalBytes);
    });
});
