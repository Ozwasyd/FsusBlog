using System.Data.Common;
using System.Diagnostics;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Core.Common;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.Pagination;
using FsusBlog.Server.Infrastructure.Privacy;
using FsusBlog.Server.Interfaces;
using FsusBlog.Shared.Contracts.NotificationStream;
using FsusBlog.Shared.Contracts.Outputs;
using FsusBlog.Shared.Contracts.Validation;

using SqlSugar;

namespace FsusBlog.Server.Services.NotificationStream;

public sealed partial class MessageCenterService
{
    private static string ToContentValidationCode(string field, MessageContentViolation violation)
        => violation switch
        {
            MessageContentViolation.Empty => $"message_{field}_empty",
            MessageContentViolation.ScalarLimit => $"message_{field}_scalar_limit_exceeded",
            MessageContentViolation.GraphemeLimit => $"message_{field}_grapheme_limit_exceeded",
            MessageContentViolation.Utf8ByteLimit => $"message_{field}_utf8_limit_exceeded",
            _ => $"message_{field}_invalid"
        };

    private string ComputeAdminSessionAuditReference(string adminSessionId)
        => MessageAdminSessionAuditReference.Create(configuration, adminSessionId);

    private static ConversationListItemResponse ToRealtimeConversationReference(ConversationListItemResponse summary)
        => summary switch
        {
            AdminConversationListItemResponse admin => admin with { LastMessage = null },
            _ => summary with { LastMessage = null }
        };

    private Task AcquireMutationLockAsync(string principalKind, long principalId, string mutationId)
        => db.Ado.ExecuteCommandAsync(
            "SELECT pg_advisory_xact_lock(hashtext(@PrincipalKind), hashtext(@MutationScope));",
            new SugarParameter("@PrincipalKind", principalKind),
            new SugarParameter("@MutationScope", string.Concat(
                principalId.ToString(CultureInfo.InvariantCulture),
                ":",
                mutationId)));

    private async Task<MessageConversation?> FindConversationMutationAsync(
        string principalKind,
        long principalId,
        string mutationId)
        => await db.Queryable<MessageConversation>()
            .Where(item => item.ClientMutationPrincipalKind == principalKind
                && item.ClientMutationPrincipalId == principalId
                && item.ClientMutationId == mutationId)
            .FirstAsync();

    private async Task<ConversationMessage?> FindMessageMutationAsync(
        string principalKind,
        long principalId,
        string mutationId)
        => await db.Queryable<ConversationMessage>()
            .Where(item => item.ClientMutationPrincipalKind == principalKind
                && item.ClientMutationPrincipalId == principalId
                && item.ClientMutationId == mutationId)
            .FirstAsync();

    private static bool TryNormalizeClientMutationId(string? value, out string normalized)
    {
        normalized = value?.Trim() ?? string.Empty;
        if (normalized.Length is <= 0 or > 64)
        {
            return false;
        }

        return normalized.All(static character =>
            char.IsAsciiLetterOrDigit(character) || character is '-' or '_' or '.' or ':');
    }

    private static string ComputeMutationRequestHash(params string[] values)
    {
        var canonical = new StringBuilder();
        for (int i = 0; i < values.Length; i++)
        {
            string value = values[i];
            canonical.Append(value.Length.ToString(CultureInfo.InvariantCulture));
            canonical.Append(':');
            canonical.Append(value);
            canonical.Append(';');
        }
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(canonical.ToString())));
    }

    private static long ComputeStableSourceEventId(string operation, int accountId, params string[] values)
    {
        string[] coordinates = new string[values.Length + 2];
        coordinates[0] = operation;
        coordinates[1] = accountId.ToString(CultureInfo.InvariantCulture);
        Array.Copy(values, 0, coordinates, 2, values.Length);
        byte[] digest = SHA256.HashData(Encoding.UTF8.GetBytes(ComputeMutationRequestHash(coordinates)));
        long sourceEventId = BitConverter.ToInt64(digest, 0) & long.MaxValue;
        return sourceEventId == 0 ? 1 : sourceEventId;
    }
}
