using SqlSugar;

namespace FsusBlog.Server.Services.Security;

public interface IAnonymousCredentialIssuanceAuditStore
{
    Task<bool> TryRecordIssuedAsync(
        AnonymousCredentialIssuanceAuditWrite write,
        CancellationToken cancellationToken = default);
}

public readonly record struct AnonymousCredentialIssuanceAuditWrite(
    string SubjectHash,
    long Epoch,
    string Status,
    DateTime CreatedAtUtc);

public static class AnonymousCredentialContractLimits
{
    public const int MaxCircuitIdChars = 96;
}

public sealed class AnonymousCredentialIssuanceAuditStore(ISqlSugarClient db) : IAnonymousCredentialIssuanceAuditStore
{
    public async Task<bool> TryRecordIssuedAsync(
        AnonymousCredentialIssuanceAuditWrite write,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        int affected = await db.Ado.ExecuteCommandAsync(
            """
            INSERT INTO anonymous_credential_issuance_audit
                (subject_hash, epoch, status, created_at_utc)
            VALUES
                (@SubjectHash, @Epoch, @Status, @CreatedAtUtc)
            ON CONFLICT(subject_hash, epoch) DO NOTHING;
            """,
            new SugarParameter("@SubjectHash", write.SubjectHash),
            new SugarParameter("@Epoch", write.Epoch),
            new SugarParameter("@Status", write.Status),
            new SugarParameter("@CreatedAtUtc", TruncateToHour(write.CreatedAtUtc)));
        return affected > 0;
    }

    private static DateTime TruncateToHour(DateTime value) =>
        new(value.Year, value.Month, value.Day, value.Hour, 0, 0, DateTimeKind.Utc);
}
