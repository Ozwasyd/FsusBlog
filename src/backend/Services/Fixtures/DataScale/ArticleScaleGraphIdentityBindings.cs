using System.Collections.ObjectModel;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace FsusBlog.Server.Services.Fixtures.DataScale;

/// <summary>
/// Immutable, provider-neutral result of native identity allocation, keyed by canonical role.
/// The factory consumes these identities before computing hashes and envelopes. This object
/// does not allocate identities or certify their database provenance; the offline writer must
/// bind that provenance and this digest in its transaction/checkpoint evidence.
/// </summary>
public sealed class ArticleScaleGraphIdentityBindings
{
    public const string Schema = "fsusblog.article-scale-graph-identity-bindings.v1";

    public string PlanDigest
    {
        get;
    }
    public string SemanticArticleId
    {
        get;
    }
    public IReadOnlyDictionary<string, long> Ids
    {
        get;
    }
    public string Digest
    {
        get;
    }

    public ArticleScaleGraphIdentityBindings(
        string planDigest,
        string semanticArticleId,
        IReadOnlyDictionary<string, long> ids)
    {
        ArgumentNullException.ThrowIfNull(ids);
        if (planDigest is null || planDigest.Length != 71
            || !planDigest.StartsWith("sha256:", StringComparison.Ordinal)
            || planDigest.AsSpan(7).ContainsAnyExcept("0123456789abcdef"))
        {
            throw new ArgumentException("identity_plan_digest_invalid", nameof(planDigest));
        }
        ArgumentException.ThrowIfNullOrWhiteSpace(semanticArticleId);
        if (ids.Count == 0 || ids.Count > 256)
        {
            throw new ArgumentException("identity_role_count_invalid", nameof(ids));
        }
        var copy = new Dictionary<string, long>(StringComparer.Ordinal);
        foreach ((string role, long id) in ids)
        {
            if (id <= 0 || !(role == semanticArticleId
                || role.StartsWith(semanticArticleId + "/", StringComparison.Ordinal)))
            {
                throw new ArgumentException("identity_role_or_value_invalid", nameof(ids));
            }
            copy.Add(role, id);
        }
        PlanDigest = planDigest;
        SemanticArticleId = semanticArticleId;
        Ids = new ReadOnlyDictionary<string, long>(copy);
        var input = new StringBuilder();
        input.Append(Schema).Append('\n').Append(planDigest).Append('\n').Append(semanticArticleId).Append('\n');
        foreach ((string role, long id) in copy.OrderBy(pair => pair.Key, StringComparer.Ordinal))
        {
            input.Append(role.Length.ToString(CultureInfo.InvariantCulture)).Append(':')
                .Append(role).Append(':').Append(id.ToString(CultureInfo.InvariantCulture)).Append('\n');
        }
        Digest = "sha256:" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(input.ToString()))).ToLowerInvariant();
    }

    internal long Resolve(string role)
        => Ids.TryGetValue(role, out long id) ? id
            : throw new InvalidOperationException($"identity_role_missing: {role}");

    internal void ValidateFor(ArticleScalePlan plan, string semanticArticleId)
    {
        if (PlanDigest != ArticleScalePlanDigest.Compute(plan) || SemanticArticleId != semanticArticleId)
        {
            throw new InvalidOperationException("identity_plan_or_article_mismatch");
        }
    }
}
