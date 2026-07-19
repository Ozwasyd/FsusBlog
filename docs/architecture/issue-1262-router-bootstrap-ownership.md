# Router and FullApp bootstrap ownership

The FullApp bootstrap is the only client composition root for the Vue router
and public-route prewarming. It creates the application router through
`createAppRouter` and injects the public prewarm port explicitly.

`publicRoutePreload.ts` owns only resource preparation:

- critical stylesheet preload;
- route-component chunk preload;
- navigation snapshot validation;
- public route seed and SEO head preparation.

It does not import, load, or start `bootstrap/fullApp.ts`. The Public AOT shell
loads the FullApp chunk first and calls the prewarm entry exported by that
module. This preserves the existing FullApp chunk order, snapshot/seed
semantics, and AOT-to-SPA ownership transition without making resource preload
an application owner.

The router module exports a factory rather than a browser-global singleton.
Production FullApp composition supplies the real prewarm port; unit tests use
Memory History and a fake port. A missing port fails closed to document
navigation and cannot indirectly bootstrap the SPA.

The static public atomic-takeover governance check enforces these import and
composition boundaries.
