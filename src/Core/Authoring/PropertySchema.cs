using System.Collections.Immutable;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace FsusBlog.V2.Core.Authoring;

public readonly record struct PropertyScope(string Site, Guid? UserId = null);

public sealed record PropertyDefinition(Guid Id, PropertyScope Scope, string MachineKey,
    ImmutableArray<PropertyName> Names, PropertySettings Settings, PropertyStatus Status, long Revision)
{
    public const int Version = 1;
    public string Digest => PropertyDigests.Definition(this);
}

public abstract record PropertyChange(Guid DefinitionId)
{
    public sealed record Create(Guid DefinitionId, string MachineKey, ImmutableArray<PropertyName> Names, PropertySettings Settings)
        : PropertyChange(DefinitionId);
    public sealed record Rename(Guid DefinitionId, ImmutableArray<PropertyName> Names) : PropertyChange(DefinitionId);
    public sealed record ChangeSettings(Guid DefinitionId, PropertySettings Settings) : PropertyChange(DefinitionId);
    public sealed record Deprecate(Guid DefinitionId) : PropertyChange(DefinitionId);
    public sealed record Delete(Guid DefinitionId) : PropertyChange(DefinitionId);
}

public sealed record PropertyCommand(Guid ActorId, Guid RequestId, long ExpectedSchemaRevision,
    long ExpectedDefinitionRevision, PropertyChange Change);

public sealed record PropertyReceipt(PropertyScope Scope, Guid ActorId, Guid RequestId, string CommandDigest,
    Guid DefinitionId, long SchemaRevision, long DefinitionRevision, PropertyStatus Status,
    string? BeforeDigest, string AfterDigest, long? AffectedCount);

public sealed record PropertyTransition(PropertySchema Schema, PropertyReceipt Receipt, bool Replayed = false);

public sealed class PropertySchemaException(string code, long? affectedCount = null) : InvalidOperationException(code)
{
    public string Code { get; } = code;
    public long? AffectedCount { get; } = affectedCount;
}

public sealed partial class PropertySchema
{
    public const int MaxDefinitions = 1_000;
    public const int MaxPageSize = 100;
    private const int MaxRetainedDefinitions = 4_000;
    private const int MaxDefinitionBytes = 512 * 1024;
    private readonly ImmutableDictionary<Guid, PropertyDefinition> definitions;

    public PropertySchema(PropertyScope scope)
        : this(scope, 0, ImmutableDictionary<Guid, PropertyDefinition>.Empty)
    {
        if (string.IsNullOrWhiteSpace(scope.Site) || scope.Site.Length > 128 || scope.Site.Trim() != scope.Site
            || scope.Site.Any(char.IsControl) || scope.UserId == Guid.Empty)
            throw PropertyValues.Invalid("scope");
    }

    private PropertySchema(PropertyScope scope, long revision, ImmutableDictionary<Guid, PropertyDefinition> definitions)
    {
        Scope = scope;
        Revision = revision;
        this.definitions = definitions;
    }

    public PropertyScope Scope { get; }
    public long Revision { get; }

    public PropertyDefinition? Find(Guid id) => definitions.GetValueOrDefault(id);

    public ImmutableArray<PropertyDefinition> Page(string? afterKey, int limit = MaxPageSize, PropertyKind? kind = null)
    {
        if (limit is < 1 or > MaxPageSize)
            throw PropertyValues.Invalid("page-size");

        return definitions.Values.Where(item => item.Status != PropertyStatus.Deleted
                && (kind is null || item.Settings.Kind == kind)
                && (afterKey is null || StringComparer.Ordinal.Compare(item.MachineKey, afterKey) > 0))
            .OrderBy(item => item.MachineKey, StringComparer.Ordinal).Take(limit).ToImmutableArray();
    }

