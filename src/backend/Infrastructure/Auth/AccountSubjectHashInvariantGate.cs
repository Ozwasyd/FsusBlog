using SqlSugar;

namespace FsusBlog.Server.Infrastructure.Auth;

/// <summary>Verifies that every persisted account has a valid stable subject projection before traffic is served.</summary>
public interface IAccountSubjectHashInvariantGate
{
    Task EnsureAsync(CancellationToken cancellationToken = default);
}

/// <summary>
/// Permanent startup gate. This is intentionally independent from migration
/// history so a stale rolling node cannot reintroduce an unprojected account
/// after the one-time backfill has completed.
/// </summary>
public sealed class AccountSubjectHashInvariantGate(ISqlSugarClient db) : IAccountSubjectHashInvariantGate
{
    /// <inheritdoc />
    public async Task EnsureAsync(CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        int invalidAccounts = await db.Ado.GetIntAsync("""
            SELECT COUNT(1)
            FROM sys_user
            WHERE account_subject_hash IS NULL
               OR btrim(account_subject_hash) = ''
               OR account_subject_hash !~ '^[0-9a-f]{64}$';
            """).ConfigureAwait(false);

        cancellationToken.ThrowIfCancellationRequested();
        if (invalidAccounts > 0)
        {
            throw new InvalidOperationException(
                $"Account subject projection is incomplete for {invalidAccounts} account(s). Complete the backfill before serving traffic.");
        }
    }
}
