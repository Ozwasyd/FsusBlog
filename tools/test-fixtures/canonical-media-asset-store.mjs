import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const namespacePattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const storageKeyPattern = /^[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)*$/u;

function sha256(value)
{
    return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function stableStringify(value)
{
    if (value === null || typeof value !== 'object')
    {
        return JSON.stringify(value);
    }
    if (Array.isArray(value))
    {
        return `[${value.map(stableStringify).join(',')}]`;
    }
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function contentDigest(value)
{
    const copy = structuredClone(value);
    delete copy.contentDigest;
    return sha256(stableStringify(copy));
}

function assetIdFor(runNamespace, shapeId, ordinal)
{
    const hex = createHash('sha256').update(`${runNamespace}\0${shapeId}\0${ordinal}`).digest('hex').slice(0, 32).split('');
    hex[12] = '5';
    hex[16] = ['8', '9', 'a', 'b'][Number.parseInt(hex[16], 16) % 4];
    return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20).join('')}`;
}

function safeExtension(value)
{
    if (!/^\.[a-z0-9]{2,5}$/u.test(value))
    {
        throw new Error('canonical media asset extension is invalid');
    }
    return value;
}

export class CanonicalMediaAssetStore
{
    #root;
    #runNamespace;
    #ledgerFile;
    #records = new Map();

    constructor({ root, runNamespace })
    {
        if (!namespacePattern.test(runNamespace ?? ''))
        {
            throw new Error('canonical media asset run namespace is invalid');
        }
        const parent = fs.realpathSync(path.dirname(root));
        this.#root = path.resolve(root);
        if (path.dirname(this.#root) !== parent)
        {
            throw new Error('canonical media asset root parent contains a symlink or alias');
        }
        this.#runNamespace = runNamespace;
        if (fs.existsSync(this.#root))
        {
            const stat = fs.lstatSync(this.#root);
            if (!stat.isDirectory() || stat.isSymbolicLink())
            {
                throw new Error('canonical media asset root is not a physical directory');
            }
        }
        else
        {
            fs.mkdirSync(this.#root, { mode: 0o700 });
        }
        this.#ledgerFile = path.join(this.#root, 'ledger.json');
        if (fs.existsSync(this.#ledgerFile))
        {
            this.#loadLedger();
        }
    }

    materialize({ shapeId, extension, bytes, metadata, ordinal = 0 })
    {
        if (!namespacePattern.test(shapeId ?? '') || !Buffer.isBuffer(bytes) || bytes.length === 0)
        {
            throw new Error('canonical media asset input is invalid');
        }
        const assetId = assetIdFor(this.#runNamespace, shapeId, ordinal);
        const storageKey = `fixtures/${this.#runNamespace}/${assetId}${safeExtension(extension)}`;
        if (!storageKeyPattern.test(storageKey) || storageKey.split('/').some((segment) => segment === '.' || segment === '..'))
        {
            throw new Error('canonical media asset storage key is invalid');
        }
        const byteDigest = sha256(bytes);
        const existing = this.#records.get(assetId);
        if (existing)
        {
            if (existing.byteDigest !== byteDigest || existing.storageKey !== storageKey || existing.shapeId !== shapeId)
            {
                throw new Error('canonical media asset idempotent materialization mismatch');
            }
            const file = this.#resolve(storageKey);
            if (!fs.existsSync(file) || sha256(fs.readFileSync(file)) !== byteDigest)
            {
                throw new Error('canonical media asset stored bytes mismatch');
            }
            return { ...existing, status: 'reused' };
        }
        const file = this.#resolve(storageKey);
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        fs.writeFileSync(file, bytes, { mode: 0o600, flag: 'wx' });
        const record = Object.freeze({
            schema: 'fsusblog.canonical-fixture-asset-record.v1',
            assetId,
            shapeId,
            storageClass: 'public',
            storageKey,
            byteDigest,
            byteLength: bytes.length,
            metadata: Object.freeze(structuredClone(metadata)),
            ownerNamespace: this.#runNamespace,
            status: 'created'
        });
        this.#records.set(assetId, record);
        this.#writeLedger();
        return record;
    }

    read(record)
    {
        this.#verifyRecord(record);
        const bytes = fs.readFileSync(this.#resolve(record.storageKey));
        if (sha256(bytes) !== record.byteDigest)
        {
            throw new Error('canonical media asset stored bytes mismatch');
        }
        return bytes;
    }

    cleanup(records)
    {
        const ids = new Set(records.map((item) => item.assetId));
        let deleted = 0;
        for (const id of ids)
        {
            const record = this.#records.get(id);
            if (!record)
            {
                continue;
            }
            this.#verifyRecord(record);
            fs.rmSync(this.#resolve(record.storageKey), { force: true });
            this.#records.delete(id);
            deleted += 1;
        }
        this.#writeLedger();
        return deleted;
    }

    receipt()
    {
        const records = [...this.#records.values()].sort((left, right) => left.assetId.localeCompare(right.assetId));
        const receipt = {
            schema: 'fsusblog.canonical-fixture-asset-store-receipt.v1',
            owner: 'canonical-asset-id-store',
            runNamespace: this.#runNamespace,
            records
        };
        receipt.contentDigest = contentDigest(receipt);
        return receipt;
    }

    #resolve(storageKey)
    {
        if (!storageKeyPattern.test(storageKey) || storageKey.split('/').some((segment) => segment === '.' || segment === '..'))
        {
            throw new Error('canonical media asset storage key is unsafe');
        }
        const resolved = path.resolve(this.#root, ...storageKey.split('/'));
        if (!resolved.startsWith(`${this.#root}${path.sep}`))
        {
            throw new Error('canonical media asset storage key escaped the run root');
        }
        return resolved;
    }

    #verifyRecord(record)
    {
        const owned = this.#records.get(record.assetId);
        if (!owned || owned.ownerNamespace !== this.#runNamespace || owned.storageKey !== record.storageKey || !digestPattern.test(record.byteDigest ?? ''))
        {
            throw new Error('canonical media asset record is not owned by this store');
        }
    }

    #loadLedger()
    {
        const document = JSON.parse(fs.readFileSync(this.#ledgerFile, 'utf8'));
        if (document.schema !== 'fsusblog.canonical-fixture-asset-ledger.v1' || document.runNamespace !== this.#runNamespace || document.contentDigest !== contentDigest(document))
        {
            throw new Error('canonical media asset ledger is invalid');
        }
        for (const record of document.records ?? [])
        {
            if (record.ownerNamespace !== this.#runNamespace
        || !digestPattern.test(record.byteDigest ?? '')
        || !storageKeyPattern.test(record.storageKey ?? '')
        || record.storageKey.split('/').some((segment) => segment === '.' || segment === '..'))
            {
                throw new Error('canonical media asset ledger contains an invalid record');
            }
            record.metadata = Object.freeze(record.metadata);
            this.#records.set(record.assetId, Object.freeze(record));
        }
    }

    #writeLedger()
    {
        const document = {
            schema: 'fsusblog.canonical-fixture-asset-ledger.v1',
            runNamespace: this.#runNamespace,
            records: [...this.#records.values()].sort((left, right) => left.assetId.localeCompare(right.assetId))
        };
        document.contentDigest = contentDigest(document);
        const temporary = `${this.#ledgerFile}.tmp`;
        fs.writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
        fs.renameSync(temporary, this.#ledgerFile);
    }
}
