using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace FsusBlog.Contracts.AuthoringWorkspace;

/// <summary>Authenticated user and site binding of the single default workspace.</summary>
public sealed record AuthoringWorkspaceSnapshotScope(long UserId, string SiteId);
/// <summary>Stable article and draft/document references, without source or editor state.</summary>
public sealed record AuthoringWorkspaceSnapshotIdentity(int? ArticleId, string DraftId, string DocumentId);
/// <summary>One unique recoverable tab reference and its exclusive preview or pinned state.</summary>
public sealed record AuthoringWorkspaceSnapshotTab(
    string TabId, AuthoringWorkspaceSnapshotIdentity Identity, bool IsPreview, bool IsPinned);
/// <summary>Ordered references to tabs owned by one of at most two groups.</summary>
public sealed record AuthoringWorkspaceSnapshotGroup(string GroupId, string[] TabIds, string? ActiveTabId);
/// <summary>Product shell views and open states, without article-specific scroll or selection.</summary>
public sealed record AuthoringWorkspaceSnapshotShell(
    bool LibraryOpen, string LibraryView, bool OutlineOpen, bool InspectorOpen, string InspectorView);
/// <summary>Bounded reference-only layout projection accepted by server CAS.</summary>
public sealed record AuthoringWorkspaceSnapshotLayout(
    AuthoringWorkspaceSnapshotTab[] Tabs, AuthoringWorkspaceSnapshotGroup[] Groups,
    string ActiveGroupId, int SplitRatioPermille, AuthoringWorkspaceSnapshotShell Shell);
/// <summary>Canonical server-owned snapshot with scope, revision, source binding and integrity digest.</summary>
public sealed record AuthoringWorkspaceSnapshot(
    int SchemaVersion, string WorkspaceId, AuthoringWorkspaceSnapshotScope Scope,
    string SourceContract, string SourceDigest, long Revision, long UpdatedAt,
    AuthoringWorkspaceSnapshotLayout Layout, string ContentDigest);

/// <summary>Closed, bounded reference-only contract. JSON is internal storage, never a public transport fallback.</summary>
public static class AuthoringWorkspaceSnapshotContract
{
    public const int SchemaVersion = 1;
    public const string WorkspaceId = "default";
    public const string SourceContract = "fsusblog.authoring-workspace-snapshot.v1";
    public const int MaxTabs = 100;
    public const int MaxGroups = 2;
    public const int MaxBytes = 65_536;
    public const int MaxDepth = 8;
    public const long MaxSafeInteger = 9_007_199_254_740_991;

