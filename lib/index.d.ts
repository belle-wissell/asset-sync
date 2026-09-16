export interface SyncSource {
  url: string;
  outputFile: string;
  assets?: { outputFolder: string; fields?: string[] };
}

export interface SyncConfig {
  outputDir: string;
  sources: SyncSource[];
}

export interface SyncProgress {
  /** 1-based index of the source being synced */
  source: number;
  sourceCount: number;
  url: string;
  /** Assets downloaded so far for this source */
  done: number;
  total: number;
  bytes: number;
}

export interface SyncOptions {
  concurrency?: number;
  jsonOnly?: boolean;
  dryRun?: boolean;
  onProgress?: (progress: SyncProgress) => void;
}

export interface SyncResult {
  /** Sources written to disk (in a dry run, every source that would have been) */
  updated: SyncSource[];
  /** Sources left untouched on disk, with what stopped them */
  skipped: {
    source: SyncSource;
    failures: { url: string; error: unknown }[];
  }[];
}

/**
 * Syncs each source's JSON and assets into `config.outputDir`. A source is written only if
 * every one of its assets downloads. Rejects only for an invalid config or an unexpected error.
 */
export function sync(config: SyncConfig, options?: SyncOptions): Promise<SyncResult>;
