import { onUnmounted } from 'vue'
import { useSessionBootstrap } from '@/composables/useSessionBootstrap'

export interface PostAuthUserStore {
  readonly isLoggedIn: boolean
  invalidateGuestCache: () => void
  cancelUserInfoRequest: () => void
}

export interface PostAuthCommitContext {
  userStore: PostAuthUserStore
  ensureAccountSession: (options: { force: boolean; reason: 'runtime' }) => Promise<void>
  markSessionActive: () => void
}

export class PostAuthCommitCoordinator {
  private generation = 0
  private owner: symbol | null = null

  async commit(owner: symbol, context: PostAuthCommitContext): Promise<boolean> {
    const generation = ++this.generation
    this.owner = owner
    context.userStore.invalidateGuestCache()

    await context.ensureAccountSession({ force: true, reason: 'runtime' })
    if (this.owner !== owner || this.generation !== generation) {
      return false
    }

    this.owner = null
    if (!context.userStore.isLoggedIn) {
      return false
    }

    context.markSessionActive()
    return true
  }

  cancel(owner: symbol, context: PostAuthCommitContext): void {
    if (this.owner !== owner) {
      return
    }

    this.owner = null
    this.generation += 1
    context.userStore.cancelUserInfoRequest()
  }
}

const postAuthCommitCoordinator = new PostAuthCommitCoordinator()

export function usePostAuthCommit() {
  const session = useSessionBootstrap()
  const owner = Symbol('post-auth-commit')
  let disposed = false

  const commitPostAuthSession = async (): Promise<boolean> => {
    if (disposed) {
      return false
    }

    const committed = await postAuthCommitCoordinator.commit(owner, session)
    return committed && !disposed
  }

  onUnmounted(() => {
    disposed = true
    postAuthCommitCoordinator.cancel(owner, session)
  })

  return { commitPostAuthSession }
}
