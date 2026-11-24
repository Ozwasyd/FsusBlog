internal static class NativePublicationProofVectors
{
    private const string ContentHex = "24239fad08e881ba50750f3d8d5ced03746a398201e9e68e7036eefdb9c25bb2";
    private const string PolicyHex = "c2bfe4d5c0d344bae54fc17049ee5d4375f3141601d8f60597b8d1ccabd7689a";
    private const string CoveredContentHex = "cffdeb6306ca41ebdccb54630566de12d19d3f6e0602afa1aea47942553b2be1";
    private const string CoveredPolicyHex = "71bf0b9f49605076ce0c60099358f77d241c63f2fcbb265ffd5d4a7d8a4c0dff";

    internal static void Run(string fixtures)
    {
        RunCanonical(fixtures);
        var publication = new DateTimeOffset(2026, 11, 15, 16, 0, 0, TimeSpan.FromHours(8)).AddTicks(1_200_010);
        var issue = new DateTimeOffset(2026, 11, 15, 8, 10, 0, TimeSpan.Zero).AddTicks(10);
        var proof = new ArticlePublicationProofV2("https://proof.example.test", 42, 9007199254740993, 9007199254741999, 3,
            publication, 9007199254742999, 9007199254743999, HexBytes(ContentHex), HexBytes(PolicyHex), "rotate-1", 7, Repeat(0x3a), issue);
        var actual = ArticlePublicationProofPayloadV2.Build(proof);
        CheckTranscript(fixtures, "article-publication-proof-v2.txt", actual, "8169f3b97e599c57fed6d9180d5de33b781766b03d006995a01832b3c0392ce2");
        CheckTranscript(fixtures, "article-publication-proof-canonical-v3.txt", ArticlePublicationProofPayloadV2.Build(proof with
            { CanonicalVersion = 3, ContentSha256 = HexBytes(CoveredContentHex), PolicySha256 = HexBytes(CoveredPolicyHex) }),
            "49094228337db15d32c64529d8dfd1d020582387c2c1678fd1ea75888b16923d");

        var signature = Enumerable.Range(0, 64).Select(static v => (byte)v).ToArray();
        var receipt = PublicationTransparencyV2.ReceiptDigest(actual, signature);
        var first = PublicationTransparencyV2.EntryDigest(1, new byte[32], receipt);
        Array.Reverse(signature);
        var second = PublicationTransparencyV2.EntryDigest(2, first, PublicationTransparencyV2.ReceiptDigest(actual, signature));
        Require(HexLower(receipt) == "5dffc260f61746045a28db99a7ea53539b53e3ea8966a2017cfea2a6c9dd99d3" &&
            HexLower(first) == "25cf7e05fb5664cef60be983608af44f766e61071985f9555c665af0874f6378" &&
            HexLower(second) == "7fa4d9ff96c8a5324a9f912e1012a2ef686a92ac0308cee6b089191b54c6ddb3");

        var head = new PublicationTransparencyHeadV2("https://proof.example.test", 9007199254741001, second, "rotate-1", 7, Repeat(0x3a), issue);
        CheckTranscript(fixtures, "article-transparency-head-v2.txt", head.Payload(), "5119fe2b46a5a796b86ec648b49fd22457ddab7b4363c04a4516835e6de6c040");
        VerifyCheckpoints(fixtures, issue.AddTicks(10));
        foreach (var invalid in new[] { proof with { IssuedAt = issue.AddTicks(1) }, proof with { IssuedAt = publication.AddTicks(-10) },
            proof with { Origin = "https://proof.example.test/private" }, proof with { KeyVersion = 0 }, proof with { CanonicalVersion = 4 } })
            Reject<ArgumentException>(() => ArticlePublicationProofPayloadV2.Build(invalid));
    }

    private static void RunCanonical(string fixtures)
    {
        var article = new CanonicalArticleV2(42, 9007199254740993, "Réseau 🐈", "Cafe\u0301\r\n独立😀\n", null, [42, 11, 42]);
        var rights = new ArticleRightsPolicy(article.ArticleId, article.Revision, true, false, "CC-BY-4.0", "", 0, "État\n新", "{title}",
            "append-attribution", 0, true, false, true);
        var content = ArticleCanonicalHashesV2.ContentDigest(article);
        var policy = ArticleCanonicalHashesV2.PolicyDigest(rights, content);
        CheckTranscript(fixtures, "article-content-canonical-v2.txt", ArticleCanonicalHashesV2.ContentPayload(article), ContentHex);
        CheckTranscript(fixtures, "article-policy-canonical-v2.txt", ArticleCanonicalHashesV2.PolicyPayload(rights, content), PolicyHex);
        Require(HexLower(content) == ContentHex && HexLower(policy) == PolicyHex);
        foreach (var changed in new[] { article with { Markdown = "Café\n独立😀\n" }, article with { Markdown = article.Markdown.TrimEnd('\n') },
            article with { CategoryId = 42 }, article with { Revision = article.Revision - 1 } })
            Require(!ArticleCanonicalHashesV2.ContentDigest(changed).AsSpan().SequenceEqual(content));
        foreach (var changed in new[] { rights with { Enabled = true }, rights with { ProofBindingEnabled = false }, rights with { CopyrightYear = 2026 } })
            Require(!ArticleCanonicalHashesV2.PolicyDigest(changed, content).AsSpan().SequenceEqual(policy));

        var covered = article with { CoverMediaSha256 = Enumerable.Range(0, 32).Select(static v => (byte)v).ToArray() };
        CheckTranscript(fixtures, "article-content-canonical-v3.txt", ArticleCanonicalHashesV2.ContentPayload(covered), CoveredContentHex);
        var coveredContent = ArticleCanonicalHashesV2.ContentDigest(covered);
        Require(HexLower(coveredContent) == CoveredContentHex &&
            HexLower(ArticleCanonicalHashesV2.PolicyDigest(rights, coveredContent)) == CoveredPolicyHex &&
            !ArticleCanonicalHashesV2.ContentDigest(covered with { CoverMediaSha256 = new byte[32] }).AsSpan().SequenceEqual(coveredContent));
        RejectEach<byte[]>([[], new byte[31], new byte[33]], invalid => ArticleCanonicalHashesV2.ContentDigest(covered with { CoverMediaSha256 = invalid }));
    }

    private static void VerifyCheckpoints(string fixtures, DateTimeOffset issued)
    {
        const long start = 9007199254741001;
        var entries = new byte[] { 0x11, 0x22, 0x33 }.Select(Repeat).ToArray();
        var tree = PublicationCheckpointTreeV2.Build(start, entries, start + 2);
        Require(HexLower(tree.RootSha256) == "963380bd8bc6cfe8fd61281c1a4938fc94e04666fd3372b74b319d0c6f9f4840" &&
            tree.Inclusion is { Siblings.Count: 2 } witness &&
            HexLower(witness.LeafSha256) == "27826deb7e05792ea526bfe761fe4272205c247afd425789bb9c9edec3c8d6f3" &&
            witness.LeafSha256.AsSpan().SequenceEqual(witness.Siblings[0]) &&
            HexLower(witness.Siblings[1]) == "5effb111c1c250c40435fc625350efe37a9d688b92ced3884380852b8d1a06a8");
        var claim = new PublicationCheckpointV2("https://proof.example.test", "release-2026.11", start, start + 2, 3,
            tree.RootSha256, start + 2, entries[2], "rotate-1", 7, Repeat(0x3a), issued);
        CheckTranscript(fixtures, "publication-release-checkpoint-v2.txt", claim.Payload(), "76c256ab3594588f01df569b09a7bd3dd472554850fb23230e52fae6246e2b0c");

        var dailyTree = PublicationCheckpointTreeV2.Build([new(1, Repeat(0x11)), new(3, Repeat(0x33)), new(5, Repeat(0x55))], 5);
        Require(dailyTree.Inclusion is { Siblings.Count: 2, Position: 2, Entry.Sequence: 5 } dailyWitness &&
            HexLower(dailyWitness.Siblings[0]) == "44578fa957de83c75cda97c2be6ad8f426d33401728fc547dd6d2bb409232003" &&
            HexLower(dailyWitness.Siblings[1]) == "7c441a12a87057e7d2322f6fc0efef9e5717d10bc61478296a89ff68f7680a57");
        var daily = new PublicationCheckpointV2("https://proof.example.test", "2026-11-14", 1, 5, 3, dailyTree.RootSha256,
            6, Repeat(0x66), "rotate-1", 7, Repeat(0x3a), issued, PublicationCheckpointKind.Daily);
        CheckTranscript(fixtures, "publication-daily-checkpoint-discontiguous-v2.txt", daily.Payload(), "58392c7f7f092980e009f199edeb4b0d5ab88d4aed95ed39ff5a1b30a26d3545");
        CheckTranscript(fixtures, "publication-daily-checkpoint-empty-v2.txt",
            (daily with { FromSequence = 0, ToSequence = 0, EntryCount = 0, RootSha256 = PublicationCheckpointTreeV2.EmptyDailyRoot() }).Payload(),
            "fc7a7138e69120a53ef7222f4f6072c2f945104809e153b6f14b3eb19cfcb096");
    }

    private static byte[] Repeat(byte value) => Enumerable.Repeat(value, 32).ToArray();

    private static void CheckTranscript(string fixtures, string file, byte[] payload, string sha256) =>
        Require(File.ReadAllBytes(Path.Combine(fixtures, file)).AsSpan().SequenceEqual(payload) &&
            HexLower(SHA256.HashData(payload)) == sha256, $"Native transcript mismatch for {file}");
}
