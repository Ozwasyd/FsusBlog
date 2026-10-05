using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Closed contract for the server-owned, owner/site-scoped recent article history.
/// The only article identity in this contract is the durable server <c>article.id</c>.
/// Titles, slugs, routes, browser history and client clocks are deliberately absent.
/// </summary>
public static class AuthorRecentArticleHistoryContract
{
    public const int SchemaVersion = 1;
    public const int MaxEntriesPerOwner = 1_000;
    public const int MaxPageSize = 100;
    public const int MaxCursorLength = 1_024;
    public const int MaxDigestLength = 64;
    public const int MaxSiteScopeLength = 128;

    public static void ValidateOwner(AuthorRecentArticleHistoryOwner owner)
    {
        if (owner.AdminPrincipalId <= 0
            || string.IsNullOrWhiteSpace(owner.SiteScope)
            || owner.SiteScope.Length > MaxSiteScopeLength
            || !string.Equals(owner.SiteScope, owner.SiteScope.Trim(), StringComparison.Ordinal)
            || owner.SiteScope.Any(char.IsControl))
        {
            throw new AuthorRecentArticleHistoryValidationException("author_recent_history_owner_invalid");
        }
    }

    public static void ValidateArticleId(int articleId)
    {
        if (articleId <= 0)
        {
            throw new AuthorRecentArticleHistoryValidationException("author_recent_history_article_identity_invalid");
        }
    }

    public static void ValidateServerRevision(long serverRevision)
    {
        if (serverRevision <= 0)
        {
            throw new AuthorRecentArticleHistoryValidationException("author_recent_history_server_revision_invalid");
        }
    }

    public static void ValidateExpectedRevision(long expectedRevision)
    {
        if (expectedRevision < 0)
        {
            throw new AuthorRecentArticleHistoryValidationException("author_recent_history_expected_revision_invalid");
        }
    }

    public static void ValidateRequestId(Guid requestId)
    {
        if (requestId == Guid.Empty)
        {
            throw new AuthorRecentArticleHistoryValidationException("author_recent_history_request_identity_invalid");
        }
    }

    public static void ValidatePageSize(int pageSize)
    {
        if (pageSize is < 1 or > MaxPageSize)
        {
            throw new AuthorRecentArticleHistoryValidationException("author_recent_history_page_size_invalid");
        }
    }

    public static void ValidateDigest(string digest, string code = "author_recent_history_digest_invalid")
    {
        if (string.IsNullOrWhiteSpace(digest)
            || digest.Length != MaxDigestLength
            || digest.Any(static character => !Uri.IsHexDigit(character))
            || !string.Equals(digest, digest.ToLowerInvariant(), StringComparison.Ordinal))
        {
            throw new AuthorRecentArticleHistoryValidationException(code);
        }
    }

    public static string CommandName(AuthorRecentArticleHistoryCommandKind commandKind)
        => commandKind switch
        {
            AuthorRecentArticleHistoryCommandKind.Open => "open",
            AuthorRecentArticleHistoryCommandKind.Edit => "edit",
            AuthorRecentArticleHistoryCommandKind.Activate => "activate",
            _ => throw new AuthorRecentArticleHistoryValidationException("author_recent_history_command_invalid")
        };

    public static bool TryParseCommandName(
        string commandName,
        out AuthorRecentArticleHistoryCommandKind commandKind)
    {
        commandKind = commandName switch
        {
            "open" => AuthorRecentArticleHistoryCommandKind.Open,
            "edit" => AuthorRecentArticleHistoryCommandKind.Edit,
            "activate" => AuthorRecentArticleHistoryCommandKind.Activate,
            _ => default
        };
        return commandName is "open" or "edit" or "activate";
    }

    public static string ComputeCommandDigest(AuthorRecentArticleHistoryCommand command)
    {
        ArgumentNullException.ThrowIfNull(command);
        ValidateCommand(command);
        return HashCanonical(
            SchemaVersion,
            "command",
            CommandName(command.CommandKind),
            command.Owner.AdminPrincipalId,
            command.Owner.SiteScope,
            command.ArticleId,
            command.ServerRevision,
            command.ExpectedCollectionRevision,
            command.RequestId);
    }

