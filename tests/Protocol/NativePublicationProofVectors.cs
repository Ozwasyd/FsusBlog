using System.Security.Cryptography;
using FsusBlog.V2.Contracts;

internal static class NativePublicationProofVectors
{
    internal static void Run(string fixtures)
    {
        var publication = new DateTimeOffset(2026, 11, 15, 16, 0, 0, TimeSpan.FromHours(8)).AddTicks(1_200_010);
        var issue = new DateTimeOffset(2026, 11, 15, 8, 10, 0, TimeSpan.Zero).AddTicks(10);
        var proof = new ArticlePublicationProofV2("https://proof.example.test", 42, 9007199254740993, 9007199254741999, 3,
            publication, 9007199254742999, 9007199254743999,
            Convert.FromHexString("24239fad08e881ba50750f3d8d5ced03746a398201e9e68e7036eefdb9c25bb2"),
            Convert.FromHexString("c2bfe4d5c0d344bae54fc17049ee5d4375f3141601d8f60597b8d1ccabd7689a"),
            "rotate-1", 7, Enumerable.Repeat((byte)0x3a, 32).ToArray(), issue);
        var actual = ArticlePublicationProofPayloadV2.Build(proof);
        if (!File.ReadAllBytes(Path.Combine(fixtures, "article-publication-proof-v2.txt")).AsSpan().SequenceEqual(actual) ||
            Convert.ToHexStringLower(SHA256.HashData(actual)) != "8169f3b97e599c57fed6d9180d5de33b781766b03d006995a01832b3c0392ce2")
            throw new InvalidOperationException("Native signing transcript differs from the independent vector.");
        var covered = ArticlePublicationProofPayloadV2.Build(proof with
        {
            CanonicalVersion = 3,
            ContentSha256 = Convert.FromHexString("cffdeb6306ca41ebdccb54630566de12d19d3f6e0602afa1aea47942553b2be1"),
            PolicySha256 = Convert.FromHexString("71bf0b9f49605076ce0c60099358f77d241c63f2fcbb265ffd5d4a7d8a4c0dff"),
        });
        if (!File.ReadAllBytes(Path.Combine(fixtures, "article-publication-proof-canonical-v3.txt")).AsSpan().SequenceEqual(covered) ||
            Convert.ToHexStringLower(SHA256.HashData(covered)) != "49094228337db15d32c64529d8dfd1d020582387c2c1678fd1ea75888b16923d")
            throw new InvalidOperationException("The managed cover signing transcript differs from the independent vector.");
        VerifyTransparency(actual);
        var head = new PublicationTransparencyHeadV2("https://proof.example.test", 9007199254741001,
            Convert.FromHexString("7fa4d9ff96c8a5324a9f912e1012a2ef686a92ac0308cee6b089191b54c6ddb3"), "rotate-1", 7,
            Enumerable.Repeat((byte)0x3a, 32).ToArray(), issue);
        var headPayload = head.Payload();
        if (!File.ReadAllBytes(Path.Combine(fixtures, "article-transparency-head-v2.txt")).AsSpan().SequenceEqual(headPayload) ||
            Convert.ToHexStringLower(SHA256.HashData(headPayload)) != "5119fe2b46a5a796b86ec648b49fd22457ddab7b4363c04a4516835e6de6c040")
            throw new InvalidOperationException("Native public head signing bytes differ from the independent vector.");
        VerifyCheckpoint(fixtures, issue.AddTicks(10));
        VerifyDailyCheckpoint(fixtures, issue.AddTicks(10));
        foreach (var invalid in new[] { proof with { IssuedAt = issue.AddTicks(1) }, proof with { IssuedAt = publication.AddTicks(-10) },
            proof with { Origin = "https://proof.example.test/private" }, proof with { KeyVersion = 0 }, proof with { CanonicalVersion = 4 } })
        {
            try { ArticlePublicationProofPayloadV2.Build(invalid); }
            catch (ArgumentException) { continue; }
            throw new InvalidOperationException("An invalid signing transcript was accepted.");
        }
    }

    private static void VerifyTransparency(byte[] transcript)
    {
        // SHA-256 fixtures independently computed from the checked-in transcript and 0..63 in both orders.
        var signature = Enumerable.Range(0, 64).Select(static value => (byte)value).ToArray();
        var receipt = PublicationTransparencyV2.ReceiptDigest(transcript, signature);
        var first = PublicationTransparencyV2.EntryDigest(1, new byte[32], receipt);
        Array.Reverse(signature);
        var successor = PublicationTransparencyV2.ReceiptDigest(transcript, signature);
        var second = PublicationTransparencyV2.EntryDigest(2, first, successor);
        if (Convert.ToHexStringLower(receipt) != "5dffc260f61746045a28db99a7ea53539b53e3ea8966a2017cfea2a6c9dd99d3" ||
            Convert.ToHexStringLower(first) != "25cf7e05fb5664cef60be983608af44f766e61071985f9555c665af0874f6378" ||
            Convert.ToHexStringLower(second) != "7fa4d9ff96c8a5324a9f912e1012a2ef686a92ac0308cee6b089191b54c6ddb3")
            throw new InvalidOperationException("Native transparency digests differ from the independent vectors.");
    }

