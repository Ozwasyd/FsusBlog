using System.Collections.Immutable;
using System.Text;

namespace FsusBlog.V2.Core.Authoring;

public enum PropertyKind { Text, Number, Boolean, Date, SingleSelect, MultiSelect, ArticleReference, Url }
public enum PropertyStatus { Active, Deprecated, Deleted }
public enum PropertyPlacement { Hidden, Metadata, Sidebar }
public enum PropertyVisibility { AuthorOnly, SiteEditors, SiteReaders }
public enum PropertyEmptyPolicy { Preserve, TreatAsNull, Reject }

public abstract record PropertyValue
{
    private PropertyValue() { }

    public sealed record Null : PropertyValue;
    public sealed record Text(string Value) : PropertyValue;
    public sealed record Number(decimal Value) : PropertyValue;
    public sealed record Boolean(bool Value) : PropertyValue;
    public sealed record Date(DateTimeOffset Value) : PropertyValue;
    public sealed record SingleSelect(Guid OptionId) : PropertyValue;
    public sealed record MultiSelect(ImmutableArray<Guid> OptionIds) : PropertyValue;
    public sealed record ArticleReference(ImmutableArray<long> ArticleIds) : PropertyValue;
    public sealed record Url(string Value) : PropertyValue;
}

public sealed record PropertyName(string Locale, string Label);
public sealed record PropertyOption(Guid Id, string Label, int Order, PropertyStatus Status = PropertyStatus.Active);
public sealed record PropertyPresence(bool Required = false, bool AllowNull = true, bool ApplyDefault = false,
    PropertyEmptyPolicy Empty = PropertyEmptyPolicy.Preserve);
public sealed record PropertyTextRange(int Min = 0, int Max = 16_384);
public sealed record PropertyNumberRange(decimal? Min = null, decimal? Max = null);
public sealed record PropertyDateRange(DateTimeOffset? Min = null, DateTimeOffset? Max = null);
public sealed record PropertyCountRange(int Min = 0, int Max = 1_000);
public sealed record PropertyUrlPolicy(bool AllowHttps = true, bool AllowHttp = false, bool AllowRelative = false,
    int MaxLength = 2_048);
public sealed record PropertyReferencePolicy(bool Multiple = false, bool AllowArchived = false,
    bool AllowSelf = false, bool AllowCycles = false);

public sealed record PropertySettings(
    PropertyKind Kind,
    PropertyPresence Presence,
    PropertyValue? Default = null,
    PropertyTextRange? TextRange = null,
    PropertyNumberRange? NumberRange = null,
    PropertyDateRange? DateRange = null,
    PropertyCountRange? CountRange = null,
    ImmutableArray<PropertyOption> Options = default,
    PropertyReferencePolicy? Reference = null,
    PropertyUrlPolicy? Url = null,
    bool SearchEligible = false,
    bool Filterable = false,
    bool Sortable = false,
    PropertyPlacement Placement = PropertyPlacement.Hidden,
    PropertyVisibility Visibility = PropertyVisibility.AuthorOnly);

public readonly record struct PropertyReferenceFacts(string Site, bool MayRead, bool Deleted, bool Archived, bool FormsCycle);

public static class PropertyValues
{
    private static readonly string[] PresenceOperators = ["value.is-missing", "value.is-present"];
    private static readonly string[][] Operators =
    [
        ["text.equals", "text.contains"],
        ["number.equals", "number.less-than", "number.less-than-or-equal", "number.greater-than",
            "number.greater-than-or-equal", "number.between"],
        ["boolean.equals"],
        ["date.before", "date.on-or-before", "date.after", "date.on-or-after", "date.between"],
        ["select.equals", "select.any-of"],
        ["select.equals", "select.any-of"],
        ["reference.equals", "reference.any-of"],
        ["url.equals", "url.host", "url.scheme"]
    ];

    public static bool SupportsOperator(PropertyKind kind, string operation) =>
        Enum.IsDefined(kind) && (PresenceOperators.Contains(operation) || Operators[(int)kind].Contains(operation));

