using System.Text.Json;

namespace FsusBlog.Shared.Contracts.ArticleVault;

/// <summary>Exact historical references only; no actor, permission, local facts or execution grant.</summary>
public sealed record ArticleVaultRecoveryHistoryRequest(
    string Schema,
    int ArticleId,
    string ResolutionOperationIdentity,
    string ProposalSha256,
    ArticleVaultOperationIdentity Operation,
    long Sequence,
    string CheckpointSha256);

/// <summary>Closed bounded AEDS payload, independent of the local IPC protocol and its grants.</summary>
public static class ArticleVaultRecoveryHistoryRequestCodec
{
    public const string Schema = "fsusblog.article-vault.recovery-history-request.v1";
    public const int MaximumBytes = 16384;

    public static ArticleVaultRecoveryHistoryRequest Decode(ReadOnlySpan<byte> bytes)
    {
        if (bytes.Length is < 1 or > MaximumBytes)
        {
            throw new InvalidDataException("article_vault_recovery_history_request_size_invalid");
        }
        try
        {
            using JsonDocument document = JsonDocument.Parse(bytes.ToArray(), new()
            {
                MaxDepth = 8
            });
            RejectDuplicates(document.RootElement);
            ArticleVaultRecoveryHistoryRequest? request = ArticleVaultManifestCodec
                .DeserializeCanonical<ArticleVaultRecoveryHistoryRequest>(bytes);
            return Verify(request) ? request! : throw new InvalidDataException("article_vault_recovery_history_request_invalid");
        }
        catch (JsonException)
        {
            throw new InvalidDataException("article_vault_recovery_history_request_invalid");
        }
    }

    public static bool Verify(ArticleVaultRecoveryHistoryRequest? request)
        => request is not null && request.Schema == Schema && request.ArticleId > 0 && request.Operation is not null
            && request.Sequence is >= 0 and <= 9007199254740991
            && ArticleVaultManifestValidator.IsIdentity(request.ResolutionOperationIdentity)
            && ArticleVaultManifestValidator.IsSha256(request.ProposalSha256)
            && ArticleVaultManifestValidator.IsSha256(request.CheckpointSha256);

    private static void RejectDuplicates(JsonElement element)
    {
        if (element.ValueKind == JsonValueKind.Object)
        {
            var keys = new HashSet<string>(StringComparer.Ordinal);
            foreach (JsonProperty property in element.EnumerateObject())
            {
                if (!keys.Add(property.Name))
                {
                    throw new InvalidDataException("article_vault_recovery_history_request_invalid");
                }
                RejectDuplicates(property.Value);
            }
        }
        else if (element.ValueKind == JsonValueKind.Array)
        {
            foreach (JsonElement item in element.EnumerateArray())
            {
                RejectDuplicates(item);
            }
        }
    }
}