    public static PropertySchema Restore(PropertyScope scope, long revision, IEnumerable<PropertyDefinition> snapshot)
    {
        var empty = new PropertySchema(scope);
        if (revision < 0 || snapshot is null)
            throw PropertyValues.Invalid("snapshot");

        var stored = empty.definitions.ToBuilder();
        var keys = new HashSet<string>(StringComparer.Ordinal);
        int active = 0;
        long revisionCount = 0;
        foreach (var definition in snapshot)
        {
            if (definition is null || definition.Scope != scope || definition.Id == Guid.Empty
                || !Enum.IsDefined(definition.Status) || definition.Revision <= 0
                || definition.Revision > revision - revisionCount || stored.Count >= MaxRetainedDefinitions
                || definition.Settings is null || definition.Settings.Options.IsDefault
                || definition.MachineKey != NormalizeKey(definition.MachineKey)
                || !keys.Add(definition.MachineKey) || stored.ContainsKey(definition.Id))
                throw PropertyValues.Invalid("snapshot-definition");

            if (definition.Status != PropertyStatus.Deleted && ++active > MaxDefinitions)
                throw PropertyValues.Invalid("schema-budget");

            var canonical = definition with
            {
                Names = NormalizeNames(definition.Names),
                Settings = PropertyValues.NormalizeSettings(definition.Settings)
            };
            byte[] encoded = PropertyDigests.Encode(canonical);
            if (encoded.Length > MaxDefinitionBytes)
                throw PropertyValues.Invalid("definition-budget");
            if (!encoded.AsSpan().SequenceEqual(PropertyDigests.Encode(definition)))
                throw PropertyValues.Invalid("snapshot-canonical");

            stored.Add(canonical.Id, canonical);
            revisionCount += canonical.Revision;
        }

        if (revisionCount != revision)
            throw PropertyValues.Invalid("snapshot-revision");
        return new(scope, revision, stored.ToImmutable());
    }

    /// <summary>
    /// Call from the authoritative write transaction after authenticating the actor and locking the
    /// schema scope. Load the replay by (scope, actor ID, request ID) and measure impact against the same
    /// transaction snapshot. Save the transition and its receipt together with the database revision CAS.
    /// </summary>
    public PropertyTransition Apply(PropertyCommand command, PropertyReceipt? replay = null,
        Func<PropertyDefinition?, PropertyDefinition, long?>? countAffected = null)
    {
        if (command is null || command.Change is null || command.ActorId == Guid.Empty || command.RequestId == Guid.Empty
            || command.Change.DefinitionId == Guid.Empty || command.ExpectedDefinitionRevision < 0
            || command.ExpectedSchemaRevision < 0)
            throw PropertyValues.Invalid("command");

        PropertyChange change = Normalize(command.Change);
        string commandDigest = PropertyDigests.Command(Scope, command with { Change = change });
        if (replay is not null)
        {
            if (replay.Scope != Scope || replay.ActorId != command.ActorId || replay.RequestId != command.RequestId
                || replay.SchemaRevision > Revision || replay.DefinitionId != change.DefinitionId
                || replay.CommandDigest != commandDigest)
                throw new PropertySchemaException("idempotency-conflict");
            return new(this, replay, Replayed: true);
        }

        if (command.ExpectedSchemaRevision != Revision)
            throw new PropertySchemaException("schema-conflict");

        var before = Find(change.DefinitionId);
        if ((before?.Revision ?? 0) != command.ExpectedDefinitionRevision)
            throw new PropertySchemaException("definition-conflict");

        var after = Plan(change, before);
        var canonical = PropertyDigests.Encode(after);
        if (canonical.Length > MaxDefinitionBytes)
            throw PropertyValues.Invalid("definition-budget");

        long? affected = null;
        if (RequiresImpact(before, after))
        {
            affected = countAffected?.Invoke(before, after);
            if (affected is null or < 0)
                throw new PropertySchemaException("impact-unavailable");
            if (affected > 0 && command.Change is not PropertyChange.Deprecate)
                throw new PropertySchemaException("reconciliation-required", affected);
        }

        var next = new PropertySchema(Scope, checked(Revision + 1), definitions.SetItem(after.Id, after));
        var receipt = new PropertyReceipt(Scope, command.ActorId, command.RequestId, commandDigest, after.Id,
            next.Revision, after.Revision, after.Status, before?.Digest, PropertyDigests.Hash(canonical), affected);
        return new(next, receipt);
    }

