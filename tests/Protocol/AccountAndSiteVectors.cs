internal static class AccountAndSiteVectors
{
    private const long Hours2 = 7_200_000;
    private const long MaxDate = 8_640_000_000_000_000;

    internal static void Run(string fixtures)
    {
        RunSiteConfig(fixtures);
        RunSitePasskeyNames(fixtures);
        RunPasskeyEnrollment(fixtures);
        RunSubscriptionPreference(fixtures);
        RunAdminSignInHistory(fixtures);
    }

    private static void RunSiteConfig(string fixtures)
    {
        CheckMultilineHex(fixtures, "seo-config-v1.hex", SiteConfigWire.EncodeSeo(new()
        {
            Title = "A️⃣ 公开 · Site", Description = "独立描述 & café\nLine two 🐈", Keywords = "k=α", Author = "Fsu🐈",
            OgImage = "https://cdn.example.test/og.png", BaseUrl = "https://scope.example.test:8443", FaviconSvgUrl = "/assets/site.svg",
            FaviconIcoUrl = "/favicon.ico", FaviconPngUrl = "/fav.png", AppleTouchIconUrl = "/apple.png", ManifestName = "测试清单",
            ManifestShortName = "名字", PwaIcon192Url = "/pwa192.png", PwaIcon512Url = "/pwa512.png", PwaMaskableIconUrl = "/maskable.png",
            ThemeColor = "#112233", BackgroundColor = "#445566", SiteLogoUrl = "/light.svg", SiteLogoDarkUrl = "/dark.svg",
            SiteWordmarkUrl = "/wordmark.svg", AdminLogoUrl = "/backoffice.svg", AdminCollapsedIconUrl = "/compact.svg", LoginLogoUrl = "/login.svg",
            LoginIconUrl = new string('x', 252) + "🧪"
        }));
        CheckMultilineHex(fixtures, "site-compliance-v1.hex", SiteConfigWire.EncodeCompliance(new()
        {
            Enabled = true, RegionMode = "mainland-cn", CopyrightStartYear = 2024, CopyrightOwner = "站点所有者", CopyrightText = "©保留 · 独立\nRésumé 🧭",
            ContentLicenseName = "CC BY 4.0", ContentLicenseUrl = "https://creativecommons.org/licenses/by/4.0/", IcpRecordNumber = "示例ICP备123号",
            IcpRecordUrl = "https://icp.example.test/check", PoliceRecordNumber = "示例网安备012号", PoliceRecordUrl = "https://police.example.test/check",
            PoliceBadgeIconUrl = "/badge.svg", OperatorName = "测试 Operator", ContactEmail = "public@example.test"
        }));
        RejectAll(
            () => SiteConfigWire.EncodeSeo(new() { Title = new string('x', 253) + "🧪" }),
            () => SiteConfigWire.EncodeSeo(new() { Description = new string('x', WireLimits.SiteConfigBlobBytes) + "🙂" }),
            () => SiteConfigWire.EncodeSeo(new() { Keywords = "Null\0padding" }),
            () => SiteConfigWire.EncodeSeo(new() { ManifestShortName = "\ud800" }),
            () => SiteConfigWire.EncodeCompliance(new() { RegionMode = "unknown" }),
            () => SiteConfigWire.EncodeCompliance(new() { CopyrightStartYear = -1 }));
        var compliance = Aeds.Decode(SiteConfigWire.EncodeCompliance(new()), FrameType.SiteComplianceConfig);
        Require(compliance.Length == WireLayouts.SiteComplianceBlobOffset && compliance[0] == 0);
    }

    private static void RunSitePasskeyNames(string fixtures)
    {
        const string current = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
        const string other = "a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebf";
        const long revision = 9_007_199_254_740_999;
        var first = new SitePasskeyRow(1800000000123, 1800000000987, true, true, true);
        var second = new SitePasskeyRow(1800000001122, null, false, false, false);
        var firstNamed = new SitePasskeyManagedRow(current, 0, "", first);
        var secondNamed = new SitePasskeyManagedRow(other, revision, "工作钥匙 🐈", second);
        var rename = new SitePasskeyRename(other, revision, " 工位 🔑 ");
        CheckHex(fixtures, "site-passkey-management.hex", Wire.EncodeSitePasskeyManagement([firstNamed, secondNamed]));
        var intent = Hex(fixtures, "site-passkey-rename.hex");
        CheckRoundTrip(intent, rename, Wire.EncodeSitePasskeyRename, b => Wire.DecodeSitePasskeyRename(b));

        var body = Aeds.Decode(intent, FrameType.SitePasskeyRename).ToArray();
        RejectAll(
            () => Wire.EncodeSitePasskeyManagement([firstNamed, secondNamed with { Reference = current }]),
            () => Wire.EncodeSitePasskeyManagement([firstNamed, secondNamed with { Revision = 0 }]),
            () => Wire.EncodeSitePasskeyManagement([firstNamed, secondNamed with { Name = " 工位" }]),
            () => Wire.EncodeSitePasskeyManagement([firstNamed, secondNamed with { Name = "键\0" }]),
            () => Wire.DecodeSitePasskeyRename(intent.AsSpan(0, intent.Length - 1)),
            () => Wire.DecodeSitePasskeyRename(Aeds.Encode(FrameType.SitePasskeyRename, [.. body, 0])),
            () => Wire.DecodeSitePasskeyRename(Aeds.Encode(FrameType.SitePasskeyRename, WithI64(body, WireLimits.SitePasskeyReferenceBytes, -1))));

        var remove = new SitePasskeyRemove(other, revision);
        var removal = Hex(fixtures, "site-passkey-remove.hex");
        Require(removal.Length == WireLimits.MaxSitePasskeyRemoveFrameBytes);
        CheckRoundTrip(removal, remove, Wire.EncodeSitePasskeyRemove, b => Wire.DecodeSitePasskeyRemove(b));
        var target = Aeds.Decode(removal, FrameType.SitePasskeyRemove).ToArray();
        RejectAll(
            () => Wire.EncodeSitePasskeyRemove(remove with { Reference = other.ToUpperInvariant() }),
            () => Wire.EncodeSitePasskeyRemove(remove with { ExpectedRevision = -1 }),
            () => Wire.DecodeSitePasskeyRemove(intent),
            () => Wire.DecodeSitePasskeyRemove(Aeds.Encode(FrameType.SitePasskeyRemove, target[..^1])),
            () => Wire.DecodeSitePasskeyRemove(Aeds.Encode(FrameType.SitePasskeyRemove, [.. target, 0])),
            () => Wire.DecodeSitePasskeyRemove(Aeds.Encode(FrameType.SitePasskeyRemove, WithI64(target, WireLimits.SitePasskeyReferenceBytes, -1))));

        Equal(HexBytes("020000007b505c18a3010000db535c18a301000001010162545c18a30100000000000000000000000000"),
            Aeds.Decode(Wire.EncodeSitePasskeys([first, second]), FrameType.SitePasskeys));
    }

    private static void RunPasskeyEnrollment(string fixtures)
    {
        var token = new string('Q', 43);
        var user = Enumerable.Range(0, 32).Select(i => (byte)i).ToArray();
        var challenge = Enumerable.Range(160, 32).Select(i => (byte)i).ToArray();
        int[] algorithms = [-7, -257];
        byte[][] excluded = [[0, 255, 123], [12, 11, 10]];
        byte[] Encode(byte[][] ids) => PasskeyWire.EnrollmentBegin(token, 120_000, "example.test", "FsusBlog", "site-account",
            "Primary", user, challenge, algorithms, ids);
        CheckHex(fixtures, "site-passkey-bootstrap.hex", PasskeyWire.ProvisionBegin(token, 120_000, "example.test", "FsusBlog", "site-account",
            "Primary", user, challenge, algorithms));
        CheckHex(fixtures, "site-passkey-enrollment.hex", Encode(excluded));
        RejectEach<byte[][]>(
            [[], [excluded[0], excluded[0].ToArray()], [new byte[WireLimits.PasskeyCredentialIdBytes + 1]],
             Enumerable.Range(0, WireLimits.SitePasskeyListSize).Select(v => new[] { (byte)v }).ToArray()],
            ids => Encode(ids));
        Encode(Enumerable.Range(0, WireLimits.SitePasskeyListSize - 1).Select(v => new[] { (byte)v }).ToArray());

        var adminFlow = Aeds.Decode(PasskeyWire.AuthenticatedAdministrator(), FrameType.AuthLoginFlow);
        Require(adminFlow.Length == WireLayouts.PasskeyAuthLoginFlowSize &&
            BinaryPrimitives.ReadInt32LittleEndian(adminFlow) == 1 &&
            adminFlow[4] == 1 && adminFlow[5] == 0 && adminFlow[6] == 0 && adminFlow[7] == 1 &&
            adminFlow.Slice(8, 13).SequenceEqual("administrator"u8) && !adminFlow[21..].ContainsAnyExcept((byte)0));
    }

    private static void RunSubscriptionPreference(string fixtures)
    {
        var expected = Hex(fixtures, "subscription-preference.hex");
        var preference = new SubscriptionPreferenceRequest("news+brief@example.test", WireLayouts.SubscriptionEmailChannel);
        CheckRoundTrip(expected, preference, Wire.EncodeSubscriptionPreferenceRequest, b => Wire.DecodeSubscriptionPreferenceRequest(b));
        Require(Wire.EncodeSubscriptionPreferenceRequest(preference with { Email = new string('x', WireLimits.SubscriptionEmailBytes) }).Length ==
            WireLimits.MaxSubscriptionPreferenceFrameBytes);

        var pod = Aeds.Decode(expected, FrameType.SubscriptionPreferenceRequest).ToArray();
        static SubscriptionPreferenceRequest Decode(byte[] body) =>
            Wire.DecodeSubscriptionPreferenceRequest(Aeds.Encode(FrameType.SubscriptionPreferenceRequest, body));
        RejectAll(() => Decode(pod[..^1]), () => Decode([.. pod, 0]),
            () => Decode(WithI32(pod, pod.Length - 4, 0)), () => Decode(WithByte(pod, 4, 0xff)));
        RejectEach(["", "whitespace @example.test", "国际@example.test", new string('x', WireLimits.SubscriptionEmailBytes + 1)],
            email => Wire.EncodeSubscriptionPreferenceRequest(preference with { Email = email }));
    }

    private static void RunAdminSignInHistory(string fixtures)
    {
        static AdminSignIn[] Full(int count) => [
            new(1_800_000_000_000, 1_800_000_000_000 + Hours2, 0, AdminSignInState.Current),
            .. Enumerable.Range(1, count - 1).Select(i =>
            {
                var start = 1_700_000_000_000 + i * 10_000_000L;
                return i % 2 == 1
                    ? new AdminSignIn(start, start + Hours2, start + i * 1000L, AdminSignInState.Ended)
                    : new AdminSignIn(start, start + Hours2, start + Hours2, AdminSignInState.Expired);
            }),
        ];
        AdminSignInHistorySnapshot typical = new(9_007_199_254_740_993, [
            new(1_800_000_000_000, 1_800_000_000_000 + Hours2, 0, AdminSignInState.Current),
            new(1_799_990_000_000, 1_799_990_000_000 + Hours2, 1_799_990_000_000, AdminSignInState.Ended),
            new(MaxDate - Hours2, MaxDate, MaxDate, AdminSignInState.Expired),
            new(1_799_980_000_000, 1_799_980_000_000 + Hours2, 1_799_981_234_567, AdminSignInState.Ended),
        ]);
        foreach (var (name, value) in new (string, AdminSignInHistorySnapshot)[]
            { ("admin-sign-in-history.hex", typical), ("admin-sign-in-history-empty.hex", new(1, [])), ("admin-sign-in-history-full.hex", new(2, Full(50))) })
        {
            var expected = Hex(fixtures, name);
            Equal(expected, Wire.EncodeAdminSignInHistorySnapshot(value), name);
            var decoded = Wire.DecodeAdminSignInHistorySnapshot(expected);
            Require(decoded.Generation == value.Generation && decoded.SignIns.SequenceEqual(value.SignIns), name);
        }

        var rows = typical.SignIns;
        AdminSignInHistorySnapshot Edit(int index, AdminSignIn row) =>
            typical with { SignIns = [.. rows.Select((item, at) => at == index ? row : item)] };
        RejectEach([
            typical with { Generation = 0 }, typical with { Generation = -1 }, new AdminSignInHistorySnapshot(2, Full(51)),
            typical with { SignIns = [rows[1], rows[0], rows[2], rows[3]] },
            Edit(1, rows[1] with { EndedAt = 0, State = AdminSignInState.Current }),
            Edit(0, rows[0] with { EndedAt = rows[0].StartedAt }),
            Edit(1, rows[1] with { EndedAt = rows[1].ExpiresAt }), Edit(1, rows[1] with { EndedAt = rows[1].StartedAt - 1 }),
            Edit(1, rows[1] with { EndedAt = 0 }), Edit(2, rows[2] with { EndedAt = rows[2].ExpiresAt - 1 }),
            Edit(2, rows[2] with { EndedAt = 0 }), Edit(3, rows[3] with { ExpiresAt = rows[3].StartedAt }),
            Edit(3, rows[3] with { ExpiresAt = rows[3].StartedAt - 1 }), Edit(1, rows[1] with { StartedAt = 0, EndedAt = 0 }),
            Edit(0, rows[0] with { StartedAt = -1 }), Edit(2, rows[2] with { ExpiresAt = MaxDate + 1, EndedAt = MaxDate + 1 }),
            Edit(1, rows[1] with { State = 0 }), Edit(1, rows[1] with { State = (AdminSignInState)4 }), Edit(1, rows[1] with { State = (AdminSignInState)255 }),
        ], invalid => Wire.EncodeAdminSignInHistorySnapshot(invalid));

        var rejectPayloads = File.ReadAllLines(Path.Combine(fixtures, "admin-sign-in-history-reject.txt"))
            .Where(line => !string.IsNullOrWhiteSpace(line)).ToArray();
        Require(rejectPayloads.Length == 23);
        RejectEach(rejectPayloads, line => Wire.DecodeAdminSignInHistorySnapshot(Aeds.Encode(FrameType.AdminSignInHistory, HexBytes(line.Split(' ', 2)[1].Trim()))));
        var typicalFrame = Hex(fixtures, "admin-sign-in-history.hex");
        RejectTruncations(typicalFrame, span => Wire.DecodeAdminSignInHistorySnapshot(span));
        Reject(() => Wire.DecodeAdminSignInHistorySnapshot(Aeds.Encode(FrameType.AdminSessionSnapshot, Aeds.Decode(typicalFrame, FrameType.AdminSignInHistory))));
    }
}
