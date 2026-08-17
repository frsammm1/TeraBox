import { ExpiringCache, type CachedValue } from "./cache.js";
import { type ResolvedShare, TeraBoxClient } from "./terabox.js";

export interface ShareResolver {
  resolve(surl: string, directory?: string): Promise<CachedValue<ResolvedShare>>;
  readonly cacheSize: number;
}

export class CachedShareService implements ShareResolver {
  constructor(
    private readonly client: TeraBoxClient,
    private readonly cache: ExpiringCache<ResolvedShare>,
  ) {}

  get cacheSize(): number {
    return this.cache.size;
  }

  resolve(surl: string, directory?: string): Promise<CachedValue<ResolvedShare>> {
    const normalizedDirectory = directory?.trim() || "";
    const cacheKey = `${surl}\u0000${normalizedDirectory}`;
    return this.cache.getOrLoad(cacheKey, () => this.client.resolve(surl, normalizedDirectory || undefined));
  }
}
