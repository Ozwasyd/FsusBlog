internal static class SitePasskeyNameVectors
{
    internal static void Run(string fixtures)
    {
        const string current = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
        const string other = "a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebf";
        const long revision = 9_007_199_254_740_999;
        var first = new SitePasskeyRow(1800000000123, 1800000000987, true, true, true);
        var second = new SitePasskeyRow(1800000001122, null, false, false, false);
        var firstNamed = new SitePasskeyManagedRow(current, 0, "", first);
        var secondNamed = new SitePasskeyManagedRow(other, revision, "工作钥匙 🐈", second);
        var rename = new SitePasskeyRename(other, revision, " 工位 🔑 ");
        Equal("site-passkey-management", Wire.EncodeSitePasskeyManagement([firstNamed, secondNamed]));
        var intent = Fixture("site-passkey-rename");
        Equal("site-passkey-rename", Wire.EncodeSitePasskeyRename(rename));
        if (Wire.DecodeSitePasskeyRename(intent) != rename)
            throw new InvalidOperationException("Site Passkey rename differs from the independent vector");

        Reject(() => Wire.EncodeSitePasskeyManagement([firstNamed, secondNamed with { Reference = current }]));
        Reject(() => Wire.EncodeSitePasskeyManagement([firstNamed, secondNamed with { Revision = 0 }]));
        Reject(() => Wire.EncodeSitePasskeyManagement([firstNamed, secondNamed with { Name = " 工位" }]));
        Reject(() => Wire.EncodeSitePasskeyManagement([firstNamed, secondNamed with { Name = "键\0" }]));
        Reject(() => Wire.DecodeSitePasskeyRename(intent.AsSpan(0, intent.Length - 1)));
        var body = Aeds.Decode(intent, FrameType.SitePasskeyRename).ToArray();
        Reject(() => Wire.DecodeSitePasskeyRename(Aeds.Encode(FrameType.SitePasskeyRename, [.. body, 0])));
        BinaryPrimitives.WriteInt64LittleEndian(body.AsSpan(WireLimits.SitePasskeyReferenceBytes), -1);
        Reject(() => Wire.DecodeSitePasskeyRename(Aeds.Encode(FrameType.SitePasskeyRename, body)));

        var remove = new SitePasskeyRemove(other, revision);
        var removal = Fixture("site-passkey-remove");
        Equal("site-passkey-remove", Wire.EncodeSitePasskeyRemove(remove));
        if (removal.Length != WireLimits.MaxSitePasskeyRemoveFrameBytes || Wire.DecodeSitePasskeyRemove(removal) != remove)
            throw new InvalidOperationException("Site Passkey removal differs from the independent vector");
        Reject(() => Wire.EncodeSitePasskeyRemove(remove with { Reference = other.ToUpperInvariant() }));
        Reject(() => Wire.EncodeSitePasskeyRemove(remove with { ExpectedRevision = -1 }));
        Reject(() => Wire.DecodeSitePasskeyRemove(intent));
        var target = Aeds.Decode(removal, FrameType.SitePasskeyRemove).ToArray();
        Reject(() => Wire.DecodeSitePasskeyRemove(Aeds.Encode(FrameType.SitePasskeyRemove, target.AsSpan(0, target.Length - 1))));
        Reject(() => Wire.DecodeSitePasskeyRemove(Aeds.Encode(FrameType.SitePasskeyRemove, [.. target, 0])));
        BinaryPrimitives.WriteInt64LittleEndian(target.AsSpan(WireLimits.SitePasskeyReferenceBytes), -1);
        Reject(() => Wire.DecodeSitePasskeyRemove(Aeds.Encode(FrameType.SitePasskeyRemove, target)));

        var original = Wire.EncodeSitePasskeys([first, second]);
        if (!Aeds.Decode(original, FrameType.SitePasskeys).SequenceEqual(Convert.FromHexString(
            "020000007b505c18a3010000db535c18a301000001010162545c18a30100000000000000000000000000")))
            throw new InvalidOperationException("Original Site Passkey list payload changed");

        byte[] Fixture(string name) => VectorFixture.Hex(fixtures, name + ".hex");
        void Equal(string name, byte[] actual) =>
            VectorFixture.Equal(Fixture(name), actual, "Site Passkey AEDS bytes differ from independent vector");
    }

    private static void Reject(Action action) =>
        ProtocolRejection.Assert(action, "Invalid site Passkey data was accepted");
}
