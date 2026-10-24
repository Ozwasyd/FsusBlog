using System.Collections.Immutable;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

using FsusBlog.Server.Infrastructure.AuthoringExtensions;

namespace FsusBlog.Server.Tests;

public sealed class AuthoringCommandSignedMetadataPresenceTests
{
    [Theory]
    [InlineData("category")]
    [InlineData("when.fact")]
    [InlineData("when.operator")]
    public void Read_MissingEnum_RejectsRatherThanInventingZero(string path)
    {
        JsonArray metadata = CreateMetadata();
        (JsonObject owner, string property) = FindProperty(metadata, path);
        Assert.True(owner.Remove(property));

        AssertClosedJson(metadata.ToJsonString());
    }

    [Theory]
    [InlineData("commandId")]
    [InlineData("extensionId")]
    [InlineData("extensionVersion")]
    [InlineData("contributionId")]
    [InlineData("packageSha256")]
    [InlineData("contentSha256")]
    [InlineData("runtimeIdentity")]
    [InlineData("executionClass")]
    [InlineData("localization")]
    [InlineData("when")]
    [InlineData("requiredCapabilities")]
    [InlineData("inputSchemaReference")]
    [InlineData("resultSchemaReference")]
    [InlineData("preferredSurfaces")]
    [InlineData("localization.labelReference")]
    [InlineData("localization.descriptionReference")]
    [InlineData("localization.keywordReferences")]
    [InlineData("shortcut.modifiers")]
    [InlineData("shortcut.key")]
    public void Read_MissingConstructorParameter_RejectsClosedJson(string path)
    {
        JsonArray metadata = CreateMetadata();
        (JsonObject owner, string property) = FindProperty(metadata, path);
        Assert.True(owner.Remove(property));

        AssertClosedJson(metadata.ToJsonString());
    }

    [Theory]
    [InlineData(0, 0, 0)]
    [InlineData(0, 0, 1)]
    [InlineData(0, 1, 0)]
    [InlineData(0, 1, 1)]
    [InlineData(1, 0, 0)]
    [InlineData(1, 0, 1)]
    [InlineData(1, 1, 0)]
    [InlineData(1, 1, 1)]
    public void Activate_ExplicitLegalEnums_PreservesSignedValues(int category, int fact, int operation)
    {
        JsonArray metadata = CreateMetadata();
        metadata[0]!["category"] = category;
        metadata[0]!["when"]![0]!["fact"] = fact;
        metadata[0]!["when"]![0]!["operator"] = operation;
        (VerifiedAuthoringPackage package, ImmutableArray<AuthoringExecutionTarget> targets) =
            CreatePackage(metadata.ToJsonString());
        var authority = new AuthoringCommandRegistryAuthority(
            new VerifiedPackageAuthoringCommandSource(),
            ImmutableHashSet<string>.Empty,
            ImmutableHashSet<string>.Empty);

        AuthoringCommandAuthorityReport report = authority.Activate(package, targets);
        AuthoringCommandContribution command = authority.Snapshot().Get(CreateCommand().CommandId);

        Assert.Equal(1, report.Commands);
        Assert.Equal(4, report.Surfaces);
        Assert.Equal((AuthoringCommandCategory)category, command.Category);
        AuthoringCommandContextCondition condition = Assert.Single(command.When);
        Assert.Equal((AuthoringCommandContextFact)fact, condition.Fact);
        Assert.Equal((AuthoringCommandContextOperator)operation, condition.Operator);
    }

    [Theory]
    [InlineData("category")]
    [InlineData("localization.labelReference")]
    [InlineData("when.fact")]
    [InlineData("shortcut.key")]
    public void Read_UnknownPropertyAtEveryObjectLevel_RejectsClosedJson(string path)
    {
        JsonArray metadata = CreateMetadata();
        (JsonObject owner, _) = FindProperty(metadata, path);
        owner["unknownSignedField"] = 0;

        AssertClosedJson(metadata.ToJsonString());
    }