    public static string ComputeEntryDigest(
        AuthorRecentArticleHistoryOwner owner,
        AuthorRecentArticleHistoryEntry entry)
    {
        ArgumentNullException.ThrowIfNull(entry);
        ValidateOwner(owner);
        ValidateEntry(entry);
        return HashCanonical(
            SchemaVersion,
            "entry",
            owner.AdminPrincipalId,
            owner.SiteScope,
            entry.ArticleId,
            entry.ServerRevision,
            entry.LastOpenedAtUtc,
            entry.LastEditedAtUtc,
            entry.LastActivatedAtUtc,
            entry.LastCommand,
            entry.EntryRevision);
    }

    public static string ComputeCollectionDigest(
        AuthorRecentArticleHistoryOwner owner,
        long revision,
        IReadOnlyList<AuthorRecentArticleHistoryEntry> entries)
    {
        ArgumentNullException.ThrowIfNull(entries);
        ValidateOwner(owner);
        ValidateExpectedRevision(revision);
        if (entries.Count > MaxEntriesPerOwner)
        {
            throw new AuthorRecentArticleHistoryValidationException("author_recent_history_collection_bound_exceeded");
        }

        var values = new List<object?>
        {
            SchemaVersion,
            "collection",
            owner.AdminPrincipalId,
            owner.SiteScope,
            revision,
            entries.Count
        };
        foreach (AuthorRecentArticleHistoryEntry entry in entries
            .OrderByDescending(RecentArticleHistoryOrdering.LatestFactAtUtc)
            .ThenByDescending(static entry => entry.ArticleId))
        {
            values.Add(entry.ArticleId);
            values.Add(entry.ServerRevision);
            values.Add(entry.LastOpenedAtUtc);
            values.Add(entry.LastEditedAtUtc);
            values.Add(entry.LastActivatedAtUtc);
            values.Add(entry.LastCommand);
            values.Add(entry.EntryRevision);
            values.Add(entry.ContentDigest);
        }
        return HashCanonical([.. values]);
    }

    public static string ComputeReceiptDigest(AuthorRecentArticleHistoryReceipt receipt)
    {
        ArgumentNullException.ThrowIfNull(receipt);
        ValidateOwner(receipt.Owner);
        ValidateRequestId(receipt.RequestId);
        ValidateRequestId(receipt.ReceiptId);
        ValidateArticleId(receipt.ArticleId);
        ValidateServerRevision(receipt.ServerRevision);
        ValidateExpectedRevision(receipt.PreviousRevision);
        ValidateExpectedRevision(receipt.Revision);
        ValidateDigest(receipt.CommandDigest);
        ValidateDigest(receipt.ContentDigest);
        return HashCanonical(
            SchemaVersion,
            "receipt",
            receipt.ReceiptId,
            receipt.Owner.AdminPrincipalId,
            receipt.Owner.SiteScope,
            receipt.RequestId,
            receipt.ArticleId,
            receipt.ServerRevision,
            receipt.PreviousRevision,
            receipt.Revision,
            receipt.CommandKind,
            receipt.Status,
            receipt.AcceptedAtUtc,
            receipt.LastOpenedAtUtc,
            receipt.LastEditedAtUtc,
            receipt.LastActivatedAtUtc,
            receipt.ProjectionReference,
            receipt.CacheReference,
            receipt.AuditReference,
            receipt.OutboxReference,
            receipt.CommandDigest,
            receipt.ContentDigest);
    }

    public static string ComputePermissionDigest(AuthorRecentArticleHistoryPermissionSnapshot snapshot)
    {
        ArgumentNullException.ThrowIfNull(snapshot);
        ValidateOwner(snapshot.Owner);
        var values = new List<object?>
        {
            SchemaVersion,
            "permission",
            snapshot.Status,
            snapshot.Owner.AdminPrincipalId,
            snapshot.Owner.SiteScope,
            snapshot.PermissionRevision,
            snapshot.SiteRevision,
            snapshot.SessionRevision,
            snapshot.Decisions.Count
        };
        if (snapshot.Status == AuthorRecentArticleHistoryPermissionSnapshotStatus.Current)
        {
            ValidateDigest(snapshot.PermissionRevision, "author_recent_history_permission_revision_invalid");
            ValidateDigest(snapshot.SiteRevision, "author_recent_history_site_revision_invalid");
            ValidateDigest(snapshot.SessionRevision, "author_recent_history_session_revision_invalid");
        }
        foreach (AuthorRecentArticleHistoryPermissionDecision decision in snapshot.Decisions
            .OrderBy(static decision => decision.ArticleId))
        {
            ValidateArticleId(decision.ArticleId);
            ValidateDigest(decision.DecisionDigest, "author_recent_history_permission_decision_invalid");
            values.Add(decision.ArticleId);
            values.Add(decision.CanProject);
            values.Add(decision.CanWrite);
            values.Add(decision.DecisionDigest);
        }
        return HashCanonical([.. values]);
    }

