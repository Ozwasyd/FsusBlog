using System.Collections.Immutable;

using FsusBlog.Server.Infrastructure.AuthoringExtensions;

namespace FsusBlog.Server.Tests;

public sealed class AuthoringCommandMetadataNullRefusalTests
{
    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(2)]
    public void Registry_NullWhenElement_FailsWithContractRefusal(int nullIndex)
    {
        AuthoringCommandContribution command = CreateCommand();
        var conditions = new AuthoringCommandContextCondition[]
        {
            new(AuthoringCommandContextFact.HasSelection, AuthoringCommandContextOperator.IsTrue),
            new(AuthoringCommandContextFact.IsOnline, AuthoringCommandContextOperator.IsTrue),
            new(AuthoringCommandContextFact.IsDocumentWritable, AuthoringCommandContextOperator.IsFalse)
        };
        conditions[nullIndex] = null!;

        AssertMetadataRefusal(command with
        {
            When = [.. conditions]
        });
    }

    [Fact]
    public void Registry_NullShortcutKey_FailsWithShortcutContractRefusal()
    {
        AuthoringCommandContribution command = CreateCommand();

        AuthoringExtensionContractException exception = Assert.Throws<AuthoringExtensionContractException>(() =>
            CreateRegistry([command with { Shortcut = command.Shortcut! with { Key = null! } }]));

        Assert.Equal("Shortcut request is not a closed key chord.", exception.Message);
    }

    [Theory]
    [InlineData("single-null-condition")]
    [InlineData("duplicate-null-conditions")]
    [InlineData("null-condition-and-key")]
    [InlineData("null-condition-and-localization")]
    [InlineData("null-key-and-keyword")]
    [InlineData("null-localization-and-key")]
    [InlineData("null-command")]
    public void Registry_NullMetadataCombinations_FailWithContractRefusal(string scenario)
    {
        AuthoringCommandContribution command = CreateCommand();
        AuthoringCommandContribution invalid = scenario switch
        {
            "single-null-condition" => command with { When = [null!] },
            "duplicate-null-conditions" => command with { When = [null!, null!] },
            "null-condition-and-key" => command with
            {
                When = [null!],
                Shortcut = command.Shortcut! with
                {
                    Key = null!
                }
            },
            "null-condition-and-localization" => command with { When = [null!], Localization = null! },
            "null-key-and-keyword" => command with
            {
                Localization = command.Localization with
                {
                    KeywordReferences = [null!]
                },
                Shortcut = command.Shortcut! with
                {
                    Key = null!
                }
            },
            "null-localization-and-key" => command with
            {
                Localization = null!,
                Shortcut = command.Shortcut! with
                {
                    Key = null!
                }
            },
            "null-command" => null!,
            _ => throw new ArgumentOutOfRangeException(nameof(scenario))
        };

        AssertMetadataRefusal(invalid);
    }

    public static IEnumerable<object?[]> InvalidReferences()
    {
        (string Field, int Bound)[] fields =
        [
            ("command", 256), ("extension", 128), ("version", 64), ("contribution", 256),
            ("label", 256), ("description", 256), ("keyword", 256), ("input", 256), ("result", 256)
        ];
        foreach ((string field, int bound) in fields)
        {
            foreach (string? value in new string?[] { null, "", " ", " leading", "trailing ", "control\0value", new('x', bound + 1) })
            {
                yield return [field, value];
            }
        }

        foreach (string field in new[] { "package", "content", "runtime" })
        {
            foreach (string? value in new string?[] { null, "", new('a', 63), new('a', 65), new('A', 64), new('g', 64) })
            {
                yield return [field, value];
            }
        }
    }

    [Theory]
    [MemberData(nameof(InvalidReferences))]
    public void Registry_InvalidReferenceMetadata_FailsWithContractRefusal(string field, string? value)
    {
        AuthoringCommandContribution command = CreateCommand();
        AuthoringCommandContribution invalid = field switch
        {
            "command" => command with { CommandId = value! },
            "extension" => command with { ExtensionId = value! },
            "version" => command with { ExtensionVersion = value! },
            "contribution" => command with { ContributionId = value! },
            "label" => command with { Localization = command.Localization with { LabelReference = value! } },
            "description" => command with { Localization = command.Localization with { DescriptionReference = value! } },
            "keyword" => command with { Localization = command.Localization with { KeywordReferences = [value!] } },
            "input" => command with { InputSchemaReference = value! },
            "result" => command with { ResultSchemaReference = value! },
            "package" => command with { PackageSha256 = value! },
            "content" => command with { ContentSha256 = value! },
            "runtime" => command with { RuntimeIdentity = value! },
            _ => throw new ArgumentOutOfRangeException(nameof(field))
        };

        AssertMetadataRefusal(invalid);
    }

    [Theory]
    [InlineData("foreign-command")]
    [InlineData("core-command")]
    [InlineData("trusted-host")]
    [InlineData("unknown-execution")]
    [InlineData("unknown-category")]
    [InlineData("default-when")]
    [InlineData("oversized-when")]
    [InlineData("duplicate-when")]
    [InlineData("unknown-fact")]
    [InlineData("unknown-operator")]
    [InlineData("default-capabilities")]
    [InlineData("duplicate-capabilities")]
    [InlineData("unknown-capability")]
    [InlineData("null-localization")]
    [InlineData("default-keywords")]
    [InlineData("oversized-keywords")]
    [InlineData("duplicate-keywords")]
    [InlineData("default-surfaces")]
    [InlineData("empty-surfaces")]
    [InlineData("duplicate-surfaces")]
    [InlineData("unknown-surface")]
    public void Registry_ExistingMetadataGuards_ContinueToRefuse(string scenario)
    {
        AuthoringCommandContribution command = CreateCommand();
        AuthoringCommandContribution invalid = scenario switch
        {
            "foreign-command" => command with { CommandId = "another.extension.command" },
            "core-command" => command with { CommandId = "fsusblog.core.command", ExtensionId = "fsusblog.core" },
            "trusted-host" => command with { ExecutionClass = AuthoringExecutionClass.TrustedHostAdapter },
            "unknown-execution" => command with { ExecutionClass = (AuthoringExecutionClass)999 },
            "unknown-category" => command with { Category = (AuthoringCommandCategory)999 },
            "default-when" => command with { When = default },
            "oversized-when" => command with { When = [.. Enumerable.Repeat(command.When[0], 17)] },
            "duplicate-when" => command with { When = [command.When[0], command.When[0]] },
            "unknown-fact" => command with
            {
                When = [new AuthoringCommandContextCondition((AuthoringCommandContextFact)999, AuthoringCommandContextOperator.IsTrue)]
            },
            "unknown-operator" => command with
            {
                When = [new AuthoringCommandContextCondition(AuthoringCommandContextFact.HasSelection, (AuthoringCommandContextOperator)999)]
            },
            "default-capabilities" => command with { RequiredCapabilities = default },
            "duplicate-capabilities" => command with { RequiredCapabilities = [AuthoringCapability.SelectionRead, AuthoringCapability.SelectionRead] },
            "unknown-capability" => command with { RequiredCapabilities = [(AuthoringCapability)999] },
            "null-localization" => command with { Localization = null! },
            "default-keywords" => command with { Localization = command.Localization with { KeywordReferences = default } },
            "oversized-keywords" => command with
            {
                Localization = command.Localization with
                {
                    KeywordReferences = [.. Enumerable.Range(0, 33).Select(index => $"keyword.{index}")]
                }
            },
            "duplicate-keywords" => command with { Localization = command.Localization with { KeywordReferences = ["keyword", "keyword"] } },
            "default-surfaces" => command with { PreferredSurfaces = default },
            "empty-surfaces" => command with { PreferredSurfaces = [] },
            "duplicate-surfaces" => command with { PreferredSurfaces = [AuthoringCommandSurface.Toolbar, AuthoringCommandSurface.Toolbar] },
            "unknown-surface" => command with { PreferredSurfaces = [(AuthoringCommandSurface)999] },
            _ => throw new ArgumentOutOfRangeException(nameof(scenario))
        };

        AssertMetadataRefusal(invalid);
    }

    [Theory]
    [InlineData("default-modifiers")]
    [InlineData("empty-modifiers")]
    [InlineData("duplicate-modifiers")]
    [InlineData("unknown-modifier")]
    [InlineData("empty-key")]
    [InlineData("long-key")]
    [InlineData("punctuation-key")]
    [InlineData("control-key")]
    public void Registry_ExistingShortcutGuards_ContinueToRefuse(string scenario)
    {
        AuthoringCommandContribution command = CreateCommand();
        AuthoringShortcutRequest shortcut = command.Shortcut!;
        AuthoringShortcutRequest invalid = scenario switch
        {
            "default-modifiers" => shortcut with { Modifiers = default },
            "empty-modifiers" => shortcut with { Modifiers = [] },
            "duplicate-modifiers" => shortcut with { Modifiers = [AuthoringShortcutModifier.Control, AuthoringShortcutModifier.Control] },
            "unknown-modifier" => shortcut with { Modifiers = [(AuthoringShortcutModifier)999] },
            "empty-key" => shortcut with { Key = "" },
            "long-key" => shortcut with { Key = "AB" },
            "punctuation-key" => shortcut with { Key = "+" },
            "control-key" => shortcut with { Key = "\0" },
            _ => throw new ArgumentOutOfRangeException(nameof(scenario))
        };

        AuthoringExtensionContractException exception = Assert.Throws<AuthoringExtensionContractException>(() =>
            CreateRegistry([command with { Shortcut = invalid }]));
        Assert.Equal("Shortcut request is not a closed key chord.", exception.Message);
    }

    [Fact]
    public void Registry_DefinedZeroValues_PreserveContextPermissionAndShortcutGuards()
    {
        AuthoringCommandContribution command = CreateCommand();
        var registry = new AuthoringCommandRegistry(
            [command], ImmutableHashSet<string>.Empty, ImmutableHashSet.Create("Control+K"));
        var context = new AuthoringCommandContextSnapshot(
            1,
            ImmutableDictionary<AuthoringCommandContextFact, bool>.Empty
                .Add(AuthoringCommandContextFact.IsExtensionEnabled, true)
                .Add(AuthoringCommandContextFact.HasSelection, true),
            ImmutableHashSet<AuthoringCapability>.Empty,
            false,
            null);

        Assert.Same(command, registry.Get(command.CommandId));
        Assert.Same(command, Assert.Single(registry.Search("format", 10)));
        Assert.Same(command, Assert.Single(registry.GroupByCategory()[AuthoringCommandCategory.Edit]));
        Assert.Equal("shortcut-conflicts-with-core-or-user", registry.ResolveShortcut(command).StableReason);
        AuthoringCommandAvailability denied = registry.Evaluate(command.CommandId, context);
        Assert.True(denied.Visible);
        Assert.False(denied.State.Enabled);
        Assert.Equal("command-permission-insufficient", denied.State.DisabledReason);

        AuthoringCommandContextSnapshot granted = context with
        {
            GrantedCapabilities = ImmutableHashSet.Create(AuthoringCapability.DocumentRangeRead)
        };
        Assert.True(registry.Evaluate(command.CommandId, granted).State.Enabled);
        Assert.Equal("command-context-not-satisfied", registry.Evaluate(command.CommandId, granted with
        {
            Facts = granted.Facts.SetItem(AuthoringCommandContextFact.HasSelection, false)
        }).State.DisabledReason);
        Assert.Equal("extension-not-enabled", registry.Evaluate(command.CommandId, granted with
        {
            Facts = granted.Facts.SetItem(AuthoringCommandContextFact.IsExtensionEnabled, false)
        }).State.DisabledReason);
        Assert.Equal("command-pending", registry.Evaluate(command.CommandId, granted with
        {
            Pending = true
        }).State.DisabledReason);
        Assert.Equal("command-error", registry.Evaluate(command.CommandId, granted with
        {
            ErrorCode = "failed"
        }).State.DisabledReason);
        Assert.Equal(AuthoringCommandSurface.Toolbar, Assert.Single(registry.Project(command.CommandId, denied.State)).Surface);
    }

    [Fact]
    public void Registry_OptionalMetadataAndServiceExecution_RemainValid()
    {
        AuthoringCommandContribution command = CreateCommand() with
        {
            When = [],
            RequiredCapabilities = [],
            Localization = new AuthoringCommandLocalization("label", "description", []),
            Shortcut = null,
            ExecutionClass = AuthoringExecutionClass.OutOfProcessService
        };
        AuthoringCommandRegistry registry = CreateRegistry([command]);

        Assert.Same(command, registry.Get(command.CommandId));
        Assert.Equal("shortcut-not-requested", registry.ResolveShortcut(command).StableReason);
    }

    private static void AssertMetadataRefusal(AuthoringCommandContribution command)
    {
        AuthoringExtensionContractException exception = Assert.Throws<AuthoringExtensionContractException>(() =>
            CreateRegistry([command]));
        Assert.Equal("Command metadata is unknown, broad, duplicated, or not closed.", exception.Message);
    }

    private static AuthoringCommandRegistry CreateRegistry(ImmutableArray<AuthoringCommandContribution> commands) =>
        new(commands, ImmutableHashSet<string>.Empty, ImmutableHashSet<string>.Empty);

    private static AuthoringCommandContribution CreateCommand() => new(
        "acme.author-tools.format",
        "acme.author-tools",
        "1.0.0",
        "acme.command.format",
        new string('a', 64),
        new string('b', 64),
        new string('e', 64),
        AuthoringExecutionClass.IsolatedWorkerWasm,
        new AuthoringCommandLocalization("commands.format.label", "commands.format.description", ["commands.format.keyword"]),
        AuthoringCommandCategory.Edit,
        [new AuthoringCommandContextCondition(AuthoringCommandContextFact.HasSelection, AuthoringCommandContextOperator.IsTrue)],
        [AuthoringCapability.DocumentRangeRead],
        "schema/command-input-v1",
        "schema/command-result-v1",
        [AuthoringCommandSurface.Toolbar],
        new AuthoringShortcutRequest([AuthoringShortcutModifier.Control], "K"));
}
