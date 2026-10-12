import { clearPrivateBrowserState } from '@/services/serviceWorkerRuntime';
import { AppErrorCode, createAppError } from '@/utils/appError';
export type AuthBroadcastEvent =
  | { type: 'login'; at: number; }
  | { type: 'logout'; at: number; }
  | { type: 'expired'; at: number; }
  | { type: 'user-expired'; at: number; }
  | { type: 'admin-logout'; at: number; }
  | { type: 'admin-changed'; at: number; };

export type AuthBroadcastEventOrigin = 'local' | 'remote';
export type AuthBroadcastEventSubscriber = (
    event: AuthBroadcastEvent,
    origin: AuthBroadcastEventOrigin
) => void;

/** Inject the original principal owner's synchronous retirement, never its state. */
export type AdminPrincipalInvalidationHandler = () => void;

interface AdminPrincipalInvalidationBinding {
    readonly invalidate: AdminPrincipalInvalidationHandler;
}

const AUTH_BROADCAST_CHANNEL = 'fsus-auth';
const AUTH_BROADCAST_STORAGE_KEY = 'fsus:auth:broadcast';
const MAX_RECENT_EVENT_KEYS = 64;

type BroadcastChannelConstructor = new (name: string) => BroadcastChannel;

function parseAuthBroadcastEvent(value: unknown): AuthBroadcastEvent | null
{
    if (typeof value !== 'object' || value === null)
    {
        return null;
    }

    const candidate = value as Partial<AuthBroadcastEvent>;
    if ((candidate.type !== 'login'
    && candidate.type !== 'logout'
    && candidate.type !== 'expired'
    && candidate.type !== 'user-expired'
    && candidate.type !== 'admin-logout'
    && candidate.type !== 'admin-changed')
    || typeof candidate.at !== 'number'
    || !Number.isFinite(candidate.at))
    {
        return null;
    }

    // Copy only the public transport contract so untrusted tabs cannot append
    // identity, token, proof or session fields to the subscriber payload.
    return { type: candidate.type, at: candidate.at };
}

function createEvent(type: AuthBroadcastEvent['type']): AuthBroadcastEvent
{
    return {
        type,
        at: Date.now()
    };
}

export class AuthBroadcastRuntime
{
    private channel: BroadcastChannel | null = null;
    private storageListenerInstalled = false;
    private initialized = false;
    private readonly subscribers = new Set<AuthBroadcastEventSubscriber>();
    private readonly recentEventKeys = new Set<string>();
    #adminPrincipalInvalidation: AdminPrincipalInvalidationBinding | null = null;

