using FsusBlog.V2.Contracts;

internal static class NativeArticleCanonicalVectors
{
    internal static void Run(string fixtures)
    {
        var article = new CanonicalArticleV2(42, 9007199254740993, "Réseau 🐈", "Cafe\u0301\r\n独立😀\n", null, [42, 11, 42]);
        var rights = new ArticleRightsPolicy(article.ArticleId, article.Revision, true, false, "CC-BY-4.0", "", 0, "État\n新", "{title}",
            "append-attribution", 0, true, false, true);
        var content = ArticleCanonicalHashesV2.ContentDigest(article);
        var policy = ArticleCanonicalHashesV2.PolicyDigest(rights, content);
        Equal("article-content-canonical-v2.txt", ArticleCanonicalHashesV2.ContentPayload(article));
        Equal("article-policy-canonical-v2.txt", ArticleCanonicalHashesV2.PolicyPayload(rights, content));
        if (Convert.ToHexStringLower(content) != "24239fad08e881ba50750f3d8d5ced03746a398201e9e68e7036eefdb9c25bb2" || Convert.ToHexStringLower(policy) != "c2bfe4d5c0d344bae54fc17049ee5d4375f3141601d8f60597b8d1ccabd7689a")
            throw new InvalidOperationException("A native canonical SHA-256 differs from the independent vector.");
        foreach (var changed in new[] { article with { Markdown = "Café\n独立😀\n" }, article with { Markdown = article.Markdown.TrimEnd('\n') },
            article with { CategoryId = 42 }, article with { Revision = article.Revision - 1 } })
            if (ArticleCanonicalHashesV2.ContentDigest(changed).AsSpan().SequenceEqual(content))
                throw new InvalidOperationException("A change to an exact native article fact was lost.");
        foreach (var changed in new[] { rights with { Enabled = true }, rights with { ProofBindingEnabled = false }, rights with { CopyrightYear = 2026 } })
            if (ArticleCanonicalHashesV2.PolicyDigest(changed, content).AsSpan().SequenceEqual(policy))
                throw new InvalidOperationException("A change to an exact native rights fact was lost.");

        var cover = Enumerable.Range(0, 32).Select(static value => (byte)value).ToArray();
        var covered = article with { CoverMediaSha256 = cover };
        Equal("article-content-canonical-v3.txt", ArticleCanonicalHashesV2.ContentPayload(covered));
        var coveredContent = ArticleCanonicalHashesV2.ContentDigest(covered);
        var coveredPolicy = ArticleCanonicalHashesV2.PolicyDigest(rights, coveredContent);
        if (Convert.ToHexStringLower(coveredContent) != "cffdeb6306ca41ebdccb54630566de12d19d3f6e0602afa1aea47942553b2be1" ||
            Convert.ToHexStringLower(coveredPolicy) != "71bf0b9f49605076ce0c60099358f77d241c63f2fcbb265ffd5d4a7d8a4c0dff")
            throw new InvalidOperationException("A native canonical cover digest differs from the independent vector.");
        var replacedCoverContent = ArticleCanonicalHashesV2.ContentDigest(covered with { CoverMediaSha256 = new byte[32] });
        if (replacedCoverContent.AsSpan().SequenceEqual(coveredContent))
            throw new InvalidOperationException("The managed publication cover did not change the canonical SHA-256.");
        foreach (var invalid in new byte[][] { [], new byte[31], new byte[33] })
            ProtocolRejection.Assert(() => ArticleCanonicalHashesV2.ContentDigest(covered with { CoverMediaSha256 = invalid }),
                "An invalid managed cover digest was accepted.");

        void Equal(string file, byte[] actual)
        {
            if (!File.ReadAllBytes(Path.Combine(fixtures, file)).AsSpan().SequenceEqual(actual))
                throw new InvalidOperationException($"Native canonical bytes differ for {file}.");
        }
    }
}