    public static string ComputeProjectionDigest(
        AuthorRecentArticleHistoryOwner owner,
        long revision,
        IReadOnlyList<AuthorRecentArticleHistoryEntry> entries,
        AuthorRecentArticleHistoryPermissionSnapshot permission)
        => ComputeProjectionDigest(owner, revision, entries, permission.ContentDigest);

    public static string ComputeProjectionDigest(
        AuthorRecentArticleHistoryOwner owner,
        long revision,
        IReadOnlyList<AuthorRecentArticleHistoryEntry> entries,
        string permissionContentDigest)
    {
        ValidateOwner(owner);
        ValidateExpectedRevision(revision);
        ArgumentNullException.ThrowIfNull(entries);
        ValidateDigest(permissionContentDigest);
        var values = new List<object?>
        {
            SchemaVersion,
            "projection",
            owner.AdminPrincipalId,
            owner.SiteScope,
            revision,
            permissionContentDigest,
            entries.Count
        };
        foreach (AuthorRecentArticleHistoryEntry entry in entries
            .OrderByDescending(RecentArticleHistoryOrdering.LatestFactAtUtc)
            .ThenByDescending(static entry => entry.ArticleId))
        {
            values.Add(entry.ArticleId);
            values.Add(entry.ServerRevision);
            values.Add(entry.LastOpenedAtUtc);
            values.Add(entry.LastEditedAtUtc);
            values.Add(entry.LastActivatedAtUtc);
            values.Add(entry.LastCommand);
            values.Add(entry.EntryRevision);
            values.Add(entry.ContentDigest);
        }
        return HashCanonical([.. values]);
    }

    public static bool TryValidateProjectionPage(
        AuthorRecentArticleHistoryProjectionPage page,
        IReadOnlyList<AuthorRecentArticleHistoryEntry> authoritativeEntries)
    {
        ArgumentNullException.ThrowIfNull(page);
        ArgumentNullException.ThrowIfNull(authoritativeEntries);
        try
        {
            ValidateOwner(page.Owner);
            ValidateExpectedRevision(page.CollectionRevision);
            ValidateDigest(
                page.PermissionContentDigest,
                "author_recent_history_permission_digest_invalid");
            ValidateDigest(page.ContentDigest, "author_recent_history_projection_digest_invalid");
            if (page.Status != AuthorRecentArticleHistoryProjectionStatus.Current
                || page.SchemaVersion != SchemaVersion
                || authoritativeEntries.Count > MaxEntriesPerOwner
                || authoritativeEntries.Select(static entry => entry.ArticleId).Distinct().Count()
                    != authoritativeEntries.Count
                || authoritativeEntries.Any(entry =>
                    !string.Equals(
                        entry.ContentDigest,
                        ComputeEntryDigest(page.Owner, entry),
                        StringComparison.Ordinal))
                || !authoritativeEntries.SequenceEqual(authoritativeEntries
                    .OrderByDescending(RecentArticleHistoryOrdering.LatestFactAtUtc)
                    .ThenByDescending(static entry => entry.ArticleId))
                || page.HasMore != (page.NextCursor is not null)
                || string.IsNullOrWhiteSpace(page.ProjectionReference)
                || string.IsNullOrWhiteSpace(page.CacheReference))
            {
                return false;
            }
            return string.Equals(
                page.ContentDigest,
                ComputeProjectionDigest(
                    page.Owner,
                    page.CollectionRevision,
                    authoritativeEntries,
                    page.PermissionContentDigest),
                StringComparison.Ordinal)
                && IsValidProjectionPageSlice(page, authoritativeEntries);
        }
        catch (AuthorRecentArticleHistoryValidationException)
        {
            return false;
        }
    }

