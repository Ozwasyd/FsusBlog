using System.Collections.Immutable;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace FsusBlog.Server.Infrastructure.AuthoringExtensions;

public interface IAuthoringCommandContributionSource
{
    ImmutableArray<AuthoringCommandContribution> Read(
        VerifiedAuthoringPackage package,
        ImmutableArray<AuthoringExecutionTarget> targets);
}

public sealed class VerifiedPackageAuthoringCommandSource : IAuthoringCommandContributionSource
{
    public const string EntryPath = "authoring/commands.v1.json";

    private static readonly JsonSerializerOptions s_json = new()
    {
        MaxDepth = 16,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = false,
        ReadCommentHandling = JsonCommentHandling.Disallow,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        RespectRequiredConstructorParameters = true
    };

    public ImmutableArray<AuthoringCommandContribution> Read(
        VerifiedAuthoringPackage package,
        ImmutableArray<AuthoringExecutionTarget> targets)
    {
        ArgumentNullException.ThrowIfNull(package);
        if (targets.IsDefault)
        {
            throw new AuthoringExtensionContractException("Command contribution targets are missing.");
        }

        ImmutableArray<AuthoringContributionDeclaration> declarations =
        [
            .. package.Contract.Manifest.Contributions.Where(static contribution =>
                contribution.Kind is AuthoringContributionKind.Command or
                    AuthoringContributionKind.CommandPaletteMetadata)
        ];
        AuthoringPackageEntry[] entries =
        [
            .. package.Contents.Entries.Where(candidate =>
                string.Equals(candidate.Path, EntryPath, StringComparison.Ordinal))
        ];
        if (entries.Length > 1)
        {
            throw new AuthoringExtensionContractException("Package contains duplicate signed command metadata.");
        }
        AuthoringPackageEntry? entry = entries.SingleOrDefault();
        if (declarations.IsEmpty)
        {
            if (entry is not null)
            {
                throw new AuthoringExtensionContractException(
                    "Package carries command metadata without a declared command contribution.");
            }

            return [];
        }

        if (entry is null)
        {
            throw new AuthoringExtensionContractException("Declared command contribution has no signed command metadata.");
        }
        if (entry.Content.IsDefault || entry.Content.Length > 1024 * 1024)
        {
            throw new AuthoringExtensionContractException("Signed command metadata is missing or outside its byte bound.");
        }

        try
        {
            using JsonDocument document = JsonDocument.Parse(entry.Content.ToArray(), new JsonDocumentOptions
            {
                CommentHandling = JsonCommentHandling.Disallow,
                MaxDepth = 16
            });
            RejectDuplicateProperties(document.RootElement);
            AuthoringCommandContribution?[] commands = JsonSerializer.Deserialize<AuthoringCommandContribution?[]>(
                entry.Content.AsSpan(),
                s_json) ?? [];
            if (commands.Length != declarations.Length || commands.Length > AuthoringCommandRegistry.MaximumCommands ||
                commands.Any(static command => command is null) ||
                commands.Select(static command => command!.ContributionId)
                    .Distinct(StringComparer.Ordinal).Count() != commands.Length ||
                targets.Select(static target => target.ContributionId)
                    .Distinct(StringComparer.Ordinal).Count() != targets.Length)
            {
                throw new AuthoringExtensionContractException(
                    "Signed command metadata is partial or outside the canonical registry bound.");
            }

            ImmutableDictionary<string, AuthoringExecutionTarget> targetsByContribution = targets
                .ToImmutableDictionary(static target => target.ContributionId, StringComparer.Ordinal);
            foreach (AuthoringCommandContribution? candidate in commands)
            {
                AuthoringCommandContribution command = candidate!;
                AuthoringContributionDeclaration declaration = declarations.SingleOrDefault(candidate =>
                    string.Equals(candidate.Id, command.ContributionId, StringComparison.Ordinal)) ??
                    throw new AuthoringExtensionContractException(
                        "Signed command metadata does not match a declared contribution.");
                if (!targetsByContribution.TryGetValue(command.ContributionId, out AuthoringExecutionTarget? target) ||
                    !string.Equals(command.ExtensionId, package.Contract.Manifest.Id, StringComparison.Ordinal) ||
                    !string.Equals(command.ExtensionVersion, package.Contract.Manifest.Version, StringComparison.Ordinal) ||
                    !string.Equals(command.PackageSha256, package.Contract.Manifest.PackageSha256, StringComparison.Ordinal) ||
                    !string.Equals(command.ContentSha256, package.Contract.Manifest.ContentSha256, StringComparison.Ordinal) ||
                    !string.Equals(command.RuntimeIdentity, target.RuntimeIdentity, StringComparison.Ordinal) ||
                    command.ExecutionClass != declaration.ExecutionClass ||
                    command.ExecutionClass != target.ExecutionClass ||
                    !command.RequiredCapabilities.Order().SequenceEqual(declaration.Capabilities.Order()))
                {
                    throw new AuthoringExtensionContractException(
                        "Signed command metadata drifted from its package, runtime, or capability identity.");
                }
            }

            ImmutableArray<AuthoringCommandContribution> result = [.. commands.Select(static command => command!)];
            _ = new AuthoringCommandRegistry(
                result,
                ImmutableHashSet<string>.Empty.WithComparer(StringComparer.Ordinal),
                ImmutableHashSet<string>.Empty.WithComparer(StringComparer.OrdinalIgnoreCase));
            return result;
        }
        catch (JsonException exception)
        {
            throw new AuthoringExtensionContractException(
                $"Signed command metadata is not closed JSON: {exception.GetType().Name}.");
        }
    }