    [Theory]
    [InlineData("category")]
    [InlineData("localization.labelReference")]
    [InlineData("when.fact")]
    [InlineData("when.operator")]
    [InlineData("shortcut.key")]
    public void Read_DuplicatePropertyAtEveryObjectLevel_PreservesDuplicateError(string path)
    {
        JsonArray metadata = CreateMetadata();
        (JsonObject owner, string property) = FindProperty(metadata, path);
        string original = owner.ToJsonString();
        string duplicate = original.Insert(1, $"\"{property}\":{owner[property]!.ToJsonString()},");
        string json = metadata.ToJsonString().Replace(original, duplicate, StringComparison.Ordinal);
        (VerifiedAuthoringPackage package, ImmutableArray<AuthoringExecutionTarget> targets) = CreatePackage(json);

        AuthoringExtensionContractException exception = Assert.Throws<AuthoringExtensionContractException>(() =>
            new VerifiedPackageAuthoringCommandSource().Read(package, targets));

        Assert.Equal("Signed command metadata contains a duplicate property.", exception.Message);
    }

    [Theory]
    [InlineData("category")]
    [InlineData("executionClass")]
    [InlineData("when.fact")]
    [InlineData("when.operator")]
    public void Read_NullEnum_RejectsClosedJson(string path)
    {
        JsonArray metadata = CreateMetadata();
        (JsonObject owner, string property) = FindProperty(metadata, path);
        owner[property] = null;

        AssertClosedJson(metadata.ToJsonString());
    }

    [Fact]
    public void Activate_OmittedShortcut_RemainsLegalAndUnrequested()
    {
        JsonArray metadata = CreateMetadata();
        Assert.True(metadata[0]!.AsObject().Remove("shortcut"));
        (VerifiedAuthoringPackage package, ImmutableArray<AuthoringExecutionTarget> targets) =
            CreatePackage(metadata.ToJsonString());
        var authority = new AuthoringCommandRegistryAuthority(
            new VerifiedPackageAuthoringCommandSource(),
            ImmutableHashSet<string>.Empty,
            ImmutableHashSet<string>.Empty);

        AuthoringCommandAuthorityReport report = authority.Activate(package, targets);
        AuthoringCommandRegistry registry = authority.Snapshot();
        AuthoringCommandContribution command = registry.Get(CreateCommand().CommandId);
        AuthoringCommandContribution expected = CreateCommand() with
        {
            Shortcut = null
        };

        Assert.Equal(1, report.Commands);
        Assert.Equal(4, report.Surfaces);
        Assert.Equivalent(expected, command, strict: true);
        Assert.Equal("shortcut-not-requested", registry.ResolveShortcut(command).StableReason);
    }

    [Theory]
    [InlineData("category")]
    [InlineData("when.fact")]
    [InlineData("when.operator")]
    public void Read_OmittedShortcut_DoesNotPermitMissingEnum(string path)
    {
        JsonArray metadata = CreateMetadata();
        Assert.True(metadata[0]!.AsObject().Remove("shortcut"));
        (JsonObject owner, string property) = FindProperty(metadata, path);
        Assert.True(owner.Remove(property));

        AssertClosedJson(metadata.ToJsonString());
    }

    [Fact]
    public void Read_ExplicitNullShortcut_RemainsLegal()
    {
        JsonArray metadata = CreateMetadata();
        metadata[0]!["shortcut"] = null;
        (VerifiedAuthoringPackage package, ImmutableArray<AuthoringExecutionTarget> targets) =
            CreatePackage(metadata.ToJsonString());

        AuthoringCommandContribution command = Assert.Single(new VerifiedPackageAuthoringCommandSource().Read(package, targets));

        Assert.Null(command.Shortcut);
    }

    [Fact]
    public void Read_NullLocalization_PreservesRegistryError()
    {
        JsonArray metadata = CreateMetadata();
        metadata[0]!["localization"] = null;
        (VerifiedAuthoringPackage package, ImmutableArray<AuthoringExecutionTarget> targets) =
            CreatePackage(metadata.ToJsonString());

        AuthoringExtensionContractException exception = Assert.Throws<AuthoringExtensionContractException>(() =>
            new VerifiedPackageAuthoringCommandSource().Read(package, targets));

        Assert.Equal("Command metadata is unknown, broad, duplicated, or not closed.", exception.Message);
    }

