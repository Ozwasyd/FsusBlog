/** Authoring Canvas residue verification. Observations must be supplied by actual resource owners. */
export interface LegacyAuditInventoryItem
{
    target: string;
    category: 'storage' | 'nodes' | 'references' | 'graph_isolation' | 'relation_writes';
    status: 'clean' | 'blocked' | 'deleted' | 'unknown';
    description: string;
}
export interface LegacyAuditReceipt
{
    receiptId: string;
    timestamp: string;
    inventory: LegacyAuditInventoryItem[];
    activeResidueCount: number;
    passed: boolean;
}
const REQUIRED_CATEGORIES = ['storage', 'nodes', 'references', 'graph_isolation', 'relation_writes'] as const;
export interface AuthoringCanvasRuntimeObserver
{
    observe(): Promise<LegacyAuditInventoryItem[]>;
}
export class AuthoringCanvasLegacyAuditor
{
    private readonly observer: AuthoringCanvasRuntimeObserver;
    constructor(observer: AuthoringCanvasRuntimeObserver)
    {
        this.observer = observer;
    }
    async scanRuntimeState(): Promise<LegacyAuditReceipt>
    {
        const observed = await this.observer.observe();
        const inventory = structuredClone(observed);
        for (const category of REQUIRED_CATEGORIES)
        {
            if (!inventory.some(item => item.category === category))
            {
                inventory.push({ target: category, category, status: 'unknown',
                    description: 'The resource owner supplied no observation.' });
            }
        }
        const activeResidueCount = inventory.filter(item => item.status !== 'clean' && item.status !== 'deleted').length;
        return { receiptId: crypto.randomUUID(), timestamp: new Date().toISOString(),
            inventory, activeResidueCount, passed: activeResidueCount === 0 };
    }
}