    private static bool IsValidProjectionPageSlice(
        AuthorRecentArticleHistoryProjectionPage page,
        IReadOnlyList<AuthorRecentArticleHistoryEntry> authoritativeEntries)
    {
        if (page.Entries.Count == 0)
        {
            return authoritativeEntries.Count == 0 && !page.HasMore;
        }

        int startIndex = -1;
        for (int index = 0; index < authoritativeEntries.Count; index++)
        {
            if (authoritativeEntries[index] == page.Entries[0])
            {
                startIndex = index;
                break;
            }
        }
        if (startIndex < 0
            || startIndex + page.Entries.Count > authoritativeEntries.Count
            || !page.Entries.SequenceEqual(
                authoritativeEntries.Skip(startIndex).Take(page.Entries.Count)))
        {
            return false;
        }

        return page.HasMore == (startIndex + page.Entries.Count < authoritativeEntries.Count);
    }

    public static void ValidateCommand(AuthorRecentArticleHistoryCommand command)
    {
        ArgumentNullException.ThrowIfNull(command);
        ValidateOwner(command.Owner);
        ValidateArticleId(command.ArticleId);
        ValidateServerRevision(command.ServerRevision);
        ValidateExpectedRevision(command.ExpectedCollectionRevision);
        ValidateRequestId(command.RequestId);
        _ = CommandName(command.CommandKind);
    }

    public static void ValidateEntry(AuthorRecentArticleHistoryEntry entry)
    {
        ArgumentNullException.ThrowIfNull(entry);
        ValidateArticleId(entry.ArticleId);
        ValidateServerRevision(entry.ServerRevision);
        ValidateExpectedRevision(entry.EntryRevision);
        if (!TryParseCommandName(entry.LastCommand, out _)
            || entry.LastCommand.Length > 16
            || (entry.LastOpenedAtUtc is null
                && entry.LastEditedAtUtc is null
                && entry.LastActivatedAtUtc is null)
            || entry.LastOpenedAtUtc?.Kind == DateTimeKind.Local
            || entry.LastEditedAtUtc?.Kind == DateTimeKind.Local
            || entry.LastActivatedAtUtc?.Kind == DateTimeKind.Local)
        {
            throw new AuthorRecentArticleHistoryValidationException("author_recent_history_entry_invalid");
        }
        ValidateDigest(entry.ContentDigest);
    }

    public static bool TryValidateSnapshot(
        AuthorRecentArticleHistoryCollectionSnapshot snapshot,
        out IReadOnlyList<string> reasons)
    {
        var failures = new List<string>();
        try
        {
            ValidateOwner(snapshot.Owner);
            ValidateExpectedRevision(snapshot.Revision);
            if (snapshot.SchemaVersion != SchemaVersion)
            {
                failures.Add("schema_version_invalid");
            }
            if (snapshot.ItemCount != snapshot.Entries.Count)
            {
                failures.Add("item_count_mismatch");
            }
            if (snapshot.Entries.Count > MaxEntriesPerOwner)
            {
                failures.Add("collection_bound_exceeded");
            }
            if (snapshot.Entries.Select(static entry => entry.ArticleId).Distinct().Count()
                != snapshot.Entries.Count)
            {
                failures.Add("article_identity_duplicate");
            }
            foreach (AuthorRecentArticleHistoryEntry entry in snapshot.Entries)
            {
                ValidateEntry(entry);
                if (entry.EntryRevision > snapshot.Revision)
                {
                    failures.Add($"entry_revision_ahead:{entry.ArticleId}");
                }
                string expectedEntryDigest = ComputeEntryDigest(snapshot.Owner, entry);
                if (!string.Equals(expectedEntryDigest, entry.ContentDigest, StringComparison.Ordinal))
                {
                    failures.Add($"entry_digest_mismatch:{entry.ArticleId}");
                }
            }
            string expectedCollectionDigest = ComputeCollectionDigest(snapshot.Owner, snapshot.Revision, snapshot.Entries);
            if (!string.Equals(expectedCollectionDigest, snapshot.ContentDigest, StringComparison.Ordinal))
            {
                failures.Add("collection_digest_mismatch");
            }
            DateTime expectedChangedAtUtc = snapshot.Entries.Count == 0
                ? DateTime.SpecifyKind(DateTime.MinValue, DateTimeKind.Utc)
                : snapshot.Entries.Max(RecentArticleHistoryOrdering.LatestFactAtUtc);
            if (snapshot.ChangedAtUtc.Kind == DateTimeKind.Local
                || snapshot.ChangedAtUtc != expectedChangedAtUtc)
            {
                failures.Add("collection_timestamp_mismatch");
            }
        }
        catch (AuthorRecentArticleHistoryValidationException exception)
        {
            failures.Add(exception.Code);
        }
        reasons = failures;
        return failures.Count == 0;
    }

