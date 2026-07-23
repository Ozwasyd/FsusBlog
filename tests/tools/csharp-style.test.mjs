import test from 'node:test';
import assert from 'node:assert/strict'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const checker = path.join(root, 'tools/dotnet/check-csharp-style.mjs')
const editorConfig = readFileSync(path.join(root, '.editorconfig'), 'utf8')
const sourcePolicy = JSON.parse(readFileSync(path.join(root, 'config/development/csharp-style-policy.json'), 'utf8'))

function writeFixture(fixtureRoot, relativePath, content) {
  const target = path.join(fixtureRoot, relativePath)
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, content)
}

function createFixture() {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'fsusblog-csharp-style-'))
  writeFixture(fixtureRoot, '.editorconfig', editorConfig)
  const policy = {
    ...sourcePolicy,
    workspace: 'missing.slnx',
    baseline: 'config/csharp-style-baseline.json'
  }
  writeFixture(fixtureRoot, 'config/csharp-style-policy.json', `${JSON.stringify(policy, null, 2)}\n`)
  return fixtureRoot
}

function runChecker(fixtureRoot, args, env = {}) {
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
  })
}

function output(result) {
  return `${result.stdout}\n${result.stderr}`
}

function withFixture(callback) {
  const fixtureRoot = createFixture()
  try {
    callback(fixtureRoot)
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true })
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
`

test('C# style governance accepts Microsoft-style C# through the changed-file gate', () => {
  withFixture((fixtureRoot) => {
    writeFixture(fixtureRoot, 'src/sample/GoodType.cs', validSource)
    const result = runChecker(fixtureRoot, ['--mode', 'changed', '--file', 'src/sample/GoodType.cs'])
    assert.equal(result.status, 0, output(result))
    assert.match(result.stdout, /\[csharp-style\] ok files=1 violations=0 new=0/u)
  })
})

test('C# style governance full mode ignores tracked files deleted in the working tree', () => {
  withFixture((fixtureRoot) => {
    const relativePath = 'src/sample/DeletedType.cs'
    writeFixture(fixtureRoot, relativePath, validSource)
    for (const args of [
      ['init'],
      ['config', 'user.email', 'fixture@example.invalid'],
      ['config', 'user.name', 'Fixture'],
      ['add', '.'],
      ['commit', '-m', 'fixture']
    ]) {
      const result = spawnSync('git', args, { cwd: fixtureRoot, encoding: 'utf8' })
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    }
    rmSync(path.join(fixtureRoot, relativePath))
    const result = runChecker(fixtureRoot, ['--mode', 'full'])
    assert.equal(result.status, 0, output(result))
    assert.match(result.stdout, /\[csharp-style\] ok files=0 violations=0 new=0/u)
  })
})

test('C# style governance accepts Roslyn expression braces and multiline verbatim content', () => {
  withFixture((fixtureRoot) => {
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
    )
    const result = runChecker(fixtureRoot, ['--mode', 'changed', '--file', 'src/sample/ExpressionBraces.cs'])
    assert.equal(result.status, 0, output(result))

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
    )
    const multipleStatements = runChecker(fixtureRoot, [
      '--mode', 'changed',
      '--file', 'src/sample/InterpolatedStatements.cs'
    ])
    assert.notEqual(multipleStatements.status, 0)
    assert.match(output(multipleStatements), / one-statement:/u)
    assert.match(output(multipleStatements), / allman-brace:/u)
  })
})

test('C# style governance enforces System-first import order across root namespace groups', () => {
  withFixture((fixtureRoot) => {
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
    )
    const result = runChecker(fixtureRoot, ['--mode', 'changed', '--file', 'src/sample/ImportOrder.cs'])
    assert.notEqual(result.status, 0)
    assert.match(output(result), / using-order:/u)
  })
})

test('C# style governance fixes imports into the same System-first order enforced by the gate', () => {
  withFixture((fixtureRoot) => {
    const relativePath = 'src/sample/ImportFix.cs'
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
    )
    const result = runChecker(fixtureRoot, ['--mode', 'full', '--fix', '--file', relativePath])
    assert.equal(result.status, 0, output(result))
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
    )
  })
})

test('C# style governance preserves single scenario separators only for test and benchmark method identifiers', () => {
  withFixture((fixtureRoot) => {
    const source = `namespace Fixture;

