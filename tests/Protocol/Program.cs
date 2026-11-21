using FsusBlog.V2.Contracts;

string fixtures = args.Length == 1 ? args[0] : throw new ArgumentException("Supply the fixture directory");
byte[] Fixture(string name) => Convert.FromHexString(File.ReadAllText(Path.Combine(fixtures, name)).Trim());

void Equal(ReadOnlySpan<byte> expected, ReadOnlySpan<byte> actual)
{
    if (!expected.SequenceEqual(actual))
        throw new InvalidOperationException("AEDS bytes differ from independent vector");
}

void Reject(Action run) =>
    ProtocolRejection.Assert(run, "Invalid AEDS data accepted");

var error = Fixture("api-error-v1.hex");
Equal(error, Wire.EncodeError(403, "权限不足", "role_required", "trace-123"));
Equal(new byte[] { 1, 0, 0, 0 }, Aeds.Decode(Wire.EncodeEmptySuccess(), FrameType.EmptySuccess));
Equal(Fixture("page-content-v1.hex"), SitePageWire.Encode("about", "# About\n\nHydration-safe binary payload."));
SiteConfigVectors.Run(fixtures);
SitePasskeyNameVectors.Run(fixtures);
PasskeyEnrollmentVectors.Run(fixtures);
SubscriptionPreferenceVectors.Run(fixtures);
AdminSignInHistoryVectors.Run(fixtures);

var command = new ArticleCommand(0, 0, Guid.Parse("00446688-2244-6688-99aa-bbccddeeff00"), "独立向量", "first draft 🐈\n");
var expected = Fixture("article-command.hex");
Equal(expected, Wire.EncodeArticleCommand(command));
if (Wire.DecodeArticleCommand(expected) != command)
    throw new InvalidOperationException("AEDS command differs from independent vector");

foreach (int length in Enumerable.Range(0, expected.Length))
    Reject(() => Wire.DecodeArticleCommand(expected.AsSpan(0, length)));

var changed = expected.ToArray();
for (int offset = 0; offset < changed.Length; offset++)
{
    for (int bit = 0; bit < 8; bit++)
    {
        changed[offset] ^= (byte)(1 << bit);
        Reject(() => Wire.DecodeArticleCommand(changed));
        changed[offset] ^= (byte)(1 << bit);
    }
}

var payload = Aeds.Decode(expected, FrameType.ArticleCommand).ToArray();
payload[32] = 255;
Reject(() => Wire.DecodeArticleCommand(Aeds.Encode(FrameType.ArticleCommand, payload)));
Reject(() => Wire.DecodeArticleCommand(Aeds.Encode(FrameType.ArticleCommand, new byte[36 + WireLimits.BodyBytes + WireLimits.TitleBytes + 1])));
Reject(() => Wire.DecodeArticleCommand(Aeds.Encode(FrameType.ArticleCommand, [.. Aeds.Decode(expected, FrameType.ArticleCommand), 0])));

PublicArticleVectors.Run(fixtures);
PublishedArticleMediaVectors.Run();
Equal(
    Convert.FromHexString(string.Concat(File.ReadAllLines(Path.Combine(fixtures, "pow-challenge-v1.hex")))),
    PowWire.EncodeChallenge(new("salt-value", 4, 1778290000L, "signature-value")));
CommentReadVectors.Run(fixtures);
byte[] CategoryFixture() => Convert.FromHexString(string.Concat(File.ReadAllLines(Path.Combine(fixtures, "category-list-v1.hex"))));
Equal(CategoryFixture(), TaxonomyWire.EncodeList(FrameType.CategoryList, [new(1, "Tech", 2), new(2, "Life", 0)]));
Equal(Fixture("taxonomy-exact-metadata.hex"), TaxonomyWire.EncodeMetadata(new(34, "Étoile", "旧名不可占用")));
var assignment = new TaxonomyAssignment(42, 9_007_199_254_740_993, Guid.Parse("01020304-0506-4040-8080-000000000003"), 3, [101, 105]);
var taxonomyVector = Fixture("taxonomy-assignment.hex");
Equal(taxonomyVector, Wire.EncodeTaxonomyAssignment(assignment));
Equal(taxonomyVector, Wire.EncodeTaxonomyAssignment(Wire.DecodeTaxonomyAssignment(taxonomyVector)));
Reject(() => Wire.EncodeTaxonomyAssignment(assignment with { TagIds = [101, 101] }));
InboxVectors.Run(fixtures);
var canvasVector = Fixture("canvas-link-plan.hex");
var canvasPlan = new CanvasLinkPlan(Guid.Parse("76aff0f0-ba5e-4bd3-ab12-a42d29b9131a"), 3, 8, 12,
    21, 9, 30, "\r\n\r\n[规划 🐝](/article/21)", 1794680000);
