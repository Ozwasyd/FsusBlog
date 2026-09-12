using FsusBlog.Server.Entities;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Independent verifier for canonical create receipts: re-checks the durable closure of
/// request → transaction → article graph → asset references → outbox → audit against the
/// stored receipt and rejects any tamper or drift.
/// </summary>
public static class ArticleCreateVerifier
{
    public static ArticleCreateVerificationResult Verify(ArticleCreateVerificationSnapshot snapshot)
    {
        ArgumentNullException.ThrowIfNull(snapshot);
        var violations = new List<ArticleTemplateVerificationViolation>();
        ArticleCreateReceipt receipt = snapshot.Receipt;

        bool modeConsistent = receipt.CreateMode switch
        {
            "blank" => receipt.TemplateId is null
                && receipt.TemplateVersionId is null
                && receipt.PlanDigest is null
                && receipt.DefaultsDigest is null
                && receipt.ReferenceDigest is null,
            "template" => receipt.TemplateId is not null
                && receipt.TemplateVersionId is not null
                && receipt.TemplateVersionNumber is not null
                && receipt.PlanDigest is not null
                && receipt.DefaultsDigest is not null
                && receipt.ReferenceDigest is not null,
            _ => false
        };
        if (!modeConsistent)
        {
            violations.Add(new("create_mode_set_invalid", "receipt template set does not match mode"));
        }
        if (snapshot.ArticleId != receipt.ArticleId)
        {
            violations.Add(new("create_article_missing", "article row missing or mismatched"));
        }
        if (snapshot.ArticleStatus is not null
            && snapshot.ArticleStatus != (int)ArticleStatus.Draft)
        {
            violations.Add(new("create_draft_only_violated", "article left draft status"));
        }
        if (snapshot.ArticlePublishedAt is not null)
        {
            violations.Add(new("create_publication_forbidden", "published_at forged on create"));
        }
        if (snapshot.ArticleCurrentRevisionId != receipt.RevisionId)
        {
            violations.Add(new("create_revision_binding_drift", "current revision mismatch"));
        }
        if (snapshot.DraftId != receipt.DraftId
            || snapshot.DraftServerRevision != receipt.DraftServerRevision)
        {
            violations.Add(new("create_draft_missing", "draft row missing or mismatched"));
        }
        if (snapshot.RevisionId != receipt.RevisionId || snapshot.RevisionNo != 1)
        {
            violations.Add(new("create_revision_missing", "initial revision missing or renumbered"));
        }
        if (!snapshot.OutboxEventPresent)
        {
            violations.Add(new("create_outbox_missing", "outbox event missing"));
        }
        if (snapshot.AuditLink is null)
        {
            violations.Add(new("create_audit_missing", "signed audit link missing"));
        }
        else if (!string.Equals(snapshot.AuditLink.EventInfo, receipt.AuditDigest, StringComparison.Ordinal)
            || !string.Equals(snapshot.AuditLink.TargetId,
                receipt.AuditReference.ToString("N"), StringComparison.OrdinalIgnoreCase)
            || !string.Equals(snapshot.AuditLink.Outcome, "success", StringComparison.Ordinal))
        {
            violations.Add(new("create_audit_tamper", "audit link does not match receipt"));
        }
        return new ArticleCreateVerificationResult(
            violations.Count == 0,
            Array.AsReadOnly(violations.ToArray()));
    }
}
