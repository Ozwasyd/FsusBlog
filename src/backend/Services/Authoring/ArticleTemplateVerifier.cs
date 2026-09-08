using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Auth;

namespace FsusBlog.Server.Services.Authoring;

public sealed class ArticleTemplateVerifier : IArticleTemplateVerifier
{
    public ArticleTemplateVerificationResult Verify(ArticleTemplateVerificationSnapshot snapshot)
    {
        ArgumentNullException.ThrowIfNull(snapshot);
        var violations = new List<ArticleTemplateVerificationViolation>();
        TryValidate(
            () => ArticleTemplateContract.ValidateDefinition(snapshot.Definition),
            "definition_tamper",
            snapshot.Definition.TemplateId.ToString("D"),
            violations);

        ArticleTemplateVersion[] versions = [.. snapshot.Versions.OrderBy(static version => version.VersionNumber)];
        if (versions.Length == 0
            || versions.Length > ArticleTemplateContract.MaxVersionsPerTemplate
            || versions.Select(static version => version.VersionId).Distinct().Count() != versions.Length
            || versions.Select(static version => version.VersionNumber).Distinct().Count() != versions.Length)
        {
            violations.Add(new("version_identity_invalid", "Version identities are missing, duplicated, or over budget."));
        }
        for (int index = 0; index < versions.Length; index++)
        {
            ArticleTemplateVersion version = versions[index];
            TryValidate(
                () => ArticleTemplateContract.ValidateVersion(version),
                "version_tamper",
                version.VersionId.ToString("D"),
                violations);
            if (version.TemplateId != snapshot.Definition.TemplateId || version.VersionNumber != index + 1)
            {
                violations.Add(new("version_sequence_invalid", version.VersionId.ToString("D")));
            }
        }

        ArticleTemplateVersion? current = versions.LastOrDefault();
        if (current is null
            || current.VersionId != snapshot.Definition.CurrentVersionId
            || current.VersionNumber != snapshot.Definition.CurrentVersionNumber)
        {
            violations.Add(new("current_version_binding_invalid", snapshot.Definition.TemplateId.ToString("D")));
        }

        if (snapshot.ReceiptLimitExceeded)
        {
            violations.Add(new("receipt_budget_exceeded", "Verification history exceeded the bounded receipt budget."));
        }
        ArticleTemplateWriteReceipt[] receipts =
            [.. snapshot.Receipts.OrderBy(static receipt => receipt.TemplateRevision)];
        if (receipts.Length == 0
            || receipts.Select(static receipt => receipt.ReceiptId).Distinct().Count() != receipts.Length)
        {
            violations.Add(new("receipt_identity_invalid", "Receipt history is missing or duplicated."));
        }
        for (int index = 0; index < receipts.Length; index++)
        {
            ArticleTemplateWriteReceipt receipt = receipts[index];
            TryValidate(
                () => ArticleTemplateContract.ValidateReceipt(receipt),
                "receipt_tamper",
                receipt.ReceiptId.ToString("D"),
                violations);
            if (receipt.TemplateId != snapshot.Definition.TemplateId
                || receipt.PreviousTemplateRevision != index
                || receipt.TemplateRevision != index + 1)
            {
                violations.Add(new("receipt_revision_sequence_invalid", receipt.ReceiptId.ToString("D")));
            }
        }
        ArticleTemplateWriteReceipt? latest = receipts.LastOrDefault();
        if (latest is null
            || latest.TemplateRevision != snapshot.Definition.Revision
            || !string.Equals(latest.DefinitionDigest, snapshot.Definition.ContentDigest, StringComparison.Ordinal))
        {
            violations.Add(new("receipt_head_binding_invalid", snapshot.Definition.TemplateId.ToString("D")));
        }

        Dictionary<Guid, ArticleTemplateWriteReceipt> versionReceipts = receipts
            .Where(static receipt => receipt.VersionId.HasValue)
            .GroupBy(static receipt => receipt.VersionId!.Value)
            .Where(static group => group.Count() == 1)
            .ToDictionary(static group => group.Key, static group => group.Single());
        foreach (ArticleTemplateVersion version in versions)
        {
            if (!versionReceipts.TryGetValue(version.VersionId, out ArticleTemplateWriteReceipt? receipt)
                || receipt.VersionNumber != version.VersionNumber
                || !string.Equals(receipt.VersionDigest, version.ContentDigest, StringComparison.Ordinal)
                || !string.Equals(receipt.DefaultsDigest, version.DefaultsDigest, StringComparison.Ordinal))
            {
                violations.Add(new("version_receipt_binding_invalid", version.VersionId.ToString("D")));
            }
        }

        Dictionary<Guid, ArticleTemplateIdempotencyRecord> idempotency = snapshot.IdempotencyRecords
            .GroupBy(static record => record.ReceiptId)
            .Where(static group => group.Count() == 1)
            .ToDictionary(static group => group.Key, static group => group.Single());
        foreach (ArticleTemplateWriteReceipt receipt in receipts)
        {
            if (!idempotency.TryGetValue(receipt.ReceiptId, out ArticleTemplateIdempotencyRecord? record)
                || record.ActorAdminPrincipalId != receipt.ActorAdminPrincipalId
                || record.RequestId != receipt.RequestId
                || !string.Equals(record.CommandDigest, receipt.CommandDigest, StringComparison.Ordinal))
            {
                violations.Add(new("idempotency_receipt_binding_invalid", receipt.ReceiptId.ToString("D")));
            }
        }

        ILookup<Guid, ArticleTemplateAuditLink> auditLinks = snapshot.AuditLinks
            .ToLookup(static link => link.AuditReference);
        foreach (ArticleTemplateWriteReceipt receipt in receipts)
        {
            ArticleTemplateAuditLink[] links = [.. auditLinks[receipt.AuditReference]];
            if (links.Length == 0)
            {
                violations.Add(new("audit_link_missing", receipt.AuditReference.ToString("D")));
                continue;
            }
            if (links.Length != 1)
            {
                violations.Add(new("audit_link_duplicate", receipt.AuditReference.ToString("D")));
                continue;
            }
            ArticleTemplateAuditLink link = links[0];
            if (!string.Equals(link.Source, AuditSourceCatalog.Article, StringComparison.Ordinal)
                || !string.Equals(link.Type, AuditTypeCatalog.Business, StringComparison.Ordinal)
                || !string.Equals(link.Action, AdminPermissions.ArticleWrite, StringComparison.Ordinal)
                || !string.Equals(link.TargetType, "article-template-receipt", StringComparison.Ordinal)
                || !string.Equals(link.TargetId, receipt.AuditReference.ToString("N"), StringComparison.Ordinal)
                || !string.Equals(link.EventInfo, receipt.AuditDigest, StringComparison.Ordinal)
                || !string.Equals(link.ReasonCode, receipt.CommandKind, StringComparison.Ordinal)
                || !string.Equals(link.Outcome, AuditOutcomeCatalog.Success, StringComparison.Ordinal)
                || !link.IsHighValue)
            {
                violations.Add(new("audit_link_tamper", receipt.AuditReference.ToString("D")));
            }
        }

        return new(violations.Count == 0, Array.AsReadOnly(violations.ToArray()));
    }

    private static void TryValidate(
        Action validation,
        string code,
        string detail,
        List<ArticleTemplateVerificationViolation> violations)
    {
        try
        {
            validation();
        }
        catch (Exception exception) when (exception is ArticleTemplateValidationException)
        {
            violations.Add(new(code, detail));
        }
    }
}

