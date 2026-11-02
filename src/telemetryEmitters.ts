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

import type { ProtoEncoderFuncType } from "./types/o11yService.types";

type Drain = () => unknown;
type Send = (binary: Uint8Array) => Promise<Response>;
type FalconConfig = {
  endpoint: string;
  apiKey: string;
};

/** Internal strategy for consuming one shared collector batch. */
interface TelemetryEmitter {
  flush(): Promise<Response | undefined>;
}

class HeadlessTelemetryEmitter implements TelemetryEmitter {
  public constructor(private readonly drain: Drain) {}

  public async flush(): Promise<undefined> {
    try {
      this.drain();
      return undefined;
    } catch (error) {
      console.error(
        "[O11yService][uploadAsNeededAsync] Error draining buffer in headless mode:",
        error,
      );
      throw error;
    }
  }
}

/** Emits base64 envelopes through Core Connect or a configured static Core endpoint. */
class CoreTelemetryEmitter implements TelemetryEmitter {
  public constructor(
    private readonly drain: Drain,
    private readonly encode: ProtoEncoderFuncType,
    private readonly send: Send,
  ) {}

  public async flush(): Promise<Response> {
    return this.send(this.encode(this.drain()));
  }
}

class FalconTelemetryEmitter implements TelemetryEmitter {
  public constructor(
    private readonly drain: Drain,
    private readonly encode: ProtoEncoderFuncType,
    private readonly config: FalconConfig,
  ) {}

  public async flush(): Promise<Response> {
    const binary = this.encode(this.drain());
    const bytes = binary.buffer.slice(
      binary.byteOffset,
      binary.byteOffset + binary.byteLength,
    ) as ArrayBuffer;
    return fetch(this.config.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "x-o11y-api-key": this.config.apiKey,
      },
      body: bytes,
    }).catch((error) => {
      console.error(
        `[O11yService][FalconTelemetryEmitter] Falcon POST FAILED for ${this.displayEndpoint()}:`,
        error instanceof Error ? error.message : error,
      );
      throw error;
    });
  }

  private displayEndpoint(): string {
    try {
      const url = new URL(this.config.endpoint);
      return `${url.protocol}//${url.host}${url.pathname}`;
    } catch {
      return "configured Falcon endpoint";
    }
  }
}

export function createTelemetryEmitter({
  drain,
  encode,
  send,
  falcon,
}: {
  drain: Drain;
  encode?: ProtoEncoderFuncType;
  send?: Send;
  falcon?: FalconConfig;
}): TelemetryEmitter {
  if (falcon && encode) {
    return new FalconTelemetryEmitter(drain, encode, falcon);
  }
  if (!encode || !send) {
    return new HeadlessTelemetryEmitter(drain);
  }
  return new CoreTelemetryEmitter(drain, encode, send);
}
