using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace FsusBlog.Shared.Contracts.ArticleProperties;

public enum ArticlePropertyValueMutationMode : byte
{
    Replace = 0,
    Patch = 1
}

public enum ArticlePropertyValueChangeKind : byte
{
    Create = 0,
    Update = 1,
    Remove = 2
}

public sealed record ArticlePropertyValueChange(
    ArticlePropertyValueChangeKind Kind,
    ArticlePropertyValueInput Input);

/// <summary>Current-article command only. Standalone drafts require their real separate authority.</summary>
public sealed record ArticlePropertyValueMutationCommand(
    Guid RequestId,
    long? DefinitionOwnerUserId,
    string SiteScope,
    int ArticleId,
    long ExpectedArticleRevisionId,
    long ExpectedPropertyRevision,
    ArticlePropertyValueMutationMode Mode,
    IReadOnlyList<ArticlePropertyValueChange> Changes);

/// <summary>A persisted reference, distinct from a pure snapshot candidate.</summary>
public sealed record ArticlePropertyValuePersistedSnapshot(
    Guid SnapshotId,
    Guid FactsetId,
    ArticlePropertyValueSnapshot Snapshot,
    Guid AuditReference,
    string AuditChainId,
    string AuditRecordHash);

public sealed record ArticlePropertyValueMutationReceipt(
    Guid ReceiptId,
    long ActorAdminPrincipalId,
    Guid RequestId,
    long? DefinitionOwnerUserId,
    string SiteScope,
    int ArticleId,
    long ExpectedArticleRevisionId,
    long BeforePropertyRevision,
    long AfterPropertyRevision,
    Guid? BeforeSnapshotId,
    Guid AfterSnapshotId,
    ArticlePropertyValueMutationMode CommandKind,
    string CommandDigest,
    string ContentDigest,
    Guid AuditReference,
    string AuditChainId,
    string AuditRecordHash,
    DateTime OccurredAtUtc,
    bool IdempotencyReplay = false);

/// <summary>Closed command shape/integrity only; article and definition authorization stay server-owned.</summary>
public static class ArticlePropertyValueMutationContract
{
    public static ArticlePropertyValueMutationCommand Capture(ArticlePropertyValueMutationCommand command)
    {
        ArgumentNullException.ThrowIfNull(command);
        if (command.RequestId == Guid.Empty || command.ArticleId <= 0 || command.ExpectedArticleRevisionId <= 0
            || command.ExpectedPropertyRevision < 0 || command.DefinitionOwnerUserId is <= 0
            || string.IsNullOrWhiteSpace(command.SiteScope) || command.SiteScope.Length > 128
            || command.SiteScope != command.SiteScope.Trim() || command.SiteScope.Any(char.IsControl)
            || !Enum.IsDefined(command.Mode) || command.Changes is null || command.Changes.Count > 1000)
        {
            throw new ArgumentException("article_property_value_command_invalid");
        }
        ArticlePropertyValueChange[] held = command.Changes.Take(1001).ToArray();
        if (held.Length > 1000 || held.Any(static change => change is null || change.Input is null
            || !Enum.IsDefined(change.Kind) || change.Input.DefinitionId == Guid.Empty
            || change.Input.DefinitionSchemaRevision <= 0 || !IsDigest(change.Input.DefinitionDigest)
            || !Enum.IsDefined(change.Input.Presence)
            || (change.Input.Presence == ArticlePropertyValuePresence.Present) != (change.Input.Value is not null)
            || change.Kind == ArticlePropertyValueChangeKind.Remove
                && change.Input.Presence != ArticlePropertyValuePresence.Missing)
            || held.Select(static change => change.Input.DefinitionId).Distinct().Count() != held.Length
            || command.Mode == ArticlePropertyValueMutationMode.Replace
                && held.Any(static change => change.Kind == ArticlePropertyValueChangeKind.Remove))
        {
            throw new ArgumentException("article_property_value_command_invalid");
        }
        foreach (ArticlePropertyValueChange change in held)
        {
            _ = ArticlePropertyValueDigest.ComputeValue(change.Input);
        }
        return command with
        {
            Changes = Array.AsReadOnly(held.OrderBy(static change => change.Input.DefinitionId).ToArray())
        };
    }

    public static string ComputeCommandDigest(ArticlePropertyValueMutationCommand command)
    {
        command = Capture(command);
        return Digest("fsusblog.article-property-value-command.v1", command.RequestId,
            command.DefinitionOwnerUserId, command.SiteScope, command.ArticleId, command.ExpectedArticleRevisionId,
            command.ExpectedPropertyRevision, (int)command.Mode,
            string.Join(";", command.Changes.Select(static change =>
                ((int)change.Kind).ToString(CultureInfo.InvariantCulture) + ":"
                + ArticlePropertyValueDigest.ComputeValue(change.Input))));
    }

    public static string ComputeReceiptDigest(ArticlePropertyValueMutationReceipt receipt)
        => Digest("fsusblog.article-property-value-receipt.v1", receipt.ReceiptId, receipt.ActorAdminPrincipalId,
            receipt.RequestId, receipt.DefinitionOwnerUserId, receipt.SiteScope, receipt.ArticleId,
            receipt.ExpectedArticleRevisionId, receipt.BeforePropertyRevision, receipt.AfterPropertyRevision,
            receipt.BeforeSnapshotId, receipt.AfterSnapshotId, (int)receipt.CommandKind, receipt.CommandDigest,
            receipt.AuditReference, receipt.OccurredAtUtc.Ticks);

    public static bool IsDigest(string? value)
        => value is { Length: 64 }
            && value.All(static character => character is (>= 'a' and <= 'f') or (>= '0' and <= '9'));

    private static string Digest(params object?[] fields)
    {
        using var stream = new MemoryStream();
        using var writer = new BinaryWriter(stream, Encoding.UTF8, leaveOpen: true);
        foreach (object? field in fields)
        {
            string value = field switch
            {
                null => "null",
                Guid id => id.ToString("D"),
                IFormattable number => number.ToString(null, CultureInfo.InvariantCulture),
                _ => field.ToString()!
            };
            byte[] bytes = Encoding.UTF8.GetBytes(value);
            writer.Write(bytes.Length);
            writer.Write(bytes);
        }
        writer.Flush();
        return Convert.ToHexStringLower(SHA256.HashData(stream.ToArray()));
    }
}
