# Comment moderation and visibility boundary

`ICommentModerationService` owns the policy and persistence work that follows a
validated comment command:

```text
comment command
  -> ICommentModerationService
       -> region decision and visibility rows
       -> anti-spam score and disposition policy
       -> guarded moderation status update
       -> cache invalidation and removal notification on automatic hide
```

`CommentCommandService` retains transaction ownership for creating a comment and
consuming its anonymous nullifier. Visibility rows are written through the
moderation boundary using the same scoped `ISqlSugarClient`, so they remain in
that transaction. The moderation service never calls back into comment command
or query services.

The extraction does not change endpoint, response, region, or moderation
semantics. A runtime rollback can disable the anti-spam provider or its
automatic disposition policy without restarting; region visibility persistence
continues independently.
