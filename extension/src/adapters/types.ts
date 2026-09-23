export type CapabilityMatrix = Record<string, boolean | 'partial'>;
export type BrowserAdapter = {
  tabs: {
    query(query?: Record<string, unknown>): Promise<unknown[]>;
    create(url: string): Promise<unknown>;
    remove(tabId: number): Promise<void>;
    update(tabId: number, update: Record<string, unknown>): Promise<unknown>;
    capture(tabId: number): Promise<string>;
  };
  storage: { get(keys?: string[]): Promise<Record<string, unknown>>; set(values: Record<string, unknown>): Promise<void> };
  capabilities(): CapabilityMatrix;
};
