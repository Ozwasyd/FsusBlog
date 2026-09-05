# Small-sample usability test script

## Scope

Each round has 5–8 participants and covers public reading, account messaging, admin authoring, comment moderation, site messaging, and mobile recycle-bin recovery. Record task behavior only; never record article text, passwords, verification codes, or sensitive personal data.

## Tasks

1. Find an article about X.
2. Register or sign in and view messages.
3. Create an article and save a draft.
4. Publish the article and set its SEO summary.
5. Moderate a comment.
6. Reply to a site-message ticket.
7. Recover a recycle-bin article on mobile.

## Recorded items

- Hesitation points
- Misclicks
- Back-navigation count
- Re-reading count
- Locations where the participant asks “What does this mean?”
- Task completion time
- Completion status

## Execution

Write each round's record to `.tmp/ux/usability-findings.json`, then run:

```bash
node tools/ux/validate-usability-findings.mjs
```

`.tmp/` is a local execution directory; do not commit real participant data.
