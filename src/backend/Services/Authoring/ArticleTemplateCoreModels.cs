using System.Collections.Frozen;
using System.Text;

namespace FsusBlog.Server.Services.Authoring;

public enum ArticleTemplateScopeKind : short
{
    Personal = 0,
    Site = 1
}

public enum ArticleTemplateStatus : short
{
    Active = 0,
    Retired = 1,
    Deleted = 2
}

public enum ArticleTemplatePermission : short
{
    Read = 0,
    Use = 1,
    Manage = 2
}

public enum ArticleTemplateVariableToken : short
{
    Title = 0,
    Date = 1,
    Author = 2,
    SiteLocale = 3
}

public enum ArticleTemplatePropertyValueKind : short
{
    Text = 0,
    Number = 1,
    Boolean = 2,
    Date = 3,
    SingleSelect = 4,
    MultiSelect = 5,
    ArticleReference = 6,
    Url = 7
}

public enum ArticleTemplateDeleteDisposition : short
{
    NotApplicable = 0,
    TombstonedHistoryPreserved = 1
}

public readonly record struct ArticleTemplateScope(
    ArticleTemplateScopeKind Kind,
    long? OwnerAdminPrincipalId);

public sealed record ArticleTemplateActor
{
    private readonly IReadOnlySet<string> _permissions;

    public ArticleTemplateActor(long adminPrincipalId, IEnumerable<string> permissions)
    {
        ArgumentNullException.ThrowIfNull(permissions);
        AdminPrincipalId = adminPrincipalId;
        _permissions = permissions.ToFrozenSet(StringComparer.Ordinal);
        ArticleTemplateContract.ValidateActor(this);
    }

    public long AdminPrincipalId
    {
        get;
    }
    public IReadOnlySet<string> Permissions => _permissions;
}

public sealed class ArticleTemplateSource
{
    private readonly byte[] _bytes;

    private ArticleTemplateSource(byte[] bytes, IReadOnlyList<ArticleTemplateVariableToken> tokens)
    {
        _bytes = bytes;
        VariableTokens = tokens;
    }

    public IReadOnlyList<ArticleTemplateVariableToken> VariableTokens
    {
        get;
    }
    public int Length => _bytes.Length;

    public static ArticleTemplateSource FromUtf8(string source)
    {
        ArgumentNullException.ThrowIfNull(source);
        byte[] bytes = new UTF8Encoding(false, true).GetBytes(source);
        var result = new ArticleTemplateSource(
            bytes,
            ArticleTemplateContract.ParseVariableTokens(source));
        ArticleTemplateContract.ValidateSource(result);
        return result;
    }

    public static ArticleTemplateSource FromBytes(ReadOnlySpan<byte> source)
    {
        byte[] bytes = source.ToArray();
        string text;
        try
        {
            text = new UTF8Encoding(false, true).GetString(bytes);
        }
        catch (DecoderFallbackException)
        {
            throw new ArticleTemplateValidationException("article_template_source_utf8_invalid");
        }
        var result = new ArticleTemplateSource(
            bytes,
            ArticleTemplateContract.ParseVariableTokens(text));
        ArticleTemplateContract.ValidateSource(result);
        return result;
    }

    public ReadOnlySpan<byte> AsSpan() => _bytes;
    public byte[] ToArray() => [.. _bytes];
    public string GetText() => new UTF8Encoding(false, true).GetString(_bytes);
}

public sealed class ArticleTemplatePropertyDefault
{
    public ArticleTemplatePropertyDefault(
        Guid definitionId,
        ArticleTemplatePropertyValueKind valueKind,
        string? canonicalValue,
        IEnumerable<Guid>? optionIds = null)
    {
        DefinitionId = definitionId;
        ValueKind = valueKind;
        CanonicalValue = canonicalValue;
        OptionIds = Array.AsReadOnly(
            (optionIds ?? []).Distinct().Order().ToArray());
    }

    public Guid DefinitionId
    {
        get;
    }
    public ArticleTemplatePropertyValueKind ValueKind
    {
        get;
    }
    public string? CanonicalValue
    {
        get;
    }
    public IReadOnlyList<Guid> OptionIds
    {
        get;
    }
}
