using FsusBlog.Server.Entities;
using FsusBlog.Shared.Contracts.ArticleVault;

using Npgsql;

using SqlSugar;

namespace FsusBlog.Server.Services.ArticleVault;

public sealed class PostgresArticleVaultExecutionStore(
    ISqlSugarClient db,
    TimeProvider timeProvider) : IArticleVaultExecutionStore, IArticleVaultTransactionalGroupResultStore
{
    public async Task SealAsync(
        ArticleVaultSealedExecutionBundle bundle,
        CancellationToken cancellationToken = default)
    {
        ArticleVaultExecutionIntegrity.ValidateBundle(bundle);
        var entity = new ArticleVaultExecutionBundleEntity
        {
            PlanReference = bundle.PlanReference,
            PlanSha256 = bundle.PlanSha256,
            SiteIdentity = bundle.Plan.SiteIdentity,
            VaultIdentity = bundle.Plan.VaultIdentity,
            IdempotencyKey = bundle.Plan.IdempotencyKey,
            BundleJson = Serialize(bundle),
            ContentSha256 = bundle.ContentSha256,
            ExpiresAtUtc = DateTimeOffset.FromUnixTimeMilliseconds(bundle.Plan.ExpiresAtUnixMs).UtcDateTime,
            CreatedAtUtc = timeProvider.GetUtcNow().UtcDateTime
        };

        try
        {
            await db.Insertable(entity).ExecuteCommandAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (Exception exception) when (IsUniqueViolation(exception))
        {
            ArticleVaultSealedExecutionBundle? existing = await LoadSealedAsync(
                bundle.PlanReference,
                bundle.PlanSha256,
                cancellationToken).ConfigureAwait(false);
            if (existing is null
                || !ArticleVaultExecutionIntegrity.FixedDigestEquals(existing.ContentSha256, bundle.ContentSha256))
            {
                throw new ArticleVaultExecutionRejectedException("article_vault_execution_bundle_conflict");
            }
        }
    }

    public async Task<ArticleVaultSealedExecutionBundle?> LoadSealedAsync(
        string planReference,
        string planSha256,
        CancellationToken cancellationToken = default)
    {
        ArticleVaultExecutionBundleEntity? entity = await db.Queryable<ArticleVaultExecutionBundleEntity>()
            .Where(item => item.PlanReference == planReference && item.PlanSha256 == planSha256)
            .FirstAsync(cancellationToken).ConfigureAwait(false);
        if (entity is null)
        {
            return null;
        }

        ArticleVaultSealedExecutionBundle bundle = Deserialize<ArticleVaultSealedExecutionBundle>(entity.BundleJson);
        ArticleVaultExecutionIntegrity.ValidateBundle(bundle);
        if (!ArticleVaultExecutionIntegrity.FixedDigestEquals(entity.ContentSha256, bundle.ContentSha256))
        {
            throw new ArticleVaultExecutionRejectedException("article_vault_execution_bundle_store_tampered");
        }
        return bundle;
    }

    public async Task<ArticleVaultGroupResultReceipt?> LoadGroupResultAsync(
        string siteIdentity,
        string vaultIdentity,
        string planSha256,
        string groupIdentity,
        string idempotencySha256,
        CancellationToken cancellationToken = default)
    {
        ArticleVaultGroupResultEntity? entity = await db.Queryable<ArticleVaultGroupResultEntity>()
            .Where(item => item.IdempotencySha256 == idempotencySha256
                && item.SiteIdentity == siteIdentity
                && item.VaultIdentity == vaultIdentity
                && item.PlanSha256 == planSha256
                && item.GroupIdentity == groupIdentity)
            .FirstAsync(cancellationToken).ConfigureAwait(false);
        if (entity is null)
        {
            return null;
        }

        ArticleVaultGroupResultReceipt result = Deserialize<ArticleVaultGroupResultReceipt>(entity.ReceiptJson);
        if (!ArticleVaultExecutionIntegrity.FixedDigestEquals(entity.ContentSha256, result.ContentSha256)
            || result.ContentSha256 != ArticleVaultExecutionIntegrity.SealGroupReceipt(result))
        {
            throw new ArticleVaultExecutionRejectedException("article_vault_group_result_store_tampered");
        }
        return result;
    }

    public async Task SaveGroupResultAsync(
        ArticleVaultGroupResultReceipt result,
        CancellationToken cancellationToken = default)
    {
        if (db.Ado.Transaction is null)
        {
            throw new InvalidOperationException("article_vault_group_result_requires_transaction");
        }
        if (result.ContentSha256 != ArticleVaultExecutionIntegrity.SealGroupReceipt(result))
        {
            throw new ArticleVaultExecutionRejectedException("article_vault_group_result_invalid");
        }

        var entity = new ArticleVaultGroupResultEntity
        {
            IdempotencySha256 = result.IdempotencySha256,
            SiteIdentity = result.SiteIdentity,
            VaultIdentity = result.VaultIdentity,
            PlanSha256 = result.PlanSha256,
            GroupIdentity = result.GroupIdentity,
            ReceiptJson = Serialize(result),
            ContentSha256 = result.ContentSha256,
            CreatedAtUtc = timeProvider.GetUtcNow().UtcDateTime
        };
        await db.Insertable(entity).ExecuteCommandAsync(cancellationToken).ConfigureAwait(false);
    }

    public async Task<ArticleVaultExecutionResult?> LoadResultAsync(
        string resultReference,
        CancellationToken cancellationToken = default)
    {
        ArticleVaultExecutionResultEntity? entity = await db.Queryable<ArticleVaultExecutionResultEntity>()
            .Where(item => item.ResultReference == resultReference)
            .FirstAsync(cancellationToken).ConfigureAwait(false);
        if (entity is null)
        {
            return null;
        }

        ArticleVaultExecutionResult result = Deserialize<ArticleVaultExecutionResult>(entity.ResultJson);
        if (!ArticleVaultExecutionIntegrity.FixedDigestEquals(entity.ContentSha256, result.ContentSha256)
            || result.ContentSha256 != ArticleVaultExecutionIntegrity.SealResult(result))
        {
            throw new ArticleVaultExecutionRejectedException("article_vault_execution_result_store_tampered");
        }
        return result;
    }

    public async Task SaveResultAsync(
        ArticleVaultExecutionResult result,
        CancellationToken cancellationToken = default)
    {
        if (result.ContentSha256 != ArticleVaultExecutionIntegrity.SealResult(result))
        {
            throw new ArticleVaultExecutionRejectedException("article_vault_execution_result_invalid");
        }

        var entity = new ArticleVaultExecutionResultEntity
        {
            ResultReference = result.ResultReference,
            SiteIdentity = result.SiteIdentity,
            VaultIdentity = result.VaultIdentity,
            PlanSha256 = result.PlanSha256,
            ResultJson = Serialize(result),
            ContentSha256 = result.ContentSha256,
            CreatedAtUtc = timeProvider.GetUtcNow().UtcDateTime
        };
        try
        {
            await db.Insertable(entity).ExecuteCommandAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (Exception exception) when (IsUniqueViolation(exception))
        {
            ArticleVaultExecutionResult? existing = await LoadResultAsync(
                result.ResultReference,
                cancellationToken).ConfigureAwait(false);
            if (existing is null
                || !ArticleVaultExecutionIntegrity.AreTerminalResultsEquivalent(existing, result))
            {
                throw new ArticleVaultExecutionRejectedException("article_vault_execution_result_conflict");
            }
        }
    }

    private static string Serialize<T>(T value)
        => System.Text.Encoding.UTF8.GetString(ArticleVaultExecutionIntegrity.Serialize(value));

    private static T Deserialize<T>(string json)
        => ArticleVaultExecutionIntegrity.Deserialize<T>(System.Text.Encoding.UTF8.GetBytes(json));

    private static bool IsUniqueViolation(Exception exception)
    {
        for (Exception? current = exception; current is not null; current = current.InnerException)
        {
            if (current is PostgresException { SqlState: PostgresErrorCodes.UniqueViolation })
            {
                return true;
            }
        }
        return false;
    }
}
