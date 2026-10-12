import { buildActivityData, type BuiltActivity } from "./buildActivityData";
import type { SpanRecord, SpanSink, SpanTapConfig } from "./types";

/** In-memory sink for tests and offline/dev capture. */
export class CaptureSink implements SpanSink {
  readonly records: SpanRecord[] = [];

  emit(record: SpanRecord): void {
    this.records.push(record);
  }

  async flush(): Promise<void> {
    // nothing to flush; records are held in memory
  }
}

interface CollectorSink extends SpanSink {
  pending(): BuiltActivity[];
}

/**
 * Default sink: maps each record to its Activity wire shape and delivers it to
 * the injected `O11yService` reporter via `logEventWithSchema`, threading
 * `rootId` as the third arg so a single root_id query joins the whole run
 * (Blocker #1). `flush()` calls `reporter.forceFlush()` to upload buffered
 * events rather than silently dropping them.
 */
export function createCollectorSink(config: SpanTapConfig): CollectorSink {
  const buffered: BuiltActivity[] = [];
  const reporter = config.reporter;
  return {
    emit(record: SpanRecord): void {
      const built = buildActivityData(record);
      buffered.push(built);
      // Deliver immediately to the reporter's SimpleCollector (upload on flush / auto-batch).
      // Pass built.rootId as the third arg so root_id reaches the CoreEnvelope.
      reporter.logEventWithSchema(
        built.data as unknown as Record<string, unknown>,
        built.schema,
        built.rootId,
      );
    },
    pending(): BuiltActivity[] {
      // Return a copy: pending() is a read-only inspection view, so callers can't
      // mutate the internal buffer that flush() later clears.
      return [...buffered];
    },
    async flush(): Promise<void> {
      buffered.length = 0;
      await reporter.forceFlush();
    },
  };
}
