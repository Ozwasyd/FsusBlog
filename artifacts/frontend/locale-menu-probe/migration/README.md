# Current WIP migration evidence

Related to FsusBlog #1891 and FsusUI #830. This directory contains generated
observations and command logs, not an accepted UX receipt. `binding.json` records
exact commits, run identities, command results and artifact hashes.

The browser tested clean Blog `b8b886fc25e4fc711a6e6a7a9570acb6bbab9276`
with clean FsusUI `d4c9162e34ff002a0a34b491d4aea86d46ec2e4c`.
The final Blog unit run tested the same Blog candidate and upstream source.
Source identities and command artifacts are recorded by binding.json.
Only generated evidence was untracked during the final source-bound run.
The evidence-only follow-up does not change implementation or harness bytes.

Passed observations include public checked state, keyboard entry/navigation,
Enter/Space command activation, Escape from items and pointer-opened triggers,
outside focus preservation, pending/failure/retry/commit composition, URL
activation, three repeated dismissals, disabled/compact and touch pending/outside
flows. All ten locale names appear in the accessibility snapshot. This is a real
DOM/interaction fixture with simulated settlement controls; actual resource and
preference behavior is covered by the separate coordinator unit tests. It is not
production-service browser integration or independent screen-reader acceptance.

The local command exits 2 with **two failed gates**: bilingual content exceeds
its fixed option row, and the narrow CSS-2x fixture has horizontal overflow.
Nine bilingual rows are clipped at both ordinary tested viewport widths. The
375 light and 1440 dark screenshots were visually inspected; labels are visibly
cut. CSS zoom does not qualify as browser zoom. Forced colors/reduced motion and
RTL item/container direction were rendered; no supported RTL locale was invented.

The published command exits 3 before browser startup: locked package 1.5.1 is
unavailable. The earlier `published-install.txt` documents HTTP 401. Public npm
lookup returned 404 and package metadata API access returned 403. No local
package was passed off as published, and no package publishing occurred.

33 Blog unit tests and 36 FsusUI Dropdown tests passed. Five explicitly selected
source/probe files passed lint/style checks, and canonical test-layout checks
passed. Public local export contracts and the isolated LocaleSelector SFC pass
typecheck. The wider app consumer typecheck fails amid incomplete dependencies
and other app errors; no full typecheck is claimed. Full production build exits
1 because both Vite build stages cannot resolve `@tailwindcss/vite` after the
locked dependency install was blocked. Its exact build identity is in build.log.
FsusUI Web typecheck fails with the same two InteractionTraceFixture errors
reproduced on clean main; the baseline and candidate logs remain inspectable.
The intermediate 377d0a88 run introduced a Scrollbar onKeydown typing error; its
negative log is preserved. d4c9162e moves notification to the native DropdownMenu
node and removes that error without touching shared Menu or row geometry.

Implementation-start classifications are frozen scope records from before the
source edits. Their starting baseline identities are historical; they are not
current accepted receipts. Two diagnostic browser runs were interrupted with
exit 143 while investigating an infinite spinner wait. They produced no
completed report and are not acceptance evidence. The final producer waits only
finite transitions and closes its browser/server in `finally`.

#1891 and #830 remain open WIP. Required next inputs are an upstream public
multiline-content contract/variant consistent with closed #449, an accessible
published package identity supporting the new checked contract, and the remaining
qualified product/input/viewport acceptance. Shared row geometry and Menu source
were not modified by this narrow upstream work.
