using System.Collections.ObjectModel;
using System.Security.Cryptography;
using System.Text.Json;

namespace FsusBlog.Server.Services.Fixtures.DataScale;

public enum DataScaleNativeCommentEntity
{
    Comment,
    Revision,
    ModerationEvent,
    OutboxEnvelope,
    OutboxEdge
}

/// <summary>Exact factory occurrence and entity role, never an ordinal-derived native ID.</summary>
public sealed record DataScaleNativeCommentRole(
    string ScenarioRole,
    long Repetition,
    string ArticleTargetRole,
    string CommentRole,
    DataScaleNativeCommentEntity Entity,
    string EntityRole);

/// <summary>An original-owner allocation artifact reference; equality alone does not verify provenance.</summary>
public sealed record DataScaleNativeAllocationReference(string OwnerContractId, string SourceCommit, string ContentDigest);

/// <summary>
/// Frozen comment/revision/event binding transport for the shared kernel. It does not allocate,
/// qualify an allocator or turn symbolic comment intents into physical rows. Consumers must
/// verify the original native allocation artifact and use the sole production row authorities.
/// </summary>
public sealed class DataScaleNativeCommentBindings
{
    public const string Schema = "fsusblog.data-scale-native-comment-bindings.v1";
    public string RunId
    {
        get;
    }
    public string Namespace
    {
        get;
    }
    public string RuntimeIdentity
    {
        get;
    }
    public string Provider
    {
        get;
    }
    public string CommentPlanDigest
    {
        get;
    }
    public string ArticlePlanDigest
    {
        get;
    }
    public DataScaleNativeAllocationReference Allocation
    {
        get;
    }
    public IReadOnlyDictionary<DataScaleNativeCommentRole, long> Ids
    {
        get;
    }
    public string Digest
    {
        get;
    }

    public DataScaleNativeCommentBindings(string runId, string @namespace, string runtimeIdentity, string provider,
        string commentPlanDigest, string articlePlanDigest, DataScaleNativeAllocationReference allocation,
        IReadOnlyDictionary<DataScaleNativeCommentRole, long> ids)
    {
        ArgumentNullException.ThrowIfNull(allocation);
        ArgumentNullException.ThrowIfNull(ids);
        foreach (string value in new[] { runId, @namespace, runtimeIdentity })
        {
            ArgumentException.ThrowIfNullOrWhiteSpace(value);
            if (value.Length > 256)
            {
                throw new ArgumentException("native_comment_binding_scope_bound_invalid");
            }
        }
        if (provider is not ("PostgreSql" or "MySql" or "Sqlite") || !IsDigest(commentPlanDigest) || !IsDigest(articlePlanDigest)
            || string.IsNullOrWhiteSpace(allocation.OwnerContractId) || allocation.OwnerContractId.Length > 256
            || allocation.SourceCommit.Length != 40 || allocation.SourceCommit.AsSpan().ContainsAnyExcept("0123456789abcdef")
            || !IsDigest(allocation.ContentDigest) || ids.Count > 50_000)
        {
            throw new ArgumentException("native_comment_binding_header_invalid");
        }
        var copy = new Dictionary<DataScaleNativeCommentRole, long>();
        var unique = new HashSet<(DataScaleNativeCommentEntity Entity, long Id)>();
        foreach ((DataScaleNativeCommentRole role, long id) in ids)
        {
            if (role.Repetition < 0 || !Enum.IsDefined(role.Entity) || id <= 0
                || new[] { role.ScenarioRole, role.ArticleTargetRole, role.CommentRole, role.EntityRole }
                    .Any(value => string.IsNullOrWhiteSpace(value) || value.Length > 256)
                || !unique.Add((role.Entity, id)))
            {
                throw new ArgumentException("native_comment_role_or_duplicate_id_invalid");
            }
            copy.Add(role, id);
        }
        RunId = runId;
        Namespace = @namespace;
        RuntimeIdentity = runtimeIdentity;
        Provider = provider;
        CommentPlanDigest = commentPlanDigest;
        ArticlePlanDigest = articlePlanDigest;
        Allocation = allocation;
        Ids = new ReadOnlyDictionary<DataScaleNativeCommentRole, long>(copy);
        Digest = "sha256:" + Convert.ToHexString(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(new
        {
            Schema,
            RunId,
            Namespace,
            RuntimeIdentity,
            Provider,
            CommentPlanDigest,
            ArticlePlanDigest,
            Allocation,
            Roles = copy.OrderBy(pair => pair.Key.ScenarioRole, StringComparer.Ordinal).ThenBy(pair => pair.Key.Repetition)
                .ThenBy(pair => pair.Key.ArticleTargetRole, StringComparer.Ordinal).ThenBy(pair => pair.Key.CommentRole, StringComparer.Ordinal)
                .ThenBy(pair => pair.Key.Entity).ThenBy(pair => pair.Key.EntityRole, StringComparer.Ordinal)
                .Select(pair => new { Role = pair.Key, Id = pair.Value }).ToArray()
        }))).ToLowerInvariant();
    }

    public void RequireCoverage(IEnumerable<DataScaleNativeCommentRole> factoryRoles)
    {
        DataScaleNativeCommentRole[] expected = factoryRoles.ToArray();
        if (expected.Length != expected.Distinct().Count() || !expected.ToHashSet().SetEquals(Ids.Keys))
        {
            throw new InvalidOperationException("native_comment_factory_role_coverage_mismatch");
        }
    }

    public long Resolve(DataScaleNativeCommentRole role)
        => Ids.TryGetValue(role, out long id) ? id : throw new InvalidOperationException("native_comment_role_missing");

    private static bool IsDigest(string value)
        => value.Length == 71 && value.StartsWith("sha256:", StringComparison.Ordinal)
            && !value.AsSpan(7).ContainsAnyExcept("0123456789abcdef");
}