    internal static PropertySettings NormalizeSettings(PropertySettings settings)
    {
        if (settings is null)
            throw Invalid("settings");

        var presence = settings.Presence;
        if (!Enum.IsDefined(settings.Kind) || !Enum.IsDefined(settings.Visibility)
            || !Enum.IsDefined(settings.Placement) || presence is null || !Enum.IsDefined(presence.Empty)
            || presence.Required && presence.AllowNull || presence.ApplyDefault && settings.Default is null)
            throw Invalid("settings");

        var kind = settings.Kind;
        bool multiple = kind == PropertyKind.MultiSelect || settings.Reference is { Multiple: true };
        bool select = kind is PropertyKind.SingleSelect or PropertyKind.MultiSelect;
        if ((kind == PropertyKind.ArticleReference) != (settings.Reference is not null)
            || (kind == PropertyKind.Url) != (settings.Url is not null)
            || kind != PropertyKind.Text && settings.TextRange is not null
            || kind != PropertyKind.Number && settings.NumberRange is not null
            || kind != PropertyKind.Date && settings.DateRange is not null
            || !multiple && settings.CountRange is not null)
            throw Invalid("constraints-kind");

        if (settings.TextRange is { } text && (text.Min < 0 || text.Max < text.Min || text.Max > 16_384)
            || settings.NumberRange is { } number && number.Min > number.Max
            || settings.DateRange is { } date && date.Min > date.Max
            || settings.CountRange is { } count && (count.Min < 0 || count.Max < count.Min || count.Max > 1_000)
            || settings.Url is { } url && (url.MaxLength is < 1 or > 2_048
                || !url.AllowHttps && !url.AllowHttp && !url.AllowRelative))
            throw Invalid("constraints-range");

        var options = settings.Options.IsDefault ? ImmutableArray<PropertyOption>.Empty : settings.Options;
        if (select != (options.Length > 0) || options.Length > 1_000)
            throw Invalid("options-count");

        var ids = new HashSet<Guid>();
        var orders = new HashSet<int>();
        foreach (var option in options)
        {
            if (option is null || option.Id == Guid.Empty || option.Order < 0 || !Enum.IsDefined(option.Status)
                || !ids.Add(option.Id) || !orders.Add(option.Order))
                throw Invalid("option-identity");
        }

        var normalized = settings with
        {
            Options = options
                .Select(option => option with { Label = NormalizeLabel(option.Label) })
                .OrderBy(option => option.Order).ToImmutableArray(),
            Default = null,
            DateRange = settings.DateRange is { } dateRange
                ? new PropertyDateRange(dateRange.Min?.ToUniversalTime(), dateRange.Max?.ToUniversalTime())
                : null
        };
        return normalized with { Default = settings.Default is { } value ? NormalizePresent(normalized, value) : null };
    }

    /// <summary>Null input is missing. Pass PropertyValue.Null to supply an explicit null.</summary>
    public static PropertyValue? Validate(
        PropertyDefinition definition,
        PropertyValue? value,
        long sourceArticleId,
        Func<long, PropertyReferenceFacts?>? referenceFacts = null)
    {
        if (definition.Status != PropertyStatus.Active || sourceArticleId <= 0)
            throw Invalid("value-target");

        PropertySettings settings = definition.Settings;
        PropertyValue? candidate = value ?? (settings.Presence.ApplyDefault ? settings.Default : null);
        if (candidate is null)
        {
            if (settings.Presence.Required)
                throw Invalid("required");
            return null;
        }

        var normalized = NormalizePresent(settings, candidate);
        if (normalized is PropertyValue.ArticleReference references)
        {
            var policy = settings.Reference!;
            foreach (long targetId in references.ArticleIds)
            {
                PropertyReferenceFacts? target = referenceFacts?.Invoke(targetId);
                if (target is not { MayRead: true, Deleted: false } facts
                    || !StringComparer.Ordinal.Equals(facts.Site, definition.Scope.Site)
                    || !policy.AllowArchived && facts.Archived
                    || !policy.AllowSelf && targetId == sourceArticleId
                    || !policy.AllowCycles && facts.FormsCycle)
                    throw Invalid("reference-unavailable");
            }
        }
        return normalized;
    }

