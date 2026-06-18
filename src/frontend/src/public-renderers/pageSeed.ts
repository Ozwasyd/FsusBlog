import {
  consumePublicAotBootstrap,
} from '@/bootstrap/publicAotBootstrap'
import { readPublicHydrationPayload } from '@/bootstrap/publicHydrationBootstrap'
import {
  consumePublicRouteSeed,
  peekPublicRouteSeed,
  type PublicRouteSeedLookup
} from '@/public-renderers/publicRouteSeedStore'
import type { PublicPageKind } from '@/public-renderers/publicRenderBase'
import type {
  PublicAotBootstrapKind,
  PublicAotBootstrapPayloadFor,
  PublicHydrationPayloadFor
} from '@/public-renderers/publicPayloadTypes'

export type PublicPageSeed<TKind extends PublicPageKind> = Readonly<{
  bootstrap: PublicAotBootstrapPayloadFor<TKind & PublicAotBootstrapKind> | null
  hydration: PublicHydrationPayloadFor<TKind> | null
}>

export function readPublicHydrationSeed<TKind extends PublicPageKind>(
  kind: TKind,
  lookup: PublicRouteSeedLookup = {}
): PublicHydrationPayloadFor<TKind> | null {
  const routeSeed = peekPublicRouteSeed(kind as TKind & PublicAotBootstrapKind, lookup)
  if (routeSeed?.hydration) {
    return routeSeed.hydration as PublicHydrationPayloadFor<TKind>
  }

  const payload = readPublicHydrationPayload()
  if (!payload || payload.pageKind !== kind) {
    return null
  }

  return payload as PublicHydrationPayloadFor<TKind>
}

export function consumePublicPageSeed<TKind extends PublicPageKind & PublicAotBootstrapKind>(
  kind: TKind,
  lookup: PublicRouteSeedLookup = {}
): PublicPageSeed<TKind> {
  const routeSeed = consumePublicRouteSeed(kind, lookup)
  if (routeSeed) {
    return routeSeed
  }

  return {
    bootstrap: consumePublicAotBootstrap(kind),
    hydration: readPublicHydrationSeed(kind, lookup)
  }
}
