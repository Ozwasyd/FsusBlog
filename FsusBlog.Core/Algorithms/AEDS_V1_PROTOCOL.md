# AEDS v1 Protocol (Little Endian)

## Frame Layout

- Header: 24 bytes
- Payload: raw POD bytes (from `PodBinaryCodec`)

| Offset | Size | Field | Type |
|---|---:|---|---|
| 0 | 4 | Magic | `uint32` (`0x53444541`, bytes: `41 45 44 53`, text: `AEDS`) |
| 4 | 2 | Version | `uint16` |
| 6 | 2 | FrameType | `uint16` |
| 8 | 4 | Flags | `uint32` |
| 12 | 4 | PayloadLength | `uint32` |
| 16 | 4 | HeaderCrc32 | `uint32` |
| 20 | 4 | PayloadCrc32 | `uint32` |

## CRC Rules

- `PayloadCrc32 = CRC32(payload bytes)`
- `HeaderCrc32 = CRC32(header[0..24])` with `HeaderCrc32` field zeroed before calculation.

## FrameType Mapping

- `1`: ArticleList
- `2`: ArticleDetail
- `3`: ArticleHot
- `4`: ArticleSearch
- `5`: CommentArticleCursor
- `6`: CommentUserCursor
- `7`: AdminStats

## Decode Checklist (C++/Wasm)

1. Read 24-byte header.
2. Check `Magic` and `PayloadLength`.
3. Recompute and compare `HeaderCrc32`.
4. Read payload block of `PayloadLength`.
5. Recompute and compare `PayloadCrc32`.
6. Decode payload using corresponding POD schema by `FrameType`.
