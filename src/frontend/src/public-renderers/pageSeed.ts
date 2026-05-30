import {
  consumePublicAotBootstrap,
} from '@/bootstrap/publicAotBootstrap'
import { readPublicHydrationPayload } from '@/bootstrap/publicHydrationBootstrap'
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
  kind: TKind
): PublicHydrationPayloadFor<TKind> | null {
  const payload = readPublicHydrationPayload()
  if (!payload || payload.pageKind !== kind) {
    return null
  }

  return payload as PublicHydrationPayloadFor<TKind>
}

export function consumePublicPageSeed<TKind extends PublicPageKind & PublicAotBootstrapKind>(
  kind: TKind
): PublicPageSeed<TKind> {
  return {
    bootstrap: consumePublicAotBootstrap(kind),
    hydration: readPublicHydrationSeed(kind)
  }
}