    public static void ValidateCursor(
        AuthorRecentArticleHistoryCursor cursor)
    {
        ArgumentNullException.ThrowIfNull(cursor);
        ValidateOwner(cursor.Owner);
        ValidateExpectedRevision(cursor.CollectionRevision);
        ValidateArticleId(cursor.LastArticleId);
        ValidateDigest(cursor.CollectionDigest);
        ValidateDigest(cursor.PermissionDigest);
        ValidateDigest(cursor.SiteRevision, "author_recent_history_site_revision_invalid");
        ValidateDigest(cursor.SessionRevision, "author_recent_history_session_revision_invalid");
        if (cursor.LastFactAtUtc.Kind == DateTimeKind.Local
            || cursor.LastFactAtUtc < DateTime.UnixEpoch)
        {
            throw new AuthorRecentArticleHistoryValidationException(
                "author_recent_history_cursor_timestamp_invalid");
        }
    }

    public static string HashText(string text)
        => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(text)));

    private static string HashCanonical(params object?[] values)
    {
        var canonical = new StringBuilder();
        foreach (object? value in values)
        {
            string text = value switch
            {
                null => "null",
                DateTime timestamp => NormalizeUtc(timestamp).ToString("O", CultureInfo.InvariantCulture),
                IFormattable formattable => formattable.ToString(null, CultureInfo.InvariantCulture) ?? string.Empty,
                _ => value.ToString() ?? string.Empty
            };
            canonical.Append(text.Length).Append(':').Append(text).Append(';');
        }
        return HashText(canonical.ToString());
    }

    private static DateTime NormalizeUtc(DateTime value)
        => value.Kind == DateTimeKind.Utc
            ? value
            : DateTime.SpecifyKind(value, DateTimeKind.Utc);

}

public readonly record struct AuthorRecentArticleHistoryOwner(long AdminPrincipalId, string SiteScope);

public enum AuthorRecentArticleHistoryCommandKind
{
    Open = 0,
    Edit = 1,
    Activate = 2
}

public enum AuthorRecentArticleHistoryProjectionStatus
{
    Current = 0,
    Stale = 1,
    Unavailable = 2,
    InvalidCursor = 3
}

public sealed record AuthorRecentArticleHistoryCommand(
    AuthorRecentArticleHistoryOwner Owner,
    int ArticleId,
    long ServerRevision,
    long ExpectedCollectionRevision,
    Guid RequestId,
    AuthorRecentArticleHistoryCommandKind CommandKind);

public sealed record AuthorRecentArticleHistoryEntry(
    int ArticleId,
    long ServerRevision,
    DateTime? LastOpenedAtUtc,
    DateTime? LastEditedAtUtc,
    DateTime? LastActivatedAtUtc,
    string LastCommand,
    long EntryRevision,
    string ContentDigest);

public sealed record AuthorRecentArticleHistoryCollectionSnapshot(
    AuthorRecentArticleHistoryOwner Owner,
    int SchemaVersion,
    long Revision,
    int ItemCount,
    IReadOnlyList<AuthorRecentArticleHistoryEntry> Entries,
    DateTime ChangedAtUtc,
    string ContentDigest);

public sealed record AuthorRecentArticleHistoryReceipt(
    Guid ReceiptId,
    AuthorRecentArticleHistoryOwner Owner,
    Guid RequestId,
    int ArticleId,
    long ServerRevision,
    long PreviousRevision,
    long Revision,
    string CommandKind,
    string Status,
    DateTime AcceptedAtUtc,
    DateTime? LastOpenedAtUtc,
    DateTime? LastEditedAtUtc,
    DateTime? LastActivatedAtUtc,
    string ProjectionReference,
    string CacheReference,
    string AuditReference,
    string OutboxReference,
    string CommandDigest,
    string ContentDigest,
    bool IdempotentReplay,
    string ReceiptDigest);

public sealed record AuthorRecentArticleHistoryProjectionRequest(
    AuthorRecentArticleHistoryOwner Owner,
    Guid RequestId,
    int Limit = 50,
    string? Cursor = null,
    long? ExpectedCollectionRevision = null,
    string? ExpectedPermissionRevision = null,
    string? ExpectedSiteRevision = null,
    string? ExpectedSessionRevision = null);