public sealed class ScenarioNames
{
    public void ReadAsync_3_MissingItem_ReturnsNull()
    {
    }
}
`
    writeFixture(fixtureRoot, 'tests/backend/Unit/ScenarioNames.cs', source)
    writeFixture(fixtureRoot, 'src/sample/ScenarioNames.cs', source)

    const allowed = runChecker(fixtureRoot, ['--mode', 'changed', '--file', 'tests/backend/Unit/ScenarioNames.cs'])
    assert.equal(allowed.status, 0, output(allowed))

    const rejected = runChecker(fixtureRoot, ['--mode', 'changed', '--file', 'src/sample/ScenarioNames.cs'])
    assert.notEqual(rejected.status, 0)
    assert.match(output(rejected), / method-name:/u)
  })
})

test('C# style governance keeps enum source compatibility exceptions exact and rejects undeclared singular flags names', () => {
  withFixture((fixtureRoot) => {
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
    )
    const compatible = runChecker(fixtureRoot, [
      '--mode', 'changed',
      '--file', 'src/backend/Infrastructure/PublicReadArtifacts/PublicHotArtifactUpdateQueue.cs'
    ])
    assert.equal(compatible.status, 0, output(compatible))

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
    )
    const rejected = runChecker(fixtureRoot, ['--mode', 'changed', '--file', 'src/sample/Permission.cs'])
    assert.notEqual(rejected.status, 0)
    assert.match(output(rejected), / flags-enum-name:/u)
  })
})

test('C# style governance requires every Roslyn naming suppression to match an exact compatibility registration', () => {
  withFixture((fixtureRoot) => {
    const compatiblePath = 'src/backend/Infrastructure/Filters/BannedUserMiddleware.cs'
    const declaration = `namespace Fixture;

#pragma warning disable IDE1006
public sealed class BannedUserMiddleware(object _next)
#pragma warning restore IDE1006
{
    public object Next => _next;
}
`
    writeFixture(fixtureRoot, compatiblePath, declaration)
    const compatible = runChecker(fixtureRoot, ['--mode', 'changed', '--file', compatiblePath])
    assert.equal(compatible.status, 0, output(compatible))

    writeFixture(
      fixtureRoot,
      compatiblePath,
      declaration.replace('#pragma warning disable IDE1006\n', '').replace('#pragma warning restore IDE1006\n', '')
    )
    const missingScope = runChecker(fixtureRoot, ['--mode', 'changed', '--file', compatiblePath])
    assert.notEqual(missingScope.status, 0)
    assert.match(output(missingScope), / roslyn-exception-contract:/u)

    writeFixture(
      fixtureRoot,
      compatiblePath,
      declaration
        .replace('disable IDE1006', 'disable IDE1006, IDE0055')
        .replace('restore IDE1006', 'restore IDE1006, IDE0055')
    )
    const combinedScope = runChecker(fixtureRoot, ['--mode', 'changed', '--file', compatiblePath])
    assert.notEqual(combinedScope.status, 0)
    assert.match(output(combinedScope), / roslyn-exception-scope:/u)

    writeFixture(
      fixtureRoot,
      compatiblePath,
      declaration
        .replace('disable IDE1006', 'disable')
        .replace('restore IDE1006', 'restore')
    )
    const bareScope = runChecker(fixtureRoot, ['--mode', 'changed', '--file', compatiblePath])
    assert.notEqual(bareScope.status, 0)
    assert.match(output(bareScope), / roslyn-exception-scope:/u)

    writeFixture(
      fixtureRoot,
      compatiblePath,
      declaration.replace('object _next)', 'object _next, object _undeclared)')
    )
    const extraParameter = runChecker(fixtureRoot, ['--mode', 'changed', '--file', compatiblePath])
    assert.notEqual(extraParameter.status, 0)
    assert.match(output(extraParameter), / roslyn-exception-contract:/u)

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
    )
    const commentSpoof = runChecker(fixtureRoot, ['--mode', 'changed', '--file', compatiblePath])
    assert.notEqual(commentSpoof.status, 0)
    assert.match(output(commentSpoof), / roslyn-exception-contract:/u)

    writeFixture(
      fixtureRoot,
      compatiblePath,
      declaration.replace(
        '#pragma warning restore IDE1006',
        `{\n    public object bad_member => _next;\n#pragma warning restore IDE1006\n}`
      )
    )
    const widenedScope = runChecker(fixtureRoot, ['--mode', 'changed', '--file', compatiblePath])
    assert.notEqual(widenedScope.status, 0)
    assert.match(output(widenedScope), / roslyn-exception-contract:/u)

    writeFixture(
      fixtureRoot,
      compatiblePath,
      declaration.replace(
        'object _next)',
        'object _next) : Base { public object bad_member => _next;'
      )
    )
    const inlineWidenedScope = runChecker(fixtureRoot, ['--mode', 'changed', '--file', compatiblePath])
    assert.notEqual(inlineWidenedScope.status, 0)
    assert.match(output(inlineWidenedScope), / roslyn-exception-contract:/u)

    const fieldPath = 'src/backend/Infrastructure/Helpers/Security/ModernAcAutomaton.cs'
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
    )
    const complexField = runChecker(fixtureRoot, ['--mode', 'changed', '--file', fieldPath])
    assert.notEqual(complexField.status, 0)
    assert.match(output(complexField), / roslyn-exception-contract:/u)

    const unregisteredPath = 'src/sample/UnregisteredNamingSuppression.cs'
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
    )
    const unregistered = runChecker(fixtureRoot, ['--mode', 'changed', '--file', unregisteredPath])
    assert.notEqual(unregistered.status, 0)
    assert.match(output(unregistered), / roslyn-exception-registration:/u)
  })
})