    private static void VerifyCheckpoint(string fixtures, DateTimeOffset issued)
    {
        const long start = 9007199254741001;
        var entries = new byte[] { 0x11, 0x22, 0x33 }.Select(value => Enumerable.Repeat(value, 32).ToArray()).ToArray();
        var tree = PublicationCheckpointTreeV2.Build(start, entries, start + 2);
        if (Convert.ToHexStringLower(tree.RootSha256) != "963380bd8bc6cfe8fd61281c1a4938fc94e04666fd3372b74b319d0c6f9f4840" ||
            tree.Inclusion is not { Siblings.Count: 2 } witness ||
            Convert.ToHexStringLower(witness.LeafSha256) != "27826deb7e05792ea526bfe761fe4272205c247afd425789bb9c9edec3c8d6f3" ||
            !witness.LeafSha256.AsSpan().SequenceEqual(witness.Siblings[0]) ||
            Convert.ToHexStringLower(witness.Siblings[1]) != "5effb111c1c250c40435fc625350efe37a9d688b92ced3884380852b8d1a06a8")
            throw new InvalidOperationException("Native checkpoint odd-node inclusion differs from the independent vector.");
        var claim = new PublicationCheckpointV2("https://proof.example.test", "release-2026.11", start, start + 2, 3,
            tree.RootSha256, start + 2, entries[2], "rotate-1", 7,
            Enumerable.Repeat((byte)0x3a, 32).ToArray(), issued);
        var payload = claim.Payload();
        if (!File.ReadAllBytes(Path.Combine(fixtures, "publication-release-checkpoint-v2.txt")).AsSpan().SequenceEqual(payload) ||
            Convert.ToHexStringLower(SHA256.HashData(payload)) != "76c256ab3594588f01df569b09a7bd3dd472554850fb23230e52fae6246e2b0c")
            throw new InvalidOperationException("Native checkpoint transcript differs from the independent vector.");
    }

    private static void VerifyDailyCheckpoint(string fixtures, DateTimeOffset issued)
    {
        var entries = new PublicationCheckpointEntry[] { new(1, Repeat(0x11)), new(3, Repeat(0x33)), new(5, Repeat(0x55)) };
        var tree = PublicationCheckpointTreeV2.Build(entries, 5);
        if (tree.Inclusion is not { Siblings.Count: 2, Position: 2, Entry.Sequence: 5 } witness ||
            Convert.ToHexStringLower(witness.Siblings[0]) != "44578fa957de83c75cda97c2be6ad8f426d33401728fc547dd6d2bb409232003" ||
            Convert.ToHexStringLower(witness.Siblings[1]) != "7c441a12a87057e7d2322f6fc0efef9e5717d10bc61478296a89ff68f7680a57")
            throw new InvalidOperationException("The discontiguous daily checkpoint membership path differs from the independent vector.");
        var daily = new PublicationCheckpointV2("https://proof.example.test", "2026-11-14", 1, 5, 3, tree.RootSha256,
            6, Repeat(0x66), "rotate-1", 7, Repeat(0x3a), issued, PublicationCheckpointKind.Daily);
        CheckTranscript(daily, "discontiguous", "58392c7f7f092980e009f199edeb4b0d5ab88d4aed95ed39ff5a1b30a26d3545");
        CheckTranscript(daily with { FromSequence = 0, ToSequence = 0, EntryCount = 0, RootSha256 = PublicationCheckpointTreeV2.EmptyDailyRoot() },
            "empty", "fc7a7138e69120a53ef7222f4f6072c2f945104809e153b6f14b3eb19cfcb096");

        static byte[] Repeat(byte value) => Enumerable.Repeat(value, 32).ToArray();
        void CheckTranscript(PublicationCheckpointV2 value, string fixture, string sha256)
        {
            var payload = value.Payload();
            if (!File.ReadAllBytes(Path.Combine(fixtures, $"publication-daily-checkpoint-{fixture}-v2.txt")).AsSpan().SequenceEqual(payload) ||
                Convert.ToHexStringLower(SHA256.HashData(payload)) != sha256)
                throw new InvalidOperationException("Native daily checkpoint transcript differs from the independent vector.");
        }
    }
}
