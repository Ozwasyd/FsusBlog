// Generated from src/shared/Contracts/Validation/aeds-protocol.json. Run npm run generate:aeds-protocol from src/frontend.
#pragma once
#include <cstddef>
#include <cstdint>
namespace FsusBlog::AedsWire
{
#pragma pack(push, 1)
struct CommentPolicySliceRef { std::int32_t Offset; std::int32_t Length; };
struct CommentPolicySnapshotPod
{
    std::uint8_t AnonymousCommentsEnabled;
    std::uint8_t PublicCommentsEnabled;
    std::uint8_t ZkAnonymousEnabled;
    std::uint8_t DefaultAuthorMode;
    std::uint8_t ZkProdEnabled;
    std::uint8_t ZkProdNativeVerifierConfigured;
    std::uint8_t ZkProdTrustedSetupVerified;
    std::uint8_t ZkProdCredentialRequired;
    std::uint8_t ZkProdCredentialRootReady;
    std::int32_t CommentMaxChars;
    std::int32_t CommentMaxUtf8Bytes;
    CommentPolicySliceRef SupportedDisplayLanguages;
    CommentPolicySliceRef SnapshotHash;
    CommentPolicySliceRef ZkProdUnavailableReason;
};
#pragma pack(pop)
static_assert(sizeof(CommentPolicySnapshotPod) == 41u);
static_assert(offsetof(CommentPolicySnapshotPod, AnonymousCommentsEnabled) == 0u);
static_assert(offsetof(CommentPolicySnapshotPod, PublicCommentsEnabled) == 1u);
static_assert(offsetof(CommentPolicySnapshotPod, ZkAnonymousEnabled) == 2u);
static_assert(offsetof(CommentPolicySnapshotPod, DefaultAuthorMode) == 3u);
static_assert(offsetof(CommentPolicySnapshotPod, ZkProdEnabled) == 4u);
static_assert(offsetof(CommentPolicySnapshotPod, ZkProdNativeVerifierConfigured) == 5u);
static_assert(offsetof(CommentPolicySnapshotPod, ZkProdTrustedSetupVerified) == 6u);
static_assert(offsetof(CommentPolicySnapshotPod, ZkProdCredentialRequired) == 7u);
static_assert(offsetof(CommentPolicySnapshotPod, ZkProdCredentialRootReady) == 8u);
static_assert(offsetof(CommentPolicySnapshotPod, CommentMaxChars) == 9u);
static_assert(offsetof(CommentPolicySnapshotPod, CommentMaxUtf8Bytes) == 13u);
static_assert(offsetof(CommentPolicySnapshotPod, SupportedDisplayLanguages) == 17u);
static_assert(offsetof(CommentPolicySnapshotPod, SnapshotHash) == 25u);
static_assert(offsetof(CommentPolicySnapshotPod, ZkProdUnavailableReason) == 33u);
}
