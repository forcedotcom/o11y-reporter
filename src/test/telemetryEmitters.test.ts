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

import { createTelemetryEmitter } from "../telemetryEmitters";

describe("telemetry emitters", () => {
  test("headless emitter drains and returns undefined", async () => {
    const drain = jest.fn();
    const emitter = createTelemetryEmitter({ drain });

    await expect(emitter.flush()).resolves.toBeUndefined();
    expect(drain).toHaveBeenCalledTimes(1);
  });

  test("headless emitter rejects when drain validation fails", async () => {
    const drain = jest.fn(() => {
      throw new Error("validation drain failed");
    });
    const emitter = createTelemetryEmitter({ drain });
    jest.spyOn(console, "error").mockImplementation(() => {});

    await expect(emitter.flush()).rejects.toThrow("validation drain failed");
    expect(drain).toHaveBeenCalledTimes(1);
  });

  test("Core emitter drains, encodes, and sends", async () => {
    const contents = { events: [] as unknown[] };
    const binary = new Uint8Array([1, 2, 3]);
    const response = { status: 200, ok: true } as Response;
    const drain = jest.fn().mockReturnValue(contents);
    const encode = jest.fn().mockReturnValue(binary);
    const send = jest.fn().mockResolvedValue(response);
    const emitter = createTelemetryEmitter({
      drain,
      encode,
      send,
    });

    await expect(emitter.flush()).resolves.toBe(response);
    expect(drain).toHaveBeenCalledTimes(1);
    expect(encode).toHaveBeenCalledWith(contents);
    expect(send).toHaveBeenCalledWith(binary);
  });

  test("Falcon emitter posts raw bytes with API-key authentication", async () => {
    const binary = new Uint8Array([1, 2, 3]);
    const response = { status: 202, ok: true } as Response;
    const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue(response);
    const emitter = createTelemetryEmitter({
      drain: jest.fn().mockReturnValue({ events: [] }),
      encode: jest.fn().mockReturnValue(binary),
      falcon: {
        endpoint: "https://falcon.example.net/ui-telemetry",
        apiKey: "o11y_pk_test_key",
      },
    });

    await expect(emitter.flush()).resolves.toBe(response);
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://falcon.example.net/ui-telemetry",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "x-o11y-api-key": "o11y_pk_test_key",
        },
      }),
    );
  });

  test("Falcon emitter redacts endpoint credentials and query data on failure", async () => {
    jest.spyOn(global, "fetch").mockRejectedValue(new Error("network failed"));
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const emitter = createTelemetryEmitter({
      drain: jest.fn().mockReturnValue({ events: [] }),
      encode: jest.fn().mockReturnValue(new Uint8Array([1])),
      falcon: {
        endpoint:
          "https://user:password@falcon.example.net/ui-telemetry?token=query-secret",
        apiKey: "o11y_pk_test_key",
      },
    });

    await expect(emitter.flush()).rejects.toThrow("network failed");
    expect(errorSpy).toHaveBeenCalledWith(
      "[O11yService][FalconTelemetryEmitter] Falcon POST FAILED for https://falcon.example.net/ui-telemetry:",
      "network failed",
    );
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("password");
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("query-secret");
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(
      "o11y_pk_test_key",
    );
  });
});