test('C# style governance aggregates tabs braces indentation using naming and line-ending failures', () => {
  withFixture((fixtureRoot) => {
    writeFixture(
      fixtureRoot,
      'src/sample/BadStyle.cs',
      'namespace Fixture;\r\nusing System;\r\npublic class bad_type {\r\n\tprivate int wrongField;  \r\n  public void bad_method(int BadParameter) { int first = 1; int second = 2; }\r\n}\r\n'
    )
    const result = runChecker(fixtureRoot, ['--mode', 'changed', '--file', 'src/sample/BadStyle.cs'])
    const combined = output(result)
    assert.notEqual(result.status, 0)
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
    ]) {
      assert.match(combined, new RegExp(` ${rule}:`, 'u'), `missing ${rule} in ${combined}`)
    }
  })
})

test('C# style governance excludes explicitly generated C# files', () => {
  withFixture((fixtureRoot) => {
    writeFixture(fixtureRoot, 'src/generated/Bad.generated.cs', 'public class bad_type {\t}\r\n')
    writeFixture(fixtureRoot, 'src/core/Algorithms/AedsFrameType.cs', 'public class bad_type {\t}\r\n')
    const result = runChecker(fixtureRoot, [
      '--mode', 'changed',
      '--file', 'src/generated/Bad.generated.cs',
      '--file', 'src/core/Algorithms/AedsFrameType.cs'
    ])
    assert.equal(result.status, 0, output(result))
    assert.match(result.stdout, /ok files=0 violations=0 new=0/u)
  })
})

test('C# style governance requires XML documentation only in declared public contract scopes', () => {
  withFixture((fixtureRoot) => {
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
    )
    const result = runChecker(fixtureRoot, ['--mode', 'changed', '--file', 'src/shared/Contracts/UndocumentedContract.cs'])
    assert.notEqual(result.status, 0)
    assert.match(output(result), / xml-documentation:/u)
  })
})

test('C# style governance rejects empty XML summaries and undocumented public codec members', () => {
  withFixture((fixtureRoot) => {
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
    )
    const result = runChecker(fixtureRoot, ['--mode', 'changed', '--file', 'src/core/Algorithms/UndocumentedCodec.cs'])
    assert.notEqual(result.status, 0)
    const matches = output(result).match(/ xml-documentation:/gu) ?? []
    assert.equal(matches.length, 2, output(result))
  })
})