public sealed record AuthorRecentArticleHistoryProjectionPage(
    AuthorRecentArticleHistoryProjectionStatus Status,
    AuthorRecentArticleHistoryOwner Owner,
    int SchemaVersion,
    long CollectionRevision,
    IReadOnlyList<AuthorRecentArticleHistoryEntry> Entries,
    string? NextCursor,
    bool HasMore,
    string PermissionRevision,
    string SiteRevision,
    string SessionRevision,
    string PermissionContentDigest,
    string ProjectionReference,
    string CacheReference,
    string ContentDigest,
    string? ReasonCode)
{
    public static AuthorRecentArticleHistoryProjectionPage Empty(
        AuthorRecentArticleHistoryOwner owner,
        AuthorRecentArticleHistoryProjectionStatus status,
        string reasonCode)
        => new(
            status,
            owner,
            AuthorRecentArticleHistoryContract.SchemaVersion,
            0,
            [],
            null,
            false,
            string.Empty,
            string.Empty,
            string.Empty,
            string.Empty,
            string.Empty,
            string.Empty,
            AuthorRecentArticleHistoryContract.HashText($"empty:{owner.AdminPrincipalId}:{owner.SiteScope}"),
            reasonCode);
}

public sealed record AuthorRecentArticleHistoryPermissionRequest(
    AuthorRecentArticleHistoryOwner Owner,
    Guid RequestId,
    IReadOnlyList<int> ArticleIds);

public sealed record AuthorRecentArticleHistoryPermissionDecision(
    int ArticleId,
    bool CanProject,
    bool CanWrite,
    string DecisionDigest);

public sealed record AuthorRecentArticleHistoryPermissionSnapshot(
    AuthorRecentArticleHistoryPermissionSnapshotStatus Status,
    AuthorRecentArticleHistoryOwner Owner,
    string PermissionRevision,
    string SiteRevision,
    string SessionRevision,
    IReadOnlyList<AuthorRecentArticleHistoryPermissionDecision> Decisions,
    string ContentDigest);

public enum AuthorRecentArticleHistoryPermissionSnapshotStatus
{
    Current = 0,
    Stale = 1,
    Unavailable = 2
}

public sealed record AuthorRecentArticleHistoryCursor(
    AuthorRecentArticleHistoryOwner Owner,
    long CollectionRevision,
    string CollectionDigest,
    string PermissionDigest,
    string SiteRevision,
    string SessionRevision,
    DateTime LastFactAtUtc,
    int LastArticleId);

public sealed record AuthorRecentArticleHistoryVerificationResult(
    bool Valid,
    IReadOnlyList<string> Reasons,
    long Revision,
    int ItemCount,
    string ContentDigest,
    int VisibleItemCount = 0,
    string AuthorityContentDigest = "",
    string PermissionContentDigest = "");

public static class RecentArticleHistoryOrdering
{
    public static DateTime LatestFactAtUtc(AuthorRecentArticleHistoryEntry entry)
    {
        ArgumentNullException.ThrowIfNull(entry);
        DateTime latest = DateTime.MinValue;
        if (entry.LastOpenedAtUtc is DateTime opened && opened > latest)
        {
            latest = opened;
        }
        if (entry.LastEditedAtUtc is DateTime edited && edited > latest)
        {
            latest = edited;
        }
        if (entry.LastActivatedAtUtc is DateTime activated && activated > latest)
        {
            latest = activated;
        }
        return latest.Kind == DateTimeKind.Utc
            ? latest
            : DateTime.SpecifyKind(latest, DateTimeKind.Utc);
    }
}

public sealed class AuthorRecentArticleHistoryValidationException(string code) : InvalidOperationException(code)
{
    public string Code { get; } = code;
}

public sealed class AuthorRecentArticleHistoryRevisionConflictException(long expectedRevision, long actualRevision)
    : InvalidOperationException($"author_recent_history_revision_conflict expected={expectedRevision} actual={actualRevision}")
{
    public long ExpectedRevision { get; } = expectedRevision;
    public long ActualRevision { get; } = actualRevision;
}

public sealed class AuthorRecentArticleHistoryIdempotencyConflictException()
    : InvalidOperationException("author_recent_history_idempotency_conflict");

public sealed class AuthorRecentArticleHistoryAccessDeniedException()
    : InvalidOperationException("author_recent_history_access_denied");

public sealed class AuthorRecentArticleHistoryTamperDetectedException(string reason)
    : InvalidOperationException($"author_recent_history_tamper_detected:{reason}")
{
    public string Reason { get; } = reason;
}
