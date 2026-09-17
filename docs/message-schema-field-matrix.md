# Message schema field matrix

This matrix is the source of truth for persistence-only message fields. Public
message contracts remain defined by the AEDS response DTOs and do not expose any
of the fields listed below.

| Field | Write path | Read path | AEDS | Migration | Decision |
| --- | --- | --- | --- | --- | --- |
| `MessageCategory` | none | none | absent | none | Removed. Conversation source and sender type already carry the runtime meaning. |
| `ConversationMessage.AttachmentsMeta` | none | none | absent | Legacy split no longer writes `attachmentsmeta` | Removed. Attachments are not a message-center feature. |
| `ConversationParticipantState.Muted` | none | none | absent | Legacy split no longer writes `muted` | Removed. Muting is not a message-center feature. |
| `ConversationMessage.IsInternalNote` | legacy/admin-owned rows only; no new public command | Account queries always require `isinternalnote=false`; admin queries may include the row | absent | Legacy split initializes imported messages to `false` | Retained as a server-only visibility boundary. |
| `MessageConversation.SourceMessageId` | `SendSystemMessageAsync` writes the required `X-Fsus-Source-Event-Id` in the same transaction as the conversation | The same command re-reads it before insert and returns replay/conflict from the request hash | absent | `ux_msg_conversation_source_message` is a filtered unique index | Retained as system-message idempotency identity. |

## Internal-note rules

- Account list/detail pagination excludes internal notes before applying the
  message cursor. An internal row therefore cannot consume an account-visible
  page slot.
- Account read cursors and unread recomputation count only
  `isinternalnote=false` rows. An internal row cannot increase account unread
  state or move its read cursor.
- Admin detail pagination may inspect internal rows. No public or account AEDS
  payload exposes the storage flag itself.
- This cleanup does not add an attachment, mute, or internal-note mutation.

## Idempotency rules

`SourceMessageId` is required only for system-message creation. The write path
holds the mutation advisory lock, checks the existing conversation, compares
the normalized request hash, and either returns the original result or a
conflict. The filtered unique index is the final concurrency guard. Ordinary
account/admin message mutations use their account- or admin-scoped client
mutation identity instead.

## Compatibility and rollback

The historical `20260418-post-messaging-split` descriptor no longer names the
dead `attachmentsmeta` and `muted` columns. Its previous checksum remains
accepted so an already-applied migration is not invalidated. Existing database
columns may remain as inert legacy storage until a separately reviewed contract
window permits physical column removal; current code-first models, runtime
queries, AEDS contracts, and fresh legacy backfills neither create nor use them.
Rollback is code-only: restore the previous application build. No restart-time
feature flag is needed because the public protocol layout is unchanged.