test('C# style governance preserves external names in mapping metadata without leaking them into C# identifiers', () => {
  withFixture((fixtureRoot) => {
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
    )
    const result = runChecker(fixtureRoot, ['--mode', 'changed', '--file', 'src/shared/Contracts/ExternalContract.cs'])
    assert.equal(result.status, 0, output(result))
  })
})

test('C# style governance full mode accepts only unchanged baseline debt and strict-full exposes it', () => {
  withFixture((fixtureRoot) => {
    const relativePath = 'src/legacy/LegacyStyle.cs'
    const legacy = `namespace Fixture;

public sealed class LegacyStyle
{
    public void legacy_name()
    {
    }
}
`
    writeFixture(fixtureRoot, relativePath, legacy)
    const update = runChecker(fixtureRoot, ['--mode', 'full', '--update-baseline'])
    assert.equal(update.status, 0, output(update))
    assert.match(update.stdout, /baseline updated violations=1/u)

    const full = runChecker(fixtureRoot, ['--mode', 'full', '--file', relativePath])
    assert.equal(full.status, 0, output(full))

    const strict = runChecker(fixtureRoot, ['--mode', 'strict-full', '--file', relativePath])
    assert.notEqual(strict.status, 0)
    assert.match(output(strict), / method-name:/u)

    writeFixture(fixtureRoot, relativePath, legacy.replace('    {\n    }', '    {\n        int value = 0;\n    }'))
    const changedContent = runChecker(fixtureRoot, ['--mode', 'full', '--file', relativePath])
    assert.notEqual(changedContent.status, 0)
    assert.match(output(changedContent), / method-name:/u)
  })
})

test('C# style governance emits the same aggregate diagnostics in local and CI environments', () => {
  withFixture((fixtureRoot) => {
    const relativePath = 'src/sample/BadName.cs'
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
    )
    const local = runChecker(fixtureRoot, ['--mode', 'changed', '--file', relativePath], { CI: '' })
    const ci = runChecker(fixtureRoot, ['--mode', 'changed', '--file', relativePath], { CI: 'true' })
    assert.notEqual(local.status, 0)
    assert.notEqual(ci.status, 0)
    const diagnostics = (result) => output(result)
      .split(/\r?\n/u)
      .filter((line) => /BadName\.cs:\d+ (?:method-name|parameter-name):/u.test(line))
      .sort()
    assert.deepEqual(diagnostics(ci), diagnostics(local))
    assert.equal(diagnostics(local).length, 2, output(local))
  })
})

test('C# style governance blame ignore preserves its reviewed mechanical C# commits', () => {
  const lines = readFileSync(path.join(root, '.git-blame-ignore-revs'), 'utf8')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
  const reviewedRevisions = [
    '892489472e27c85d277fb98c2c35969851294b58',
    'b5c116cd54e7a0a86fd243059502a3e23f364074',
    '4839b4e1bc9f8c181fad14889414c729cba3108c'
  ]
  for (const revision of reviewedRevisions) {
    assert.ok(lines.includes(revision), `missing C# style governance blame-ignore revision: ${revision}`)
  }

  for (const revision of reviewedRevisions) {
    const commit = spawnSync('git', ['cat-file', '-e', `${revision}^{commit}`], {
      cwd: root,
      encoding: 'utf8'
    })
    assert.equal(commit.status, 0, output(commit))

    const names = spawnSync('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', revision], {
      cwd: root,
      encoding: 'utf8'
    })
    assert.equal(names.status, 0, output(names))
    const changed = names.stdout.split(/\r?\n/u).filter(Boolean)
    assert.ok(changed.length > 0)
    assert.ok(changed.every((file) => file.endsWith('.cs')), names.stdout)
  }
})

test('full static governance runs only the full C# gate', () =>
{
  const lane = readFileSync(path.join(root, 'tools/test/lanes/static-governance.sh'), 'utf8');
  const implementation = lane.match(/StaticCsharpStyle\(\) \{([\s\S]*?)\n\}/u)?.[1] ?? '';
  assert.match(implementation, /check-csharp-style\.mjs" --mode full/u);
  assert.doesNotMatch(implementation, /--mode changed/u);
});
