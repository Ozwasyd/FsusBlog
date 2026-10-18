using System.Runtime.ExceptionServices;
using System.Security.Cryptography;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Services.DocumentExport.Jobs;

using SqlSugar;

namespace FsusBlog.Server.Services.DocumentExport.Sources;

/// <summary>
/// PostgreSQL binding authority. Its independent identity sequence supplies positive Int64 source versions;
/// random choice identifiers carry no source identity. Scope serialization bounds retained private bindings.
/// </summary>
public sealed class DocumentExportSourceCatalogStore(ISqlSugarClient db)
{
    public const int MaximumBindingsPerScope = 512;

    internal async Task InTransactionAsync(Func<Task> capture, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (db.Ado.Transaction is not null)
        {
            throw new InvalidOperationException("document_export_source_transaction_owned_elsewhere");
        }
        CancellationToken? previousCancellation = db.Ado.CancellationToken;
        db.Ado.CancellationToken = cancellationToken;
        try
        {
            var result = await db.Ado.UseTranAsync(async () =>
            {
                await capture().ConfigureAwait(false);
                cancellationToken.ThrowIfCancellationRequested();
            }).ConfigureAwait(false);
            if (!result.IsSuccess)
            {
                ExceptionDispatchInfo.Capture(result.ErrorException
                    ?? new InvalidOperationException("document_export_source_transaction_failed")).Throw();
            }
            cancellationToken.ThrowIfCancellationRequested();
        }
        catch (Exception failure)
        {
            // Cleanup owns this transaction and must be able to roll back after the caller cancels.
            db.Ado.CancellationToken = null;
            if (db.Ado.Transaction is not null)
            {
                try
                {
                    await db.Ado.RollbackTranAsync().ConfigureAwait(false);
                }
                catch
                {
                    try
                    {
                        // Provider diagnostics may contain private SQL; retain only a fixed cleanup code.
                        failure.Data["DocumentExportSourceRollbackFailure"] = "document_export_source_rollback_failed";
                    }
                    catch
                    {
                        // Diagnostics must not replace the original transaction failure.
                    }
                }
            }
            throw;
        }
        finally
        {
            db.Ado.CancellationToken = previousCancellation;
        }
    }

