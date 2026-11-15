using System.Data;
using FsusBlogV2.Storage;
using Npgsql;

internal static partial class Migration
{
    private static async Task InitializeAdminCommentBatchAsync(NpgsqlConnection connection, CancellationToken cancellationToken)
    {
        await using var transaction = await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        await PrepareSchemaAddition(connection, transaction, cancellationToken);
        await CurrentSchema.VerifyAdminIdentityMarkerAsync(connection, transaction, cancellationToken);
        bool installed = await CurrentSchema.HasAdminCommentBatchSchemaAsync(connection, transaction, cancellationToken);
        await CurrentSchema.VerifyCatalogAsync(connection, transaction, cancellationToken, requireAdminCommentBatch: installed);
        if (!installed)
        {
            await ApplySchemaAddition(connection, transaction, "zzzz-comment-batch.sql", cancellationToken);
            await CurrentSchema.VerifyCatalogAsync(connection, transaction, cancellationToken, requireAdminCommentBatch: true);
        }
        await transaction.CommitAsync(cancellationToken);
        Console.WriteLine("Verified administrator comment batch moderation schema.");
    }
}