    private static void RejectDuplicateProperties(JsonElement element)
    {
        if (element.ValueKind == JsonValueKind.Object)
        {
            var names = new HashSet<string>(StringComparer.Ordinal);
            foreach (JsonProperty property in element.EnumerateObject())
            {
                if (!names.Add(property.Name))
                {
                    throw new AuthoringExtensionContractException(
                        "Signed command metadata contains a duplicate property.");
                }

                RejectDuplicateProperties(property.Value);
            }
        }
        else if (element.ValueKind == JsonValueKind.Array)
        {
            foreach (JsonElement item in element.EnumerateArray())
            {
                RejectDuplicateProperties(item);
            }
        }
    }
}

public sealed record AuthoringCommandAuthorityReport(int Commands, int Surfaces)
{
    public bool IsEmpty => Commands == 0 && Surfaces == 0;
}

public sealed class AuthoringCommandRegistryAuthority(
    IAuthoringCommandContributionSource source,
    ImmutableHashSet<string> coreCommandIds,
    ImmutableHashSet<string> coreOrUserShortcuts)
{
    private readonly Lock _lock = new();
    private readonly Dictionary<string, ImmutableArray<AuthoringCommandContribution>> _active =
        new(StringComparer.Ordinal);

    public AuthoringCommandAuthorityReport Activate(
        VerifiedAuthoringPackage package,
        ImmutableArray<AuthoringExecutionTarget> targets)
    {
        ImmutableArray<AuthoringCommandContribution> commands = source.Read(package, targets);
        lock (_lock)
        {
            if (_active.ContainsKey(package.Contract.Manifest.Id))
            {
                throw new AuthoringExtensionContractException("Authoring command authority is already active.");
            }

            _ = BuildRegistry(_active.Values.SelectMany(static values => values).Concat(commands));
            _active.Add(package.Contract.Manifest.Id, commands);
        }

        return new AuthoringCommandAuthorityReport(
            commands.Length,
            commands.Sum(static command => command.PreferredSurfaces.Length));
    }

    public AuthoringCommandAuthorityReport Revoke(string extensionId)
    {
        ImmutableArray<AuthoringCommandContribution> removed;
        lock (_lock)
        {
            if (!_active.Remove(extensionId, out removed))
            {
                return new AuthoringCommandAuthorityReport(0, 0);
            }

            _ = BuildRegistry(_active.Values.SelectMany(static values => values));
        }

        return new AuthoringCommandAuthorityReport(
            removed.Length,
            removed.Sum(static command => command.PreferredSurfaces.Length));
    }

    public AuthoringCommandRegistry Snapshot()
    {
        lock (_lock)
        {
            return BuildRegistry(_active.Values.SelectMany(static values => values));
        }
    }

    private AuthoringCommandRegistry BuildRegistry(IEnumerable<AuthoringCommandContribution> commands) => new(
        [.. commands],
        coreCommandIds,
        coreOrUserShortcuts);
}
