using FsusBlog.Server.Entities;
using SqlSugar;

namespace FsusBlog.Server.Services.Security;

public interface IAnonymousCredentialService
{
    Task<AnonymousCredential> IssueAsync(
        int? userId,
        string commitmentHash,
        string credentialType = AnonymousCredentialTypes.AccountBound,
        string credentialLevel = AnonymousCredentialLevels.Basic,
        string metadataJson = "{}",
        CancellationToken cancellationToken = default);

    Task<AnonymousCredential?> GetActiveCredentialAsync(
        int? userId,
        string? commitmentHash = null,
        CancellationToken cancellationToken = default);

    Task<string?> GetCredentialLevelAsync(
        int? userId,
        string? commitmentHash = null,
        CancellationToken cancellationToken = default);

    Task<bool> RevokeAsync(long credentialId, CancellationToken cancellationToken = default);
}

public sealed class AnonymousCredentialService(ISqlSugarClient db) : IAnonymousCredentialService
{
    public async Task<AnonymousCredential> IssueAsync(
        int? userId,
        string commitmentHash,
        string credentialType = AnonymousCredentialTypes.AccountBound,
        string credentialLevel = AnonymousCredentialLevels.Basic,
        string metadataJson = "{}",
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        string normalizedCommitment = NormalizeRequired(commitmentHash, nameof(commitmentHash));
        var credential = new AnonymousCredential
        {
            UserId = userId,
            CommitmentHash = normalizedCommitment,
            CredentialType = NormalizeToken(credentialType, AnonymousCredentialTypes.AccountBound),
            CredentialLevel = NormalizeToken(credentialLevel, AnonymousCredentialLevels.Basic),
            Status = AnonymousCredentialStatuses.Active,
            IssuedAtUtc = DateTime.UtcNow,
            MetadataJson = string.IsNullOrWhiteSpace(metadataJson) ? "{}" : metadataJson.Trim()
        };
        credential.Id = await db.Insertable(credential).ExecuteReturnSnowflakeIdAsync();
        return credential;
    }

    public async Task<AnonymousCredential?> GetActiveCredentialAsync(
        int? userId,
        string? commitmentHash = null,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        string? normalizedCommitment = string.IsNullOrWhiteSpace(commitmentHash) ? null : commitmentHash.Trim();
        if (userId is null && normalizedCommitment is null)
        {
            return null;
        }

        return await db.Queryable<AnonymousCredential>()
            .Where(c => c.Status == AnonymousCredentialStatuses.Active && c.RevokedAtUtc == null)
            .WhereIF(userId.HasValue, c => c.UserId == userId)
            .WhereIF(normalizedCommitment != null, c => c.CommitmentHash == normalizedCommitment)
            .OrderByDescending(c => c.IssuedAtUtc)
            .FirstAsync();
    }

    public async Task<string?> GetCredentialLevelAsync(
        int? userId,
        string? commitmentHash = null,
        CancellationToken cancellationToken = default)
    {
        AnonymousCredential? credential = await GetActiveCredentialAsync(userId, commitmentHash, cancellationToken);
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
