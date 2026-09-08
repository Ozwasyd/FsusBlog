# Page-Level Title Scale

This document owns FsusBlog page-title hierarchy only. Generic typography, component title geometry, and font tokens belong to the active FsusUI baseline; page profiles and visual focus are defined in [`surface-profiles.md`](surface-profiles.md).

Use the editorial `24/30px` scale: `24px` at a 375px mobile viewport and `30px` from 640px, weight `700`, line-height at least `1.25` on mobile and `1.2` on desktop, with no negative letter-spacing. It applies to public filter pages, account/admin pages, login/registration/recovery, and 403/404. An error code is a supporting `14px` label, not an H1. Keep exactly one semantic H1; separate the title and description by `16px`, then the description and first form/filter/primary action by `24px`. Description text is `14px/400`.

AOT/SSR, hydration, and SPA takeover reuse the same Vue component and `text-2xl sm:text-3xl` geometry; no second first-paint scale exists. Light/Dark changes color roles only. 150% zoom and reduced motion do not change hierarchy, DOM order, or scale. Static gates reject `text-4xl` or larger display utilities, gradient, glow, text-shadow, or multiple H1s on public, auth, and error pages; the account gate fixes `24px` mobile / `30px` desktop.

Article detail has one page-title authority: its header uses `24/30px`, weight `700`, and the loaded weight. Multiline Chinese titles use line-height `1.15` without negative tracking. Markdown H1 inside `article` mode is a left-aligned chapter heading, not a second page title; its typography belongs to [`reading-typography.md`](reading-typography.md). About/document mode, sanitization, and metadata separators are not rewritten by this scale.