Equal(canvasVector, Wire.EncodeCanvasLinkPlan(canvasPlan));
if (Wire.DecodeCanvasLinkPlan(canvasVector) != canvasPlan)
    throw new InvalidOperationException("Canvas plan differs from the independent vector");
Reject(() => Wire.DecodeCanvasConfirm(canvasVector));
var inboxTime = DateTimeOffset.FromUnixTimeMilliseconds(1794659381000);
var inboxEvents = new InboxReplayRecord[]
{
    new(701, 12, 1234567890123456, 9102, inboxTime),
    new(702, 13, 1234567890123456, 9102, inboxTime.AddSeconds(1))
};
Equal(Fixture("inbox-replay.hex"), InboxReplayWire.Encode(702, true, false, inboxEvents));
Reject(() => InboxReplayWire.Encode(703, true, false, inboxEvents));
Reject(() => InboxReplayWire.Encode(702, true, true, inboxEvents));
LocalSearchVectors.Run(fixtures);
PropertyValueVectors.Run(fixtures);
RelatedReadingVectors.Run(fixtures);
NativeArticleCanonicalVectors.Run(fixtures);
NativePublicationProofVectors.Run(fixtures);
var cluster = new AdminClusterStatus(1, "lab-a", Guid.Parse("bd978cbd-7565-44ed-876d-d734cbe45c79"), "2.0.0+ca32",
    1794680000000, 1794680040012, 349, true);
Equal(Fixture("admin-cluster-status-v2.hex"), Wire.EncodeAdminClusterStatus(cluster));
if (Wire.DecodeAdminClusterStatus(Fixture("admin-cluster-status-v2.hex")) != cluster)
    throw new InvalidOperationException("Standalone deployment differs from the independent vector");
Reject(() => Wire.EncodeAdminClusterStatus(cluster with { LeaseAgeMs = 1000 }));
Reject(() => Wire.EncodeAdminClusterStatus(cluster with { NodeId = "lab-a\n" }));
Reject(() => Wire.EncodeAdminClusterStatus(cluster with { Mode = 2 }));
var propertyText = new AuthorTextPropertyTextQuery(new("Orbit", "", null, null, 10, []),
    Guid.Parse("11111111-1111-4111-8111-111111111111"), 3);
var facetSelector = new AuthorTextPropertyFacetSelector(Guid.Parse("aaaaaaaa-aaaa-4aaa-8aaa-000000000007"), 4);
var sortSelector = new AuthorTextPropertySortSelector(Guid.Parse("12345678-1234-4000-9000-123456789abc"), 5,
    AuthorTextPropertySortDirection.Descending);
var qualifiedPropertyText = new AuthorTextPropertyTextQualifiedQuery(propertyText.Search, propertyText.DefinitionId,
    propertyText.DefinitionRevision, facetSelector, sortSelector);
var propertyTextPayload = Convert.FromHexString(
    "050000004f726269740000000000000a0000000000000000000000111111111111411181111111111111110300000000000000");
var qualifiedPropertyPayload = Convert.FromHexString(
    "01aaaaaaaaaaaa4aaa8aaa00000000000704000000000000000112345678123440009000123456789abc050000000000000001");
Equal(propertyTextPayload, Aeds.Decode(Wire.EncodeAuthorTextPropertyTextQuery(propertyText), FrameType.AuthorTextPropertyTextQuery));
var qualifiedPropertyFrame = Aeds.Encode(FrameType.AuthorTextPropertyTextQualifiedQuery, [.. propertyTextPayload, .. qualifiedPropertyPayload]);
Equal(qualifiedPropertyFrame, Wire.EncodeAuthorTextPropertyTextQualifiedQuery(qualifiedPropertyText));
Equal(qualifiedPropertyFrame, Wire.EncodeAuthorTextPropertyTextQualifiedQuery(Wire.DecodeAuthorTextPropertyTextQualifiedQuery(qualifiedPropertyFrame)));
Reject(() => Wire.DecodeAuthorTextPropertyTextQuery(qualifiedPropertyFrame));
Reject(() => Wire.EncodeAuthorTextPropertyTextQualifiedQuery(qualifiedPropertyText with { Facet = null, Sort = null }));
Reject(() => Wire.DecodeAuthorTextPropertyTextQualifiedQuery(Aeds.Encode(FrameType.AuthorTextPropertyTextQualifiedQuery,
    [.. propertyTextPayload, 0, 0])));

var propertySourceDigest = Convert.FromHexString("88c0ad4bb018b4f9fa932dff490c9616d779ca27e05d87a6288d37483d5a0ddd");
var propertyHit = new AuthorTextSearchRow(4, 23, "Harbor", 5, "Orbit", 0, 5, 16_379, 16_384, 49_137, 49_142, propertySourceDigest);
var lexicalPage = new AuthorTextFacetedPage(true, "", 1, [1, 0, 0, 0], false, [], false, [], [propertyHit]);
var facetData = new AuthorTextPropertyFacet(facetSelector.DefinitionId, facetSelector.DefinitionRevision, PropertyFieldKind.Boolean,
    0, 0, 0, [new(new PropertyFieldValue.Boolean(false), 1), new(new PropertyFieldValue.Boolean(true), 0)]);