    internal async Task<DocumentExportSourceCatalogEntry> CaptureAsync(
        DocumentExportJobActor actor, DocumentExportSourceRequest request, string fingerprint,
        CancellationToken cancellationToken)
    {
        ValidateActor(actor);
        DocumentExportSourceCatalog.Validate(request);
        if (db.Ado.Transaction is null || !IsChoiceId(fingerprint))
        {
            throw new DocumentExportSourceDeniedException();
        }
        cancellationToken.ThrowIfCancellationRequested();
        // The lock is a private concurrency key, never an artifact/source identity.
        await db.Ado.ExecuteCommandAsync(
            "SELECT pg_advisory_xact_lock(hashtextextended(@Scope, 0));",
            new SugarParameter("@Scope", $"document-export-source:{actor.UserId}:{actor.SiteScope}")).ConfigureAwait(false);
        DocumentExportSourceCatalogEntry? existing = await db.Queryable<DocumentExportSourceCatalogEntry>()
            .Where(row => row.OwnerAdminPrincipalId == actor.UserId && row.SiteScope == actor.SiteScope
                && row.Fingerprint == fingerprint)
            .FirstAsync(cancellationToken).ConfigureAwait(false);
        if (existing is not null)
        {
            RequireMatch(existing, request);
            return existing;
        }
        int count = await db.Queryable<DocumentExportSourceCatalogEntry>()
            .Where(row => row.OwnerAdminPrincipalId == actor.UserId && row.SiteScope == actor.SiteScope)
            .CountAsync(cancellationToken).ConfigureAwait(false);
        if (count >= MaximumBindingsPerScope)
        {
            throw new DocumentExportSourceCapacityException();
        }
        string choiceId = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));
        await db.Ado.ExecuteCommandAsync(
            """
            INSERT INTO document_export_source_catalog
                (choice_id, owner_admin_principal_id, site_scope, source_kind, article_id,
                 draft_key, revision_id, publication_id, fingerprint)
            VALUES (@ChoiceId, @Owner, @Site, @Kind, @Article, @Draft,
                CAST(@Revision AS bigint), CAST(@Publication AS bigint), @Fingerprint);
            """,
            new SugarParameter("@ChoiceId", choiceId),
            new SugarParameter("@Owner", actor.UserId),
            new SugarParameter("@Site", actor.SiteScope),
            new SugarParameter("@Kind", (int)request.Kind),
            new SugarParameter("@Article", request.ArticleId),
            new SugarParameter("@Draft", request.DraftKey),
            new SugarParameter("@Revision", request.RevisionId),
            new SugarParameter("@Publication", request.PublicationId),
            new SugarParameter("@Fingerprint", fingerprint)).ConfigureAwait(false);
        DocumentExportSourceCatalogEntry entry = await ReadAsync(actor, choiceId, cancellationToken).ConfigureAwait(false)
            ?? throw new DocumentExportSourceDeniedException();
        RequireMatch(entry, request);
        return entry;
    }

    internal async Task<DocumentExportSourceCatalogEntry?> ReadAsync(
        DocumentExportJobActor actor, string choiceId, CancellationToken cancellationToken)
    {
        ValidateActor(actor);
        if (!IsChoiceId(choiceId))
        {
            throw new DocumentExportSourceDeniedException();
        }
        DocumentExportSourceCatalogEntry? entry = await db.Queryable<DocumentExportSourceCatalogEntry>()
            .Where(row => row.OwnerAdminPrincipalId == actor.UserId && row.SiteScope == actor.SiteScope
                && row.ChoiceId == choiceId)
            .FirstAsync(cancellationToken).ConfigureAwait(false);
        if (entry is not null && (entry.SourceVersion <= 0 || !IsChoiceId(entry.Fingerprint)))
        {
            throw new DocumentExportSourceDeniedException();
        }
        return entry;
    }

    internal static bool IsChoiceId(string? value)
        => value is { Length: 64 } && value.All(character => character is >= '0' and <= '9' or >= 'a' and <= 'f');

    internal async Task<DocumentExportSourceCatalogEntry?> ReadVersionAsync(
        DocumentExportJobActor actor, long sourceVersion, CancellationToken cancellationToken)
    {
        ValidateActor(actor);
        if (sourceVersion <= 0)
        {
            throw new DocumentExportSourceDeniedException();
        }
        return await db.Queryable<DocumentExportSourceCatalogEntry>()
            .Where(row => row.OwnerAdminPrincipalId == actor.UserId && row.SiteScope == actor.SiteScope
                && row.SourceVersion == sourceVersion)
            .FirstAsync(cancellationToken).ConfigureAwait(false);
    }

    private static void RequireMatch(DocumentExportSourceCatalogEntry entry, DocumentExportSourceRequest request)
    {
        if (entry.SourceKind != (int)request.Kind || entry.ArticleId != request.ArticleId
            || entry.DraftKey != request.DraftKey || entry.RevisionId != request.RevisionId
            || entry.PublicationId != request.PublicationId || entry.SourceVersion <= 0 || !IsChoiceId(entry.ChoiceId))
        {
            throw new DocumentExportSourceDeniedException();
        }
    }

    private static void ValidateActor(DocumentExportJobActor actor)
    {
        if (actor is null || actor.UserId <= 0 || actor.SiteScope is not { Length: > 0 and <= 128 }
            || string.IsNullOrWhiteSpace(actor.SiteScope) || actor.SiteScope.Trim() != actor.SiteScope
            || actor.SiteScope.Any(char.IsControl))
        {
            throw new DocumentExportSourceDeniedException();
        }
    }
}