    private PropertyDefinition Plan(PropertyChange change, PropertyDefinition? before)
    {
        if (change is PropertyChange.Create create)
        {
            if (before is not null || definitions.Values.Any(item => item.MachineKey == create.MachineKey))
                throw new PropertySchemaException("identity-conflict");
            if (create.Settings.Options.Any(item => item.Status != PropertyStatus.Active))
                throw new PropertySchemaException("new-option-status");
            if (definitions.Count >= MaxRetainedDefinitions
                || definitions.Values.Count(item => item.Status != PropertyStatus.Deleted) >= MaxDefinitions)
                throw new PropertySchemaException("schema-budget");
            return new(create.DefinitionId, Scope, create.MachineKey, create.Names, create.Settings, PropertyStatus.Active, 1);
        }

        if (before is null || before.Status == PropertyStatus.Deleted)
            throw new PropertySchemaException("definition-unavailable");

        PropertyDefinition after = change switch
        {
            PropertyChange.Rename rename => before with { Names = rename.Names },
            PropertyChange.ChangeSettings settings when before.Status == PropertyStatus.Active =>
                before with { Settings = ApplySettings(before.Settings, settings.Settings) },
            PropertyChange.Deprecate when before.Status == PropertyStatus.Active =>
                before with { Status = PropertyStatus.Deprecated },
            PropertyChange.Delete when before.Status == PropertyStatus.Deprecated =>
                before with { Status = PropertyStatus.Deleted },
            _ => throw new PropertySchemaException("status-transition")
        };
        return after with { Revision = checked(before.Revision + 1) };
    }

    private static PropertyChange Normalize(PropertyChange change) => change switch
    {
        PropertyChange.Create create => create with
        {
            MachineKey = NormalizeKey(create.MachineKey),
            Names = NormalizeNames(create.Names),
            Settings = PropertyValues.NormalizeSettings(create.Settings)
        },
        PropertyChange.Rename rename => rename with { Names = NormalizeNames(rename.Names) },
        PropertyChange.ChangeSettings settings => settings with { Settings = PropertyValues.NormalizeSettings(settings.Settings) },
        PropertyChange.Deprecate or PropertyChange.Delete => change,
        _ => throw PropertyValues.Invalid("command-kind")
    };

    private static PropertySettings ApplySettings(PropertySettings before, PropertySettings after)
    {
        if (before.Kind != after.Kind || before.Reference?.Multiple != after.Reference?.Multiple)
            throw new PropertySchemaException("type-migration-required");

        var nextOptions = after.Options.ToDictionary(item => item.Id);
        foreach (var option in before.Options)
        {
            if (!nextOptions.TryGetValue(option.Id, out var next) || next.Status < option.Status
                || option.Status == PropertyStatus.Deleted && next != option)
                throw new PropertySchemaException("option-lifecycle");
        }
        if (after.Options.Any(item => item.Status != PropertyStatus.Active && before.Options.All(old => old.Id != item.Id)))
            throw new PropertySchemaException("new-option-status");

        return after;
    }

    private static bool RequiresImpact(PropertyDefinition? before, PropertyDefinition after)
    {
        var settings = after.Settings;
        if (before is null)
            return settings.Presence.Required || settings.Presence.ApplyDefault;
        if (before.Status != after.Status)
            return true;

        var previous = before.Settings;
        var nextOptions = settings.Options.ToDictionary(item => item.Id);
        return !PropertyDigests.Encode(previous with { Options = [] }).AsSpan()
                .SequenceEqual(PropertyDigests.Encode(settings with { Options = [] }))
            || previous.Options.Any(option => option.Status != nextOptions[option.Id].Status);
    }

    private static string NormalizeKey(string key)
    {
        string? normalized = key?.Trim().ToLowerInvariant();
        if (normalized is null || normalized.Length > 64 || !KeyPattern().IsMatch(normalized))
            throw PropertyValues.Invalid("machine-key");
        return normalized;
    }

