import { createAotGenerationObserver } from './aot-generation.mjs';
import { createAuthStateObserver } from './auth-state.mjs';
import { createFileTreeObserver } from './file-tree.mjs';
import { createObjectStorageObserver } from './object-storage.mjs';
import { createPostgresqlObserver, createRedisObserver } from './postgres-redis.mjs';
import { createRuntimeConfigObserver } from './runtime-config.mjs';
import { createRuntimeTopologyObserver } from './runtime-topology.mjs';

/** Exact implementations named by runtime-state-domain-registry observerBindings. */
export function createRuntimeStateObservers()
{
    return Object.freeze([
        createAotGenerationObserver(),
        createAuthStateObserver(),
        createFileTreeObserver(),
        createObjectStorageObserver(),
        createPostgresqlObserver(),
        createRedisObserver(),
        createRuntimeConfigObserver(),
        createRuntimeTopologyObserver()
    ].sort((left, right) => left.observerId.localeCompare(right.observerId)));
}

export {
    createAotGenerationObserver,
    createAuthStateObserver,
    createFileTreeObserver,
    createObjectStorageObserver,
    createPostgresqlObserver,
    createRedisObserver,
    createRuntimeConfigObserver,
    createRuntimeTopologyObserver
};