    private static readonly JsonSerializerOptions s_options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        MaxDepth = MaxDepth
    };
    private static readonly JsonDocumentOptions s_documentOptions = new()
    {
        MaxDepth = MaxDepth
    };

    public static void ValidateScope(AuthoringWorkspaceSnapshotScope scope)
    {
        if (scope is null || scope.UserId <= 0 || scope.UserId > MaxSafeInteger || !IsId(scope.SiteId))
        {
            throw new AuthoringWorkspaceSnapshotException("invalid_scope");
        }
    }

    public static bool IsId(string? value)
        => value is { Length: >= 3 and <= 128 }
            && char.IsAsciiLetterOrDigit(value[0])
            && value.All(c => char.IsAsciiLetterOrDigit(c) || c is '.' or '_' or ':' or '-');

    public static bool IsDigest(string? value)
        => value is { Length: 64 } && value.All(c => c is >= '0' and <= '9' or >= 'a' and <= 'f');

    public static void ValidateLayout(AuthoringWorkspaceSnapshotLayout layout)
    {
        if (layout is null || layout.Tabs is null || layout.Groups is null || layout.Shell is null
            || layout.Tabs.Length > MaxTabs || layout.Groups.Length is < 1 or > MaxGroups
            || layout.SplitRatioPermille is < 200 or > 800)
        {
            throw new AuthoringWorkspaceSnapshotException("layout_budget_or_shape");
        }
        var tabIds = new HashSet<string>(StringComparer.Ordinal);
        var articles = new HashSet<int>();
        var drafts = new HashSet<string>(StringComparer.Ordinal);
        var documents = new HashSet<string>(StringComparer.Ordinal);
        foreach (AuthoringWorkspaceSnapshotTab tab in layout.Tabs)
        {
            if (tab is null || !IsId(tab.TabId) || !tabIds.Add(tab.TabId) || tab.Identity is null
                || tab.Identity.ArticleId is <= 0 || !IsId(tab.Identity.DraftId) || !IsId(tab.Identity.DocumentId)
                || tab.IsPreview == tab.IsPinned || !drafts.Add(tab.Identity.DraftId)
                || !documents.Add(tab.Identity.DocumentId)
                || (tab.Identity.ArticleId is int article && !articles.Add(article)))
            {
                throw new AuthoringWorkspaceSnapshotException("duplicate_or_invalid_tab");
            }
        }
        var groupIds = new HashSet<string>(StringComparer.Ordinal);
        var owned = new HashSet<string>(StringComparer.Ordinal);
        foreach (AuthoringWorkspaceSnapshotGroup group in layout.Groups)
        {
            if (group is null || !IsId(group.GroupId) || !groupIds.Add(group.GroupId)
                || group.TabIds is null || group.TabIds.Length > MaxTabs
                || (group.TabIds.Length == 0 ? group.ActiveTabId is not null
                    : group.ActiveTabId is null || !group.TabIds.Contains(group.ActiveTabId, StringComparer.Ordinal)))
            {
                throw new AuthoringWorkspaceSnapshotException("invalid_group");
            }
            foreach (string tabId in group.TabIds)
            {
                if (!tabIds.Contains(tabId) || !owned.Add(tabId))
                {
                    throw new AuthoringWorkspaceSnapshotException("orphan_or_mirrored_tab");
                }
            }
            if (layout.Tabs.Count(t => group.TabIds.Contains(t.TabId, StringComparer.Ordinal) && t.IsPreview) > 1)
            {
                throw new AuthoringWorkspaceSnapshotException("multiple_previews");
            }
        }
        if (owned.Count != tabIds.Count || !groupIds.Contains(layout.ActiveGroupId))
        {
            throw new AuthoringWorkspaceSnapshotException("orphan_or_active_group");
        }
        if (layout.Shell.LibraryView is not ("all" or "recent" or "pinned")
            || layout.Shell.InspectorView is not ("publish" or "rights" or "check" or "preview" or "versions" or "resources"))
        {
            throw new AuthoringWorkspaceSnapshotException("invalid_shell");
        }
        if (Serialize(layout).Length > MaxBytes)
        {
            throw new AuthoringWorkspaceSnapshotException("oversize");
        }
    }

    public static AuthoringWorkspaceSnapshotLayout DefaultLayout()
        => new([], [new("group:primary", [], null)], "group:primary", 500,
            new(true, "all", true, false, "publish"));

    public static AuthoringWorkspaceSnapshot Seal(
        AuthoringWorkspaceSnapshotScope scope, string sourceDigest, long revision, long updatedAt,
        AuthoringWorkspaceSnapshotLayout layout)
    {
        ValidateScope(scope);
        ValidateLayout(layout);
        if (!IsDigest(sourceDigest) || revision is < 1 or > MaxSafeInteger || updatedAt is < 1 or > MaxSafeInteger)
        {
            throw new AuthoringWorkspaceSnapshotException("invalid_version");
        }
        // Clone at the trust boundary; neither caller-owned arrays nor returned values are persistence authority.
        AuthoringWorkspaceSnapshotLayout copy = JsonSerializer.Deserialize<AuthoringWorkspaceSnapshotLayout>(Serialize(layout), s_options)!;
        var snapshot = new AuthoringWorkspaceSnapshot(SchemaVersion, WorkspaceId, scope, SourceContract,
            sourceDigest, revision, updatedAt, copy, string.Empty);
        snapshot = snapshot with
        {
            ContentDigest = ComputeSnapshotDigest(snapshot)
        };
        if (Serialize(snapshot).Length > MaxBytes)
        {
            throw new AuthoringWorkspaceSnapshotException("oversize");
        }
        return snapshot;
    }

    public static AuthoringWorkspaceSnapshot Parse(
        ReadOnlyMemory<byte> bytes, AuthoringWorkspaceSnapshotScope scope, string sourceDigest)
    {
        ValidateScope(scope);
        if (bytes.Length is < 1 or > MaxBytes)
        {
            throw new AuthoringWorkspaceSnapshotException("oversize");
        }
        try
        {
            using JsonDocument document = JsonDocument.Parse(bytes, s_documentOptions);
            JsonElement root = document.RootElement;
            Exact(root, "schemaVersion", "workspaceId", "scope", "sourceContract", "sourceDigest", "revision", "updatedAt", "layout", "contentDigest");
            Exact(root.GetProperty("scope"), "userId", "siteId");
            ValidateJsonLayout(root.GetProperty("layout"));
            var snapshot = root.Deserialize<AuthoringWorkspaceSnapshot>(s_options)!;
            if (snapshot.SchemaVersion != SchemaVersion)
            {
                throw new AuthoringWorkspaceSnapshotException(snapshot.SchemaVersion > SchemaVersion ? "future_schema" : "unsupported_schema");
            }
            if (snapshot.WorkspaceId != WorkspaceId || snapshot.Scope != scope || snapshot.SourceContract != SourceContract
                || snapshot.SourceDigest != sourceDigest || !IsDigest(sourceDigest))
            {
                throw new AuthoringWorkspaceSnapshotException("identity_or_source_mismatch");
            }
            ValidateLayout(snapshot.Layout);
            if (snapshot.Revision is < 1 or > MaxSafeInteger || snapshot.UpdatedAt is < 1 or > MaxSafeInteger
                || !IsDigest(snapshot.ContentDigest) || ComputeSnapshotDigest(snapshot) != snapshot.ContentDigest)
            {
                throw new AuthoringWorkspaceSnapshotException("digest_or_revision_mismatch");
            }
            return snapshot;
        }
        catch (Exception ex) when (ex is JsonException or InvalidOperationException or KeyNotFoundException or FormatException)
        {
            throw new AuthoringWorkspaceSnapshotException("corrupt", ex);
        }
    }

    public static AuthoringWorkspaceSnapshotLayout ParseLayout(ReadOnlyMemory<byte> bytes)
    {
        if (bytes.Length is < 1 or > MaxBytes)
        {
            throw new AuthoringWorkspaceSnapshotException("oversize");
        }
        try
        {
            using JsonDocument document = JsonDocument.Parse(bytes, s_documentOptions);
            ValidateJsonLayout(document.RootElement);
            var layout = document.RootElement.Deserialize<AuthoringWorkspaceSnapshotLayout>(s_options)!;
            ValidateLayout(layout);
            return layout;
        }
        catch (Exception ex) when (ex is JsonException or InvalidOperationException or KeyNotFoundException)
        {
            throw new AuthoringWorkspaceSnapshotException("corrupt", ex);
        }
    }

    private static void ValidateJsonLayout(JsonElement layout)
    {
        Exact(layout, "tabs", "groups", "activeGroupId", "splitRatioPermille", "shell");
        foreach (JsonElement tab in layout.GetProperty("tabs").EnumerateArray())
        {
            Exact(tab, "tabId", "identity", "isPreview", "isPinned");
            Exact(tab.GetProperty("identity"), "articleId", "draftId", "documentId");
        }
        foreach (JsonElement group in layout.GetProperty("groups").EnumerateArray())
        {
            Exact(group, "groupId", "tabIds", "activeTabId");
        }
        Exact(layout.GetProperty("shell"), "libraryOpen", "libraryView", "outlineOpen", "inspectorOpen", "inspectorView");
    }

    private static void Exact(JsonElement value, params string[] keys)
    {
        string[] actual = value.EnumerateObject().Select(p => p.Name).Order(StringComparer.Ordinal).ToArray();
        if (!actual.SequenceEqual(keys.Order(StringComparer.Ordinal), StringComparer.Ordinal))
        {
            throw new AuthoringWorkspaceSnapshotException("unknown_or_missing_field");
        }
    }

    public static string ComputeSnapshotDigest(AuthoringWorkspaceSnapshot snapshot)
        => Digest(new
        {
            snapshot.SchemaVersion,
            snapshot.WorkspaceId,
            snapshot.Scope,
            snapshot.SourceContract,
            snapshot.SourceDigest,
            snapshot.Revision,
            snapshot.UpdatedAt,
            snapshot.Layout
        });

    public static string Digest<T>(T value)
        => Convert.ToHexStringLower(SHA256.HashData(Serialize(value)));

    /// <summary>Ordinal-key canonical UTF-8, with integer-only contract numbers for cross-stack digest parity.</summary>
    public static byte[] Serialize<T>(T value)
    {
        using JsonDocument document = JsonSerializer.SerializeToDocument(value, s_options);
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            WriteCanonical(writer, document.RootElement);
        }
        return stream.ToArray();
    }

    private static void WriteCanonical(Utf8JsonWriter writer, JsonElement value)
    {
        switch (value.ValueKind)
        {
            case JsonValueKind.Object:
                writer.WriteStartObject();
                foreach (JsonProperty property in value.EnumerateObject().OrderBy(p => p.Name, StringComparer.Ordinal))
                {
                    writer.WritePropertyName(property.Name);
                    WriteCanonical(writer, property.Value);
                }
                writer.WriteEndObject();
                break;
            case JsonValueKind.Array:
                writer.WriteStartArray();
                foreach (JsonElement element in value.EnumerateArray())
                {
                    WriteCanonical(writer, element);
                }
                writer.WriteEndArray();
                break;
            default:
                value.WriteTo(writer);
                break;
        }
    }
}

/// <summary>Closed privacy-safe snapshot refusal reason without payload or business-data side effects.</summary>
public sealed class AuthoringWorkspaceSnapshotException(string reason, Exception? inner = null) : Exception(reason, inner)
{
    public string Reason { get; } = reason;
}
