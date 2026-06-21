using FsusBlog.Server.Entities;
using SqlSugar;

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
        return await db.Updateable<AnonymousCredential>()
            .SetColumns(c => c.Status == AnonymousCredentialStatuses.Revoked)
            .SetColumns(c => c.RevokedAtUtc == DateTime.UtcNow)
            .Where(c => c.Id == credentialId && c.RevokedAtUtc == null)
            .ExecuteCommandAsync() > 0;
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
}
