using FsusBlog.Server.Entities;
using SqlSugar;
using System.Text.Json;

namespace FsusBlog.Server.Services.Security;

public interface IAnonymousCredentialService
{
    Task<AnonymousCredential> IssueAccountBoundAsync(
        int accountId,
        string accountBindingHash,
        string credentialLevel = AnonymousCredentialLevels.Basic,
        string metadataJson = "{}",
        CancellationToken cancellationToken = default);

    Task<AnonymousCredential?> GetActiveAccountCredentialAsync(
        int accountId,
        string? accountBindingHash = null,
        CancellationToken cancellationToken = default);

    Task<string?> GetAccountCredentialLevelAsync(
        int accountId,
        string? accountBindingHash = null,
        CancellationToken cancellationToken = default);

    Task<bool> RevokeAsync(long credentialId, CancellationToken cancellationToken = default);
}

public sealed class AnonymousCredentialService(ISqlSugarClient db) : IAnonymousCredentialService
{
    public async Task<AnonymousCredential> IssueAccountBoundAsync(
        int accountId,
        string accountBindingHash,
        string credentialLevel = AnonymousCredentialLevels.Basic,
        string metadataJson = "{}",
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (accountId <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(accountId), "Account id is required.");
        }

        string normalizedBindingHash = NormalizeRequired(accountBindingHash, nameof(accountBindingHash));
        var credential = new AnonymousCredential
        {
            AccountId = accountId,
            AccountBindingHash = normalizedBindingHash,
            CredentialType = AnonymousCredentialTypes.AccountBound,
            CredentialLevel = NormalizeToken(credentialLevel, AnonymousCredentialLevels.Basic),
            Status = AnonymousCredentialStatuses.Active,
            IssuedAtUtc = DateTime.UtcNow,
            MetadataJson = string.IsNullOrWhiteSpace(metadataJson) ? "{}" : metadataJson.Trim()
        };
        credential.Id = await db.Insertable(credential).ExecuteReturnSnowflakeIdAsync();
        return credential;
    }

    public async Task<AnonymousCredential?> GetActiveAccountCredentialAsync(
        int accountId,
        string? accountBindingHash = null,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (accountId <= 0)
        {
            return null;
        }

        string? normalizedBindingHash = string.IsNullOrWhiteSpace(accountBindingHash) ? null : accountBindingHash.Trim();
        return await db.Queryable<AnonymousCredential>()
            .Where(c => c.Status == AnonymousCredentialStatuses.Active && c.RevokedAtUtc == null)
            .Where(c => c.AccountId == accountId)
            .WhereIF(normalizedBindingHash != null, c => c.AccountBindingHash == normalizedBindingHash)
            .OrderByDescending(c => c.IssuedAtUtc)
            .FirstAsync();
    }

    public async Task<string?> GetAccountCredentialLevelAsync(
        int accountId,
        string? accountBindingHash = null,
        CancellationToken cancellationToken = default)
    {
        AnonymousCredential? credential = await GetActiveAccountCredentialAsync(accountId, accountBindingHash, cancellationToken);
        return credential?.CredentialLevel;
    }

    public async Task<bool> RevokeAsync(long credentialId, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        AnonymousCredential? credential = await db.Queryable<AnonymousCredential>()
            .Where(c => c.Id == credentialId && c.RevokedAtUtc == null)
            .FirstAsync(cancellationToken);
        if (credential is null)
        {
            return false;
        }

        DateTime revokedAt = DateTime.UtcNow;
        RevocationMetadata? revocation = TryParseRevocationMetadata(credential.MetadataJson);
        bool updated = false;
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            updated = await db.Updateable<AnonymousCredential>()
                .SetColumns(c => c.Status == AnonymousCredentialStatuses.Revoked)
                .SetColumns(c => c.RevokedAtUtc == revokedAt)
                .Where(c => c.Id == credentialId && c.RevokedAtUtc == null)
                .ExecuteCommandAsync(cancellationToken) > 0;
            if (updated && revocation is not null)
            {
                await db.Ado.ExecuteCommandAsync(
                    """
                    INSERT INTO anonymous_credential_revocation
                        (epoch, root_hash, revocation_handle_hash, revocation_root_hash, reason, actor_id, revoked_at_utc)
                    VALUES
                        (@Epoch, @RootHash, @RevocationHandleHash, @RevocationRootHash, @Reason, @ActorId, @RevokedAtUtc)
                    ON CONFLICT (epoch, revocation_handle_hash) DO NOTHING;
                    """,
                    new SugarParameter("@Epoch", revocation.Epoch),
                    new SugarParameter("@RootHash", revocation.RootHash),
                    new SugarParameter("@RevocationHandleHash", revocation.RevocationHandleHash),
                    new SugarParameter("@RevocationRootHash", revocation.RevocationRootHash),
                    new SugarParameter("@Reason", "credential_revoked"),
                    new SugarParameter("@ActorId", (object?)credential.AccountId?.ToString() ?? DBNull.Value),
                    new SugarParameter("@RevokedAtUtc", revokedAt));
            }
        });

        return transaction.IsSuccess && updated;
    }

    private static RevocationMetadata? TryParseRevocationMetadata(string? metadataJson)
    {
        if (string.IsNullOrWhiteSpace(metadataJson))
        {
            return null;
        }

        try
        {
            using JsonDocument document = JsonDocument.Parse(metadataJson);
            JsonElement root = document.RootElement;
            if (!TryReadInt64(root, "credentialEpoch", out long epoch) &&
                !TryReadInt64(root, "epoch", out epoch))
            {
                return null;
            }

            string rootHash = ReadToken(root, "rootHash", "credentialRoot");
            string revocationRootHash = ReadToken(root, "revocationRootHash", "revocationRoot");
            string revocationHandleHash = ReadToken(root, "revocationHandleHash");
            return epoch > 0 &&
                IsHexToken(rootHash) &&
                IsHexToken(revocationRootHash) &&
                IsHexToken(revocationHandleHash)
                    ? new RevocationMetadata(epoch, rootHash, revocationRootHash, revocationHandleHash)
                    : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static bool TryReadInt64(JsonElement root, string propertyName, out long value)
    {
        value = 0;
        if (!root.TryGetProperty(propertyName, out JsonElement property))
        {
            return false;
        }

        return property.ValueKind switch
        {
            JsonValueKind.Number => property.TryGetInt64(out value),
            JsonValueKind.String => long.TryParse(property.GetString(), out value),
            _ => false
        };
    }

    private static string ReadToken(JsonElement root, string propertyName, string? fallbackName = null)
    {
        if (root.TryGetProperty(propertyName, out JsonElement property) && property.ValueKind == JsonValueKind.String)
        {
            return NormalizeToken(property.GetString(), string.Empty);
        }

        return fallbackName is not null &&
            root.TryGetProperty(fallbackName, out JsonElement fallback) &&
            fallback.ValueKind == JsonValueKind.String
                ? NormalizeToken(fallback.GetString(), string.Empty)
                : string.Empty;
    }

    private static bool IsHexToken(string value)
    {
        if (value.Length is < 32 or > 128)
        {
            return false;
        }

        for (int i = 0; i < value.Length; i++)
        {
            char c = value[i];
            if (c is not ((>= '0' and <= '9') or (>= 'a' and <= 'f')))
            {
                return false;
            }
        }

        return true;
    }

    private static string NormalizeRequired(string value, string name)
    {
        string normalized = (value ?? string.Empty).Trim();
        if (normalized.Length == 0)
        {
            throw new ArgumentException($"{name} is required", name);
        }

        return normalized;
    }

    private static string NormalizeToken(string? value, string fallback)
    {
        string normalized = (value ?? string.Empty).Trim().ToLowerInvariant().Replace('-', '_');
        return normalized.Length > 0 ? normalized : fallback;
    }

    private sealed record RevocationMetadata(
        long Epoch,
        string RootHash,
        string RevocationRootHash,
        string RevocationHandleHash);
}
