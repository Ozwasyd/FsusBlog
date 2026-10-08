// Generated from src/shared/Contracts/Validation/aeds-protocol.json. Run npm run generate:aeds-protocol from src/frontend.
#pragma once
#include <cstddef>
#include <cstdint>
namespace FsusBlog::AedsWire
{
#pragma pack(push, 1)
struct CommentCreateSliceRef { std::int32_t Offset; std::int32_t Length; };
struct CommentCreateRequestPod
{
    std::int32_t ArticleId;
    std::uint8_t HasParentId;
    std::uint8_t HasRootId;
    std::uint8_t HasReplyToCommentId;
    std::uint8_t AuthorMode;
    std::uint8_t PublicSendExplicitlySelected;
    std::int64_t ParentId;
    std::int64_t RootId;
    std::int64_t ReplyToCommentId;
    CommentCreateSliceRef AnonymousScope;
    CommentCreateSliceRef DisplayLanguage;
    CommentCreateSliceRef ProofToken;
    CommentCreateSliceRef ZkProof;
    CommentCreateSliceRef Content;
};
#pragma pack(pop)
static_assert(sizeof(CommentCreateRequestPod) == 73u);
static_assert(offsetof(CommentCreateRequestPod, ArticleId) == 0u);
static_assert(offsetof(CommentCreateRequestPod, HasParentId) == 4u);
static_assert(offsetof(CommentCreateRequestPod, HasRootId) == 5u);
static_assert(offsetof(CommentCreateRequestPod, HasReplyToCommentId) == 6u);
static_assert(offsetof(CommentCreateRequestPod, AuthorMode) == 7u);
static_assert(offsetof(CommentCreateRequestPod, PublicSendExplicitlySelected) == 8u);
static_assert(offsetof(CommentCreateRequestPod, ParentId) == 9u);
static_assert(offsetof(CommentCreateRequestPod, RootId) == 17u);
static_assert(offsetof(CommentCreateRequestPod, ReplyToCommentId) == 25u);
static_assert(offsetof(CommentCreateRequestPod, AnonymousScope) == 33u);
static_assert(offsetof(CommentCreateRequestPod, DisplayLanguage) == 41u);
static_assert(offsetof(CommentCreateRequestPod, ProofToken) == 49u);
static_assert(offsetof(CommentCreateRequestPod, ZkProof) == 57u);
static_assert(offsetof(CommentCreateRequestPod, Content) == 65u);
}