    registerAdminPrincipalInvalidation(handler: AdminPrincipalInvalidationHandler): () => void
    {
        const binding: AdminPrincipalInvalidationBinding = { invalidate: handler };
        const previous = this.#adminPrincipalInvalidation;
        this.#adminPrincipalInvalidation = binding;
        previous?.invalidate();
        return () =>
        {
            if (this.#adminPrincipalInvalidation !== binding)
            {
                return;
            }
            binding.invalidate();
            if (this.#adminPrincipalInvalidation === binding)
            {
                this.#adminPrincipalInvalidation = null;
            }
        };
    }

    // The optional argument keeps bootstrap call sites transport-agnostic. Store
    // composition is installed separately by authBroadcastComposition.
    init(_bootstrapContext?: unknown): void
    {
        void _bootstrapContext;
        if (typeof window === 'undefined' || this.initialized)
        {
            return;
        }

        this.initialized = true;
        const BroadcastChannelImpl = (window as Window & {
            BroadcastChannel?: BroadcastChannelConstructor;
        }).BroadcastChannel;

        if (typeof BroadcastChannelImpl === 'function')
        {
            this.channel = new BroadcastChannelImpl(AUTH_BROADCAST_CHANNEL);
            this.channel.addEventListener('message', this.handleChannelMessage);
            return;
        }

        window.addEventListener('storage', this.handleStorageEvent);
        this.storageListenerInstalled = true;
    }

    subscribe(subscriber: AuthBroadcastEventSubscriber): () => void
    {
        this.subscribers.add(subscriber);
        return () =>
        {
            this.subscribers.delete(subscriber);
        };
    }

    dispose(): void
    {
        const binding = this.#adminPrincipalInvalidation;
        binding?.invalidate();
        if (this.#adminPrincipalInvalidation !== binding)
        {
            return;
        }
        this.#adminPrincipalInvalidation = null;
        this.channel?.removeEventListener('message', this.handleChannelMessage);
        this.channel?.close();
        this.channel = null;

        if (this.storageListenerInstalled && typeof window !== 'undefined')
        {
            window.removeEventListener('storage', this.handleStorageEvent);
        }
        this.storageListenerInstalled = false;
        this.initialized = false;
        this.recentEventKeys.clear();
        this.subscribers.clear();
    }

    async broadcastLogin(): Promise<void>
    {
        const cleanup = await clearPrivateBrowserState('account-switch');
        if (!cleanup.registeredStorageCleared
      || !cleanup.credentialStateCleared
      || !cleanup.legacyCredentialDatabaseCleared
      || !cleanup.serviceWorkerAcknowledged
      || !cleanup.cacheStorageCleared)
        {
            throw createAppError(AppErrorCode.Validation, 'auth_login_private_state_cleanup_failed');
        }
        this.broadcast(createEvent('login'));
    }

    broadcastLogout(): void
    {
        this.broadcast(createEvent('logout'));
    }

    broadcastExpired(): void
    {
        this.broadcast(createEvent('expired'));
    }

    expireUserSession(): void
    {
        this.broadcast(createEvent('user-expired'));
    }

    broadcastAdminChanged(): void
    {
        // Local transition intent retires prior custody before clock/event
        // allocation, regardless of subscriber order or timestamp collisions.
        this.#adminPrincipalInvalidation?.invalidate();
        this.broadcast(createEvent('admin-changed'));
    }

    broadcastAdminLogout(): void
    {
        this.broadcast(createEvent('admin-logout'));
    }

    private broadcast(event: AuthBroadcastEvent): void
    {
        this.dispatch(event, 'local');
        if (this.channel)
        {
            this.channel.postMessage(event);
            return;
        }

        if (typeof window === 'undefined')
        {
            return;
        }

        try
        {
            window.localStorage.setItem(AUTH_BROADCAST_STORAGE_KEY, JSON.stringify(event));
        }
        catch
        {
            // Ignore storage failures in restricted browser contexts.
        }
    }

    private dispatch(event: AuthBroadcastEvent, origin: AuthBroadcastEventOrigin): void
    {
        const eventKey = `${event.type}:${event.at}`;
        if (this.recentEventKeys.has(eventKey))
        {
            return;
        }

        this.recentEventKeys.add(eventKey);
        while (this.recentEventKeys.size > MAX_RECENT_EVENT_KEYS)
        {
            const oldest = this.recentEventKeys.values().next().value;
            if (oldest === undefined)
            {
                break;
            }
            this.recentEventKeys.delete(oldest);
        }

        if (event.type === 'admin-changed')
        {
            // Remember the original type/time key first, so a reentrant repeat
            // is still suppressed. Local clock evaluation may have reentered
            // the owner, so retire again before every accepted subscriber delivery.
            this.#adminPrincipalInvalidation?.invalidate();
        }

        for (const subscriber of this.subscribers)
        {
            subscriber(event, origin);
        }
    }

    private receive(value: unknown): void
    {
        const event = parseAuthBroadcastEvent(value);
        if (event)
        {
            this.dispatch(event, 'remote');
        }
    }

    private handleChannelMessage = (message: MessageEvent): void =>
    {
        this.receive(message.data);
    };

    private handleStorageEvent = (event: StorageEvent): void =>
    {
        if (event.key !== AUTH_BROADCAST_STORAGE_KEY || !event.newValue)
        {
            return;
        }

        try
        {
            this.receive(JSON.parse(event.newValue) as unknown);
        }
        catch
        {
            // Ignore malformed cross-tab payloads.
        }
    };
}

export const authBroadcastRuntime = new AuthBroadcastRuntime();