    private static PropertyValue NormalizePresent(PropertySettings settings, PropertyValue value)
    {
        bool empty = (settings.Kind, value) switch
        {
            (PropertyKind.Text, PropertyValue.Text { Value.Length: 0 }) => true,
            (PropertyKind.MultiSelect, PropertyValue.MultiSelect values) => !values.OptionIds.IsDefault && values.OptionIds.IsEmpty,
            (PropertyKind.ArticleReference, PropertyValue.ArticleReference values) when settings.Reference is { Multiple: true } =>
                !values.ArticleIds.IsDefault && values.ArticleIds.IsEmpty,
            _ => false
        };
        if (empty && settings.Presence.Empty == PropertyEmptyPolicy.Reject)
            throw Invalid("empty");
        if (value is PropertyValue.Null || empty && settings.Presence.Empty == PropertyEmptyPolicy.TreatAsNull)
            return settings.Presence.AllowNull ? new PropertyValue.Null() : throw Invalid("null");

        return (settings.Kind, value) switch
        {
            (PropertyKind.Text, PropertyValue.Text text) => new PropertyValue.Text(NormalizeText(text.Value, settings.TextRange)),
            (PropertyKind.Number, PropertyValue.Number number)
                when settings.NumberRange is not { } range || InRange(number.Value, range.Min, range.Max) => number,
            (PropertyKind.Boolean, PropertyValue.Boolean flag) => flag,
            (PropertyKind.Date, PropertyValue.Date date)
                when settings.DateRange is not { } range || InRange(date.Value, range.Min, range.Max) =>
                new PropertyValue.Date(date.Value.ToUniversalTime()),
            (PropertyKind.SingleSelect, PropertyValue.SingleSelect selection)
                when IsActive(settings, selection.OptionId) => selection,
            (PropertyKind.MultiSelect, PropertyValue.MultiSelect selection) =>
                new PropertyValue.MultiSelect(ValidateSet(selection.OptionIds, settings.CountRange, id => IsActive(settings, id))),
            (PropertyKind.ArticleReference, PropertyValue.ArticleReference references) =>
                new PropertyValue.ArticleReference(ValidateSet(references.ArticleIds,
                    settings.Reference!.Multiple ? settings.CountRange : new PropertyCountRange(1, 1), id => id > 0)),
            (PropertyKind.Url, PropertyValue.Url url) => new PropertyValue.Url(NormalizeUrl(url.Value, settings.Url!)),
            _ => throw Invalid("value-kind-or-range")
        };
    }

    private static ImmutableArray<T> ValidateSet<T>(ImmutableArray<T> values, PropertyCountRange? range, Predicate<T> valid)
    {
        var bounds = range ?? new PropertyCountRange();
        if (values.IsDefault || values.Length < bounds.Min || values.Length > bounds.Max
            || values.Any(value => !valid(value)) || values.Distinct().Count() != values.Length)
            throw Invalid("value-items");
        return values.Order().ToImmutableArray();
    }

    private static bool InRange<T>(T value, T? min, T? max) where T : struct, IComparable<T> =>
        (!min.HasValue || value.CompareTo(min.Value) >= 0) && (!max.HasValue || value.CompareTo(max.Value) <= 0);

    private static bool IsActive(PropertySettings settings, Guid id) =>
        settings.Options.Any(option => option.Id == id && option.Status == PropertyStatus.Active);

    private static string NormalizeText(string value, PropertyTextRange? range)
    {
        var bounds = range ?? new PropertyTextRange();
        if (value is null || value.Length > 16_384 || value.Any(char.IsControl))
            throw Invalid("text");
        string result = NormalizeUnicode(value, "text");
        if (result.Length < bounds.Min || result.Length > bounds.Max)
            throw Invalid("text-length");
        return result;
    }

    internal static string NormalizeLabel(string value)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Length > 256 || value.Any(char.IsControl))
            throw Invalid("label");
        return NormalizeUnicode(value.Trim(), "label");
    }

    private static string NormalizeUrl(string value, PropertyUrlPolicy policy)
    {
        if (string.IsNullOrEmpty(value) || value.Length > policy.MaxLength
            || value.Any(character => char.IsControl(character) || char.IsWhiteSpace(character) || character == '\\')
            || !Uri.IsWellFormedUriString(value, UriKind.RelativeOrAbsolute))
            throw Invalid("url");

        if (value[0] == '/')
        {
            if (policy.AllowRelative && !value.StartsWith("//", StringComparison.Ordinal))
                return NormalizeUnicode(value, "url");
            throw Invalid("url-relative");
        }

        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri) || string.IsNullOrEmpty(uri.Host)
            || !string.IsNullOrEmpty(uri.UserInfo) || !(uri.Scheme == "https" && policy.AllowHttps
                || uri.Scheme == "http" && policy.AllowHttp))
            throw Invalid("url-scheme");

        var canonical = new UriBuilder(uri) { Host = uri.IdnHost }.Uri.AbsoluteUri;
        if (canonical.Length > policy.MaxLength)
            throw Invalid("url-length");
        return canonical;
    }

    private static string NormalizeUnicode(string value, string code)
    {
        try
        {
            return value.Normalize(NormalizationForm.FormC);
        }
        catch (ArgumentException)
        {
            throw Invalid(code);
        }
    }

    internal static PropertyValidationException Invalid(string code) => new(code);
}

public sealed class PropertyValidationException(string code) : ArgumentException(code)
{
    public string Code { get; } = code;
}
