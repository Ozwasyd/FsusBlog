// Appended only to a temporary copy of the digest-pinned independent V1 fixture.
// Keys live only inside that signer process; only public keys and signed bytes are written.
object AddCrossArticleRights(int article, long revision, int number, long parent, DateTimeOffset issued, DateTimeOffset at)
{
    long id = article == 42 ? 201 : 202;
    long snapshot = article == 42 ? 700 : 703;
    var policyHash = article == 42 ? "d742b951390b08022d11f1987744f7760a50728db4c5253687d539588a3d1622" :
        "fe6791a61fd75bdfa7df372205140e0f5245242db220aa2dbb6b8e25c7018296";
    var contentHash = inputs.Single(input => input.Article == article && input.Rev == number).Hash;
    var proof = new ArticleRightsProofInput(1, article, revision, number, snapshot, parent, policyHash, contentHash, issued,
        PublishProofStatus.Ready, PublishProofPublicationState.Public);
    var payload = ArticleRightsProofCanonicalPayloadV1.BuildSigningPayload(proof);
    var signature = rightsSigner.Sign(payload);
    if (!verifier.Verify(payload, signature).Accepted) throw new InvalidOperationException("Independent V1 extra rights signature");
    var entity = new ArticleRightsProof
    {
        Id = id, ProofVersion = 1, SignaturePayloadVersion = 1, ArticleId = article, ArticleRevisionId = revision,
        RevisionNo = number, ArticleRightsSnapshotId = snapshot, PublishProofId = parent,
        IdempotencyKey = ArticleRightsProofIdempotency.BuildKey(article, revision, 1), RightsPolicyHash = policyHash,
        ContentCanonicalHash = contentHash, ProofStatus = "ready", SigningKeyId = signature.KeyId,
        SigningAlgorithm = signature.Algorithm, SignatureBase64Url = signature.SignatureBase64Url
    };
    var (entryId, entryHash) = Append("article-rights-proof", id, article, revision, number,
        FrozenLogWriter.ComputeArticleRightsProofPayloadHash(entity), at.AddTicks(10), signature);
    File.WriteAllBytes($"rights-payload-{article}-{number}.bin", SiteIntegritySigningPayloadCanonicalizer.BuildPayloadBytes(payload));
    return new
    {
        id, proof_version = 1, signature_payload_version = 1, article_id = article, article_revision_id = revision,
        revision_no = number, article_rights_snapshot_id = snapshot, publish_proof_id = parent, idempotency_key = entity.IdempotencyKey,
        rights_policy_hash = policyHash, content_canonical_hash = contentHash, proof_status = "ready",
        signing_key_id = signature.KeyId, signing_key_version = signature.KeyVersion, signing_algorithm = signature.Algorithm,
        signature = signature.SignatureBase64Url, created_at = at, updated_at = at,
        transparency_log_entry_id = entryId, transparency_log_entry_hash = entryHash
    };
}
