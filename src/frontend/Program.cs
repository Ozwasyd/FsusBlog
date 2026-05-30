using System.Buffers;
using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Shared.Contracts.Models;
using FsusBlog.Core.Mapping.Projectors;

var createTime = new DateTime(2026, 1, 2, 3, 4, 5, DateTimeKind.Utc);

// PodProjector.ProjectArticleDetail (id, views, createTime, categoryId, categoryName, title, summary, content, ...)
// Fix parameter order: Summary comes before Content in projector? Or in CoreModel constructor? Let's check projector source
var detailPod = PodProjector.ProjectArticleDetail(42, 123, createTime, 7, "Life", "Article 42", "Summary 42", "Content 42\nHello", out _);
var detail = new ArticleDetailCoreModel(detailPod, 42, "Article 42", "Content 42\nHello", "Summary 42", "/covers/42.png", 123, 0, 0, false, createTime, new ArticleCategoryCoreModel(7, "Life"), [new TagCoreModel(9, "aeds"), new TagCoreModel(10, "blog")], 0, false);
var payload = new ArrayBufferWriter<byte>();
PodBinaryCodec.WriteArticleDetail(detail, payload);
File.WriteAllText("/tmp/fsus-article-detail-frame.hex", Convert.ToHexString(new AedsEncoder().Encode(AedsFrameType.ArticleDetail, payload.WrittenSpan.ToArray())));

var searchPage = new CorePageResult<ArticleListCoreModel>(
    [
        new ArticleListCoreModel(default, 11, "Intro AEDS", "Binary protocol basics", null, null, 42, new DateTime(2026, 5, 12, 12, 34, 56, DateTimeKind.Utc), new ArticleCategoryCoreModel(3, "Protocol"), [new TagCoreModel(9, "binary"), new TagCoreModel(10, "contract")], false)
    ], 17);
File.WriteAllText("/tmp/fsus-article-search-frame.hex", Convert.ToHexString(new AedsEncoder().Encode(AedsFrameType.ArticleSearch, PodBinaryCodec.EncodeArticlePage(searchPage))));