    private static void AssertClosedJson(string json)
    {
        (VerifiedAuthoringPackage package, ImmutableArray<AuthoringExecutionTarget> targets) = CreatePackage(json);

        AuthoringExtensionContractException exception = Assert.Throws<AuthoringExtensionContractException>(() =>
            new VerifiedPackageAuthoringCommandSource().Read(package, targets));

        Assert.Equal("Signed command metadata is not closed JSON: JsonException.", exception.Message);
    }

    private static JsonArray CreateMetadata() => JsonSerializer.SerializeToNode(
        new[] { CreateCommand() },
        new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase })!.AsArray();

    private static (JsonObject Owner, string Property) FindProperty(JsonArray metadata, string path)
    {
        string[] parts = path.Split('.');
        JsonNode owner = metadata[0]!;
        if (parts.Length == 2)
        {
            owner = owner[parts[0]]!;
            if (owner is JsonArray array)
            {
                owner = array[0]!;
            }
        }

        return (owner.AsObject(), parts[^1]);
    }

    private static AuthoringCommandContribution CreateCommand() => new(
        "acme.author-tools.format", "acme.author-tools", "1.0.0", "acme.command.format",
        new string('a', 64), new string('b', 64), new string('e', 64),
        AuthoringExecutionClass.IsolatedWorkerWasm,
        new AuthoringCommandLocalization("commands.format.label", "commands.format.description", ["commands.format.keyword"]),
        AuthoringCommandCategory.Format,
        [new AuthoringCommandContextCondition(AuthoringCommandContextFact.IsDocumentWritable, AuthoringCommandContextOperator.IsFalse)],
        [AuthoringCapability.SelectionRead, AuthoringCapability.DocumentMutationRequest],
        "schema/command-input-v1", "schema/command-result-v1",
        [AuthoringCommandSurface.Toolbar, AuthoringCommandSurface.CommandPalette, AuthoringCommandSurface.SlashMenu, AuthoringCommandSurface.SelectionMenu],
        new AuthoringShortcutRequest([AuthoringShortcutModifier.Control], "K"));

    // Mirror PackageSourceAndAuthority_UseOneSignedClosedRegistry's verified-package boundary.
    // Archive/signature verification belongs to the existing package suites, not this parser fixture.
    private static (VerifiedAuthoringPackage Package, ImmutableArray<AuthoringExecutionTarget> Targets) CreatePackage(string json)
    {
        AuthoringCommandContribution command = CreateCommand();
        AuthoringExtensionManifest baseline = AuthoringExtensionContractsTests.CreateManifest();
        AuthoringExtensionManifest manifest = baseline with
        {
            Contributions = [baseline.Contributions[0] with { Capabilities = command.RequiredCapabilities }]
        };
        byte[] metadata = Encoding.UTF8.GetBytes(json);
        DateTimeOffset now = DateTimeOffset.UtcNow;
        var package = new VerifiedAuthoringPackage(
            AuthoringExtensionContractValidator.Verify(manifest),
            new AuthoringPackageArtifact([], [], "acme", "key-1", "source/1", "provenance/1"),
            new AuthoringPackageArchiveContents([], [new AuthoringPackageEntry(
                VerifiedPackageAuthoringCommandSource.EntryPath, [.. metadata], Convert.ToHexStringLower(SHA256.HashData(metadata)))]),
            new AuthoringPackageTrustDecision(AuthoringPackageTrustStatus.Trusted, "acme", "key-1", now, now.AddMinutes(5)),
            new string('f', 64));
        AuthoringContributionDeclaration declaration = manifest.Contributions[0];
        ImmutableArray<AuthoringExecutionTarget> targets =
        [
            new AuthoringExecutionTarget(
                AuthoringExecutionResolutionStatus.Ready, declaration.ExecutionClass,
                manifest.Id, manifest.Version, manifest.PackageSha256, declaration.Id, declaration.Kind,
                declaration.Entrypoint.PathOrAdapterId, null, command.RuntimeIdentity, null)
        ];
        return (package, targets);
    }
}