    private static ImmutableArray<PropertyName> NormalizeNames(ImmutableArray<PropertyName> names)
    {
        if (names.IsDefault || names.Length is < 1 or > 16)
            throw PropertyValues.Invalid("name-count");

        var locales = new HashSet<string>(StringComparer.Ordinal);
        var normalized = ImmutableArray.CreateBuilder<PropertyName>(names.Length);
        foreach (var name in names)
        {
            string? locale = name?.Locale?.Trim().ToLowerInvariant();
            if (locale is null || locale.Length > 32 || !LocalePattern().IsMatch(locale) || !locales.Add(locale))
                throw PropertyValues.Invalid("locale");
            normalized.Add(new(locale, PropertyValues.NormalizeLabel(name!.Label)));
        }
        return normalized.OrderBy(name => name.Locale, StringComparer.Ordinal).ToImmutableArray();
    }

    [GeneratedRegex("^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$", RegexOptions.CultureInvariant)]
    private static partial Regex KeyPattern();

    [GeneratedRegex("^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$", RegexOptions.CultureInvariant)]
    private static partial Regex LocalePattern();
}

internal static class PropertyDigests
{
    internal static byte[] Encode(PropertyDefinition definition) => JsonSerializer.SerializeToUtf8Bytes(new
    {
        PropertyDefinition.Version, definition.Id, definition.Scope, definition.MachineKey, definition.Names,
        Settings = Settings(definition.Settings), definition.Status, definition.Revision
    });

    internal static byte[] Encode(PropertySettings settings) => JsonSerializer.SerializeToUtf8Bytes(Settings(settings));

    internal static string Definition(PropertyDefinition definition) => Hash(Encode(definition));

    internal static string Command(PropertyScope scope, PropertyCommand command)
    {
        object detail = command.Change switch
        {
            PropertyChange.Create create => new { Kind = "create", create.MachineKey, create.Names, Settings = Settings(create.Settings) },
            PropertyChange.Rename rename => new { Kind = "rename", rename.Names },
            PropertyChange.ChangeSettings change => new { Kind = "change-settings", Settings = Settings(change.Settings) },
            PropertyChange.Deprecate => new { Kind = "deprecate" },
            PropertyChange.Delete => new { Kind = "delete" },
            _ => throw PropertyValues.Invalid("command-kind")
        };
        return Hash(JsonSerializer.SerializeToUtf8Bytes(new
        {
            PropertyDefinition.Version, scope, command.ActorId, command.RequestId, command.ExpectedSchemaRevision,
            command.ExpectedDefinitionRevision, command.Change.DefinitionId, Detail = detail
        }));
    }

    private static object Settings(PropertySettings settings) => new
    {
        settings.Kind, settings.Presence, Default = Value(settings.Default), settings.TextRange, settings.NumberRange,
        settings.DateRange, settings.CountRange, settings.Options, settings.Reference, settings.Url,
        settings.SearchEligible, settings.Filterable, settings.Sortable, settings.Placement, settings.Visibility
    };

    private static object? Value(PropertyValue? value) => value switch
    {
        null => null,
        PropertyValue.Null => new { Kind = "null" },
        PropertyValue.Text text => new { Kind = "text", text.Value },
        PropertyValue.Number number => new { Kind = "number", number.Value },
        PropertyValue.Boolean flag => new { Kind = "boolean", flag.Value },
        PropertyValue.Date date => new { Kind = "date", date.Value },
        PropertyValue.SingleSelect selection => new { Kind = "single-select", selection.OptionId },
        PropertyValue.MultiSelect selection => new { Kind = "multi-select", selection.OptionIds },
        PropertyValue.ArticleReference reference => new { Kind = "article-reference", reference.ArticleIds },
        PropertyValue.Url url => new { Kind = "url", url.Value },
        _ => throw PropertyValues.Invalid("value-kind")
    };

    internal static string Hash(byte[] value) => Convert.ToHexStringLower(SHA256.HashData(value));
}
