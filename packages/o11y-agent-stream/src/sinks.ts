/*
 * Copyright 2026, Salesforce, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

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
 * `rootId` as the third arg so a single root_id query joins the whole run.
 * `flush()` calls `reporter.forceFlush()` to upload buffered
 * events rather than silently dropping them.
 * @param config Tap configuration containing the reporter transport.
 * @returns Sink with emit, flush and a read-only pending-record inspection view.
 * @throws Reporter errors propagate to the caller.
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
      await reporter.forceFlush();
      buffered.length = 0;
    },
  };
}