var lexicalFacetFixture = Convert.FromHexString(
    "0100000000010000000100000000000000000000000000000000000000000000000000010000000400000017" +
    "0000000000000006000000486172626f7205000000050000004f726269740000000005000000fb3f00000040" +
    "0000f1bf0000f6bf000088c0ad4bb018b4f9fa932dff490c9616d779ca27e05d87a6288d37483d5a0ddd" +
    "01aaaaaaaaaaaa4aaa8aaa0000000000070400000000000000020000000000000000000000000000000200000000010000000100000000");
var lexicalFacetFrame = Wire.EncodeAuthorTextPropertyTextQualifiedPage(new(lexicalPage, facetData));
Equal(lexicalFacetFixture, Aeds.Decode(lexicalFacetFrame, FrameType.AuthorTextPropertyTextQualifiedPage));
Equal(lexicalFacetFrame, Wire.EncodeAuthorTextPropertyTextQualifiedPage(Wire.DecodeAuthorTextPropertyTextQualifiedPage(lexicalFacetFrame, true)));
Reject(() => Wire.DecodeAuthorTextPropertyTextQualifiedPage(lexicalFacetFrame, false));
Reject(() => Wire.DecodeAuthorTextPropertySortPage(lexicalFacetFrame));
Reject(() => Wire.EncodeAuthorTextPropertyTextQualifiedPage(new(lexicalPage with { Rows = [propertyHit with { Field = 2 }] }, facetData)));

var mixedPropertyText = new AuthorTextPropertyTextMixedQuery(propertyText.Search, propertyText.DefinitionId,
    propertyText.DefinitionRevision, true, facetSelector, sortSelector);
var mixedPropertyFrame = Aeds.Encode(FrameType.AuthorTextPropertyTextMixedQuery,
    [.. propertyTextPayload, 1, .. qualifiedPropertyPayload]);
Equal(mixedPropertyFrame, Wire.EncodeAuthorTextPropertyTextMixedQuery(mixedPropertyText));
Equal(mixedPropertyFrame, Wire.EncodeAuthorTextPropertyTextMixedQuery(Wire.DecodeAuthorTextPropertyTextMixedQuery(mixedPropertyFrame)));
var noMixedSelectors = Aeds.Encode(FrameType.AuthorTextPropertyTextMixedQuery, [.. propertyTextPayload, 0, 0, 0]);
Equal(noMixedSelectors, Wire.EncodeAuthorTextPropertyTextMixedQuery(mixedPropertyText with { IncludeHeading = false, Facet = null, Sort = null }));
Reject(() => Wire.DecodeAuthorTextPropertyTextMixedQuery(qualifiedPropertyFrame));
Reject(() => Wire.DecodeAuthorTextPropertyTextQualifiedQuery(mixedPropertyFrame));
Reject(() => Wire.DecodeAuthorTextPropertyTextMixedQuery(Aeds.Encode(FrameType.AuthorTextPropertyTextMixedQuery,
    [.. propertyTextPayload, 2, 0, 0])));

var mixedFacetFrame = Wire.EncodeAuthorTextPropertyTextMixedPage(new(lexicalPage, facetData), includeHeading: false);
Equal(lexicalFacetFixture, Aeds.Decode(mixedFacetFrame, FrameType.AuthorTextPropertyTextMixedPage));
Reject(() => Wire.DecodeAuthorTextPropertyTextMixedPage(mixedFacetFrame, includeHeading: false, expectFacet: false));
Reject(() => Wire.DecodeAuthorTextPropertyTextQualifiedPage(mixedFacetFrame, expectFacet: true));
var headingSearchPage = lexicalPage with { Rows = [propertyHit with { Field = 4 }] };
var mixedHeadingFrame = Wire.EncodeAuthorTextPropertyTextMixedPage(new(headingSearchPage, facetData), includeHeading: true);
Reject(() => Wire.EncodeAuthorTextPropertyTextMixedPage(new(headingSearchPage, facetData), includeHeading: false));
Reject(() => Wire.DecodeAuthorTextPropertyTextMixedPage(mixedHeadingFrame, includeHeading: false, expectFacet: true));
Equal(mixedHeadingFrame, Wire.EncodeAuthorTextPropertyTextMixedPage(
    Wire.DecodeAuthorTextPropertyTextMixedPage(mixedHeadingFrame, includeHeading: true, expectFacet: true), includeHeading: true));

Console.WriteLine("AEDS C# vectors and malformed data checks passed");
