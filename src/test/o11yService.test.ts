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
import { O11yService } from "../../src/o11yService";
import { loadO11yModules } from "../../src/utils/o11yLoader";

jest.mock("../../src/utils/o11yLoader", () => ({
  loadO11yModules: jest.fn(),
}));

describe("O11yService", () => {
  let o11yService: O11yService;

  beforeEach(() => {
    o11yService = O11yService.getInstance("test-extension");
    jest.clearAllMocks();
    // Clear first-writer-wins ownership of the shared upload destination so an owner claimed by
    // a prior test can't leak in and misroute the drain (which routes via the owner instance).
    (O11yService as any).sharedUploadOwner = null;
  });

  test("should return the same instance when getInstance is called multiple times with same extensionId", () => {
    const instance1 = O11yService.getInstance("test-extension");
    const instance2 = O11yService.getInstance("test-extension");
    expect(instance1).toBe(instance2);
  });

  test("should return different instances when getInstance is called with different extensionIds", () => {
    const instance1 = O11yService.getInstance("extension-a");
    const instance2 = O11yService.getInstance("extension-b");
    expect(instance1).not.toBe(instance2);
  });

  test("should initialize correctly", async () => {
    const mockModules = {
      o11yClientVersion: "1.0.0",
      o11ySchemaVersion: "1.0.0",
      a4d_instrumentation: { name: "sf_a4dInstrumentation" },
      getInstrumentation: jest.fn().mockReturnValue({ log: jest.fn() }),
      registerInstrumentedApp: jest.fn().mockReturnValue({
        registerLogCollector: jest.fn(),
        registerMetricsCollector: jest.fn(),
      }),
      ConsoleCollector: jest.fn(),
      simpleCollectorModule: { default: { SimpleCollector: jest.fn() } },
      collectorsModule: {
        default: { encodeCoreEnvelopeContentsRaw: jest.fn() },
      },
    };

    (loadO11yModules as jest.Mock).mockResolvedValue(mockModules);

    await o11yService.initialize("test-extension", "http://test-endpoint");

    expect(o11yService.o11yUploadEndpoint).toBe("http://test-endpoint");
    // Per-CONSUMER instrumentation: getInstrumentation is called with the extensionName so every
    // event carries loggerName = extensionName (distinguishes co-hosted extensions). It is NOT
    // the registered app name.
    expect(mockModules.getInstrumentation).toHaveBeenCalledWith(
      "test-extension",
    );
    // The app is registered exactly once, always under the constant registered name (loggerAppName).
    expect(mockModules.registerInstrumentedApp).toHaveBeenCalledWith(
      "o11y-reporter-extensions",
      expect.anything(),
    );
  });

  test("should handle initialization failure gracefully", async () => {
    // Reset shared resources to ensure initialization actually happens
    (O11yService as any).sharedInstrApp = null;
    (O11yService as any).sharedO11yModules = null;
    (O11yService as any).sharedAppName = null;
    (O11yService as any).sharedResourcesInitPromise = null;
    (O11yService as any).sharedProtoEncoderFunc = null;

    (loadO11yModules as jest.Mock).mockRejectedValue(
      new Error("Failed to load modules"),
    );

    // Should not throw - should complete gracefully without telemetry
    await expect(
      o11yService.initialize("test-extension", "http://test-endpoint"),
    ).resolves.not.toThrow();

    // Verify that telemetry is not available
    expect(o11yService.isInitialized()).toBe(false);
  });

  test("should log events correctly with extension metadata", async () => {
    const logMock = jest.fn();

    // First initialize the service to set extension name and endpoint
    const mockModules = {
      o11yClientVersion: "1.0.0",
      o11ySchemaVersion: "1.0.0",
      a4d_instrumentation: { name: "sf_a4dInstrumentation" },
      getInstrumentation: jest.fn().mockReturnValue({ log: logMock }),
      registerInstrumentedApp: jest.fn().mockReturnValue({
        registerLogCollector: jest.fn(),
        registerMetricsCollector: jest.fn(),
      }),
      ConsoleCollector: jest.fn(),
      simpleCollectorModule: { default: { SimpleCollector: jest.fn() } },
      collectorsModule: {
        default: { encodeCoreEnvelopeContentsRaw: jest.fn() },
      },
    };

    (loadO11yModules as jest.Mock).mockResolvedValue(mockModules);
    await o11yService.initialize("test-extension", "http://test-endpoint");

    o11yService.instrumentation = { log: logMock } as any;
    o11yService.a4dO11ySchema = {};

    o11yService.logEvent({ key: "value" });

    expect(logMock).toHaveBeenCalledWith(
      {},
      {
        message: '{"key":"value"}',
      },
    );
  });

  test("should not log event if instrumentation is not initialized", () => {
    console.error = jest.fn();

    o11yService.instrumentation = undefined as any;
    o11yService.logEvent({ key: "value" });

    expect(console.error).toHaveBeenCalledWith(
      "O11yService: Cannot log event - Service not fully initialized",
    );
  });

  test("should upload data correctly using shared resources", async () => {
    const mockProtoEncoder = jest
      .fn()
      .mockReturnValue(new Uint8Array([1, 2, 3]));
    const mockSimpleCollector = {
      hasData: true,
      estimatedByteSize: 60000,
      getRawContentsOfCoreEnvelope: jest.fn().mockReturnValue({}),
    };

    // Set up all required shared resources to make the service initialized
    (O11yService as any).sharedProtoEncoderFunc = mockProtoEncoder;
    (O11yService as any).sharedInstrApp = {
      simpleCollector: mockSimpleCollector,
    };
    (O11yService as any).sharedO11yModules = { test: "module" };
    o11yService.instrumentation = { log: jest.fn() } as any;

    jest
      .spyOn(o11yService, "uploadViaConnectionOrStaticAsync")
      .mockResolvedValue({} as Response);

    await o11yService.upload();

    expect(mockProtoEncoder).toHaveBeenCalled();
    expect(o11yService.uploadViaConnectionOrStaticAsync).toHaveBeenCalled();
  });

  test("should not upload if simpleCollector has no data", async () => {
    const mockSimpleCollector = { hasData: false };

    (O11yService as any).sharedInstrApp = {
      simpleCollector: mockSimpleCollector,
    };

    await o11yService.upload();

    expect(o11yService.uploadViaConnectionOrStaticAsync).not.toHaveBeenCalled();
  });

  test("should handle missing sharedProtoEncoderFunc during upload", async () => {
    o11yService = O11yService.getInstance("test-extension");

    // Simulating a missing sharedProtoEncoderFunc
    (O11yService as any).sharedProtoEncoderFunc = null;

    // Call upload but expect no rejection (since we now handle missing sharedProtoEncoderFunc safely)
    await expect(o11yService.upload()).resolves.toBeUndefined();
  });

  test("should post request successfully", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ success: true }),
    } as unknown as Response);

    const response = await o11yService.postRequest("http://test-endpoint", {
      key: "value",
    });

    expect(fetch).toHaveBeenCalledWith("http://test-endpoint", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "value" }),
    });

    expect(response.ok).toBe(true);
  });

  test("should handle post request failure", async () => {
    const mockError = new Error("Network Error");
    jest.spyOn(global, "fetch").mockRejectedValue(mockError);
    jest.spyOn(console, "error").mockImplementation(() => {}); // Suppress console output

    await expect(
      o11yService.postRequest("http://test-endpoint", { key: "value" }),
    ).rejects.toThrow("Network Error");

    expect(fetch).toHaveBeenCalledWith("http://test-endpoint", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "value" }),
    });

    expect(console.error).toHaveBeenNthCalledWith(
      1,
      "[O11yService][postRequest] ✗ POST Request FAILED for http://test-endpoint:",
      mockError,
    );
  });

  test("should throw error if o11yUploadEndpoint is undefined", async () => {
    o11yService.o11yUploadEndpoint = undefined;
    jest
      .spyOn(o11yService, "uploadViaConnectionOrStaticAsync")
      .mockRejectedValue(new Error("o11yUploadEndpoint is not defined"));
  });

  test("should share the app but give each consumer its own named instrumentation", async () => {
    (O11yService as any).sharedInstrApp = null;
    (O11yService as any).sharedO11yModules = null;
    (O11yService as any).sharedAppName = null;
    (O11yService as any).sharedResourcesInitPromise = null;
    (O11yService as any).sharedProtoEncoderFunc = null;

    // Return a DISTINCT instrumentation per name so we can assert per-consumer identity
    // (loggerName = extensionName). The o11y client memoizes by name; the mock mirrors that.
    const instrByName = new Map<string, { log: jest.Mock }>();
    const getInstrumentation = jest.fn((name = "") => {
      let instr = instrByName.get(name);
      if (!instr) {
        instr = { log: jest.fn() };
        instrByName.set(name, instr);
      }
      return instr;
    });
    const mockModules = {
      o11yClientVersion: "1.0.0",
      o11ySchemaVersion: "1.0.0",
      a4d_instrumentation: { name: "sf_a4dInstrumentation" },
      getInstrumentation,
      registerInstrumentedApp: jest.fn().mockReturnValue({
        registerLogCollector: jest.fn(),
        registerMetricsCollector: jest.fn(),
      }),
      ConsoleCollector: jest.fn(),
      simpleCollectorModule: { default: { SimpleCollector: jest.fn() } },
      collectorsModule: {
        default: { encodeCoreEnvelopeContentsRaw: jest.fn() },
      },
    };

    (loadO11yModules as jest.Mock).mockResolvedValue(mockModules);

    // Initialize first extension
    const extension1 = O11yService.getInstance("extension-1");
    await extension1.initialize("Extension1", "http://endpoint-1");

    // Initialize second extension
    const extension2 = O11yService.getInstance("extension-2");
    await extension2.initialize("Extension2", "http://endpoint-2");

    // The APP (and thus the process-global buffer) is shared: registered exactly once.
    expect((O11yService as any).sharedInstrApp).toBeDefined();
    expect(mockModules.registerInstrumentedApp).toHaveBeenCalledTimes(1);

    // But each consumer logs through its OWN instrumentation, keyed by extensionName, so
    // every event carries a distinguishing loggerName. They are NOT the same object.
    expect(getInstrumentation).toHaveBeenCalledWith("Extension1");
    expect(getInstrumentation).toHaveBeenCalledWith("Extension2");
    expect(extension1.instrumentation).toBe(instrByName.get("Extension1"));
    expect(extension2.instrumentation).toBe(instrByName.get("Extension2"));
    expect(extension1.instrumentation).not.toBe(extension2.instrumentation);

    // Verify that extension-specific properties are different
    expect(extension1.o11yUploadEndpoint).toBe("http://endpoint-1");
    expect(extension2.o11yUploadEndpoint).toBe("http://endpoint-2");
  });

  test("should only initialize shared resources once", async () => {
    // Reset shared resources to ensure initialization actually happens
    (O11yService as any).sharedInstrApp = null;
    (O11yService as any).sharedO11yModules = null;
    (O11yService as any).sharedAppName = null;
    (O11yService as any).sharedResourcesInitPromise = null;
    (O11yService as any).sharedProtoEncoderFunc = null;

    const mockModules = {
      o11yClientVersion: "1.0.0",
      o11ySchemaVersion: "1.0.0",
      a4d_instrumentation: { name: "sf_a4dInstrumentation" },
      getInstrumentation: jest.fn().mockReturnValue({ log: jest.fn() }),
      registerInstrumentedApp: jest.fn().mockReturnValue({
        registerLogCollector: jest.fn(),
        registerMetricsCollector: jest.fn(),
      }),
      ConsoleCollector: jest.fn(),
      simpleCollectorModule: { default: { SimpleCollector: jest.fn() } },
      collectorsModule: {
        default: { encodeCoreEnvelopeContentsRaw: jest.fn() },
      },
    };

    (loadO11yModules as jest.Mock).mockResolvedValue(mockModules);

    // Initialize first extension
    const extension1 = O11yService.getInstance("extension-1");
    await extension1.initialize("Extension1", "http://endpoint-1");

    // Initialize second extension - should not call loadO11yModules again
    const extension2 = O11yService.getInstance("extension-2");
    await extension2.initialize("Extension2", "http://endpoint-2");

    // loadO11yModules should only be called once
    expect(loadO11yModules).toHaveBeenCalledTimes(1);
    // ...and the app is registered EXACTLY once for the whole process (loggerAppName), even
    // though two extensions initialized. A second registration would throw "already registered".
    expect(mockModules.registerInstrumentedApp).toHaveBeenCalledTimes(1);
    expect(mockModules.registerInstrumentedApp).toHaveBeenCalledWith(
      "o11y-reporter-extensions",
      expect.anything(),
    );
  });

  describe("Application identity (appName / loggerName / loggerAppName)", () => {
    const REGISTERED_APP_NAME = "o11y-reporter-extensions";

    // o11y client constants mirrored from o11y@266.18.0 (client.js). Kept here so the mock below
    // reproduces the real name-handling the service defends against.
    const MAX_INSTRUMENTATION_LENGTH = 80;
    const RESERVED_INSTRUMENTATION_NAMES = [
      "IdleDetector",
      "Network",
      "WebVitals",
    ];

    // Build mock modules whose SimpleCollector records the `environment` it was constructed with,
    // so we can assert the CoreEnvelope appName that reached the shared buffer. getInstrumentation
    // is FAITHFUL to o11y@266.18.0 (not an accept-everything stub): it throws on empty names,
    // SILENTLY truncates names > 80 chars (to 76 + "_CUT"), throws when the registered app name is
    // reused, and pre-seeds the framework-owned instrumentation (IdleDetector/Network/WebVitals) so
    // a test can prove the service never aliases them. It returns a distinct object per name,
    // mirroring the client's per-name memoization, so we can assert per-consumer loggerName identity.
    const buildIdentityMocks = () => {
      const collectorEnvironments: Array<{ appName: string }> = [];
      const instrByName = new Map<string, { log: jest.Mock }>();
      // Framework-owned instrumentation the o11y client creates internally; tagged so a test can
      // assert the service never hands one of these back for a reserved extensionName.
      for (const frameworkName of RESERVED_INSTRUMENTATION_NAMES) {
        instrByName.set(frameworkName, {
          log: jest.fn(),
          __frameworkOwned: frameworkName,
        } as unknown as { log: jest.Mock });
      }
      const registerInstrumentedApp = jest.fn().mockReturnValue({
        registerLogCollector: jest.fn(),
        registerMetricsCollector: jest.fn(),
      });
      const getInstrumentation = jest.fn((name?: string) => {
        // requireArgument: empty/undefined/null name throws in the real client.
        if (name === undefined || name === null || name === "") {
          throw new Error(
            "name argument is required and must be of a supported type.",
          );
        }
        // Names longer than the limit are SILENTLY truncated (76 chars + "_CUT"), which would
        // change the encoded loggerName out from under the caller.
        let key = name;
        if (key.length > MAX_INSTRUMENTATION_LENGTH) {
          key = key.substring(0, MAX_INSTRUMENTATION_LENGTH - 4) + "_CUT";
        }
        // Reusing the registered app name collides with the shared app's own instrumentation.
        if (key === REGISTERED_APP_NAME) {
          throw new Error(
            `The instrumentation name ${key} is being used by the app.`,
          );
        }
        let instr = instrByName.get(key);
        if (!instr) {
          instr = { log: jest.fn() };
          instrByName.set(key, instr);
        }
        return instr;
      });
      const SimpleCollector = jest
        .fn()
        .mockImplementation((config: { environment: { appName: string } }) => {
          collectorEnvironments.push(config.environment);
          return {
            hasData: false,
            estimatedByteSize: 0,
            getRawContentsOfCoreEnvelope: jest.fn(),
          };
        });
      const modules = {
        o11yClientVersion: "1.0.0",
        o11ySchemaVersion: "1.0.0",
        a4d_instrumentation: { name: "sf_a4dInstrumentation" },
        getInstrumentation,
        registerInstrumentedApp,
        ConsoleCollector: jest.fn(),
        simpleCollectorModule: { default: { SimpleCollector } },
        collectorsModule: {
          default: { encodeCoreEnvelopeContentsRaw: jest.fn() },
        },
      };
      return { modules, collectorEnvironments, instrByName };
    };

    // Fully reset the process-global shared state so each test drives a fresh first-writer-wins.
    const resetShared = () => {
      (O11yService as any).sharedInstrApp = null;
      (O11yService as any).sharedO11yModules = null;
      (O11yService as any).sharedAppName = null;
      (O11yService as any).sharedResourcesInitPromise = null;
      (O11yService as any).sharedProtoEncoderFunc = null;
      (O11yService as any).sharedUploadOwner = null;
    };

    test("defaults the CoreEnvelope appName to the registered app name when appName is omitted", async () => {
      resetShared();
      const { modules, collectorEnvironments } = buildIdentityMocks();
      (loadO11yModules as jest.Mock).mockResolvedValue(modules);

      const svc = O11yService.getInstance("id-default-appname");
      await svc.initialize("my-extension", "http://endpoint");

      expect(collectorEnvironments).toHaveLength(1);
      expect(collectorEnvironments[0].appName).toBe(REGISTERED_APP_NAME);
      expect((O11yService as any).sharedAppName).toBe(REGISTERED_APP_NAME);
      // The read-only mirror reflects the effective identity across all three surfaces.
      expect(svc.environment.appName).toBe(REGISTERED_APP_NAME);
      expect(svc.environment.loggerName).toBe("my-extension");
      expect(svc.environment.loggerAppName).toBe(REGISTERED_APP_NAME);
    });

    test("uses a custom process-level appName for the CoreEnvelope when provided", async () => {
      resetShared();
      const { modules, collectorEnvironments } = buildIdentityMocks();
      (loadO11yModules as jest.Mock).mockResolvedValue(modules);

      const svc = O11yService.getInstance("id-custom-appname");
      await svc.initialize("my-extension", "http://endpoint", undefined, {
        appName: "salesforce-extension-pack",
      });

      expect(collectorEnvironments[0].appName).toBe(
        "salesforce-extension-pack",
      );
      expect((O11yService as any).sharedAppName).toBe(
        "salesforce-extension-pack",
      );
      // appName is the PROCESS label; per-consumer identity still rides on loggerName.
      expect(modules.getInstrumentation).toHaveBeenCalledWith("my-extension");
      expect(svc.environment.appName).toBe("salesforce-extension-pack");
      expect(svc.environment.loggerName).toBe("my-extension");
      // The registered app name (loggerAppName) is unaffected by a custom appName.
      expect(modules.registerInstrumentedApp).toHaveBeenCalledWith(
        REGISTERED_APP_NAME,
        expect.anything(),
      );
    });

    test("resolves the process appName first-writer-wins and ignores a later different appName", async () => {
      resetShared();
      const { modules, collectorEnvironments } = buildIdentityMocks();
      (loadO11yModules as jest.Mock).mockResolvedValue(modules);
      const errorSpy = jest
        .spyOn(console, "error")
        .mockImplementation(() => {});

      const first = O11yService.getInstance("id-fww-1");
      await first.initialize("ext-one", "http://endpoint-1", undefined, {
        appName: "first-app",
      });

      const second = O11yService.getInstance("id-fww-2");
      await second.initialize("ext-two", "http://endpoint-2", undefined, {
        appName: "second-app",
      });

      // Only the FIRST initializer's appName was used to build the (single) shared buffer.
      expect(collectorEnvironments).toHaveLength(1);
      expect(collectorEnvironments[0].appName).toBe("first-app");
      expect((O11yService as any).sharedAppName).toBe("first-app");
      // The conflicting later appName is logged and ignored.
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Conflicting telemetry appName"),
      );
      errorSpy.mockRestore();
    });

    test("does not log a conflict when a later init omits appName or repeats the winning one", async () => {
      resetShared();
      const { modules } = buildIdentityMocks();
      (loadO11yModules as jest.Mock).mockResolvedValue(modules);

      const first = O11yService.getInstance("id-noconflict-1");
      await first.initialize("ext-one", "http://endpoint-1", undefined, {
        appName: "shared-app",
      });

      const errorSpy = jest
        .spyOn(console, "error")
        .mockImplementation(() => {});

      // Later inits: one omits appName (-> default is NOT the winner, but omission must be silent),
      // one repeats the winning value. Neither should log an appName conflict.
      const second = O11yService.getInstance("id-noconflict-2");
      await second.initialize("ext-two", "http://endpoint-2", undefined, {
        appName: "shared-app",
      });
      const third = O11yService.getInstance("id-noconflict-3");
      await third.initialize("ext-three", "http://endpoint-3");

      const appNameConflicts = errorSpy.mock.calls.filter(
        (args) =>
          typeof args[0] === "string" &&
          args[0].includes("Conflicting telemetry appName"),
      );
      expect(appNameConflicts).toHaveLength(0);
      errorSpy.mockRestore();
    });

    test("gives co-hosted consumers distinct per-event loggerName via their own instrumentation", async () => {
      resetShared();
      const { modules, instrByName } = buildIdentityMocks();
      (loadO11yModules as jest.Mock).mockResolvedValue(modules);

      // Three extensions co-hosted in one process (e.g. the VS Code Extension Pack).
      const core = O11yService.getInstance("id-core");
      await core.initialize(
        "salesforcedx-vscode-core",
        "http://endpoint",
        undefined,
        {
          appName: "salesforce-extension-pack",
        },
      );
      const apex = O11yService.getInstance("id-apex");
      await apex.initialize("salesforcedx-vscode-apex", "http://endpoint");
      const lwc = O11yService.getInstance("id-lwc");
      await lwc.initialize("salesforcedx-vscode-lwc", "http://endpoint");

      // One shared app; three distinct named instrumentations (one per extensionName).
      expect(modules.registerInstrumentedApp).toHaveBeenCalledTimes(1);
      expect(core.instrumentation).toBe(
        instrByName.get("salesforcedx-vscode-core"),
      );
      expect(apex.instrumentation).toBe(
        instrByName.get("salesforcedx-vscode-apex"),
      );
      expect(lwc.instrumentation).toBe(
        instrByName.get("salesforcedx-vscode-lwc"),
      );
      expect(core.instrumentation).not.toBe(apex.instrumentation);
      expect(apex.instrumentation).not.toBe(lwc.instrumentation);
      // All share one process appName; each keeps its own loggerName.
      expect(core.environment.appName).toBe("salesforce-extension-pack");
      expect(apex.environment.appName).toBe("salesforce-extension-pack");
      expect(core.environment.loggerName).toBe("salesforcedx-vscode-core");
      expect(apex.environment.loggerName).toBe("salesforcedx-vscode-apex");
      expect(lwc.environment.loggerName).toBe("salesforcedx-vscode-lwc");
    });

    test("flags reuse: re-initializing one instance with a different extensionName re-binds loggerName", async () => {
      resetShared();
      const { modules, instrByName } = buildIdentityMocks();
      (loadO11yModules as jest.Mock).mockResolvedValue(modules);
      const errorSpy = jest
        .spyOn(console, "error")
        .mockImplementation(() => {});

      // Anti-pattern: ONE instance reused as two consumers via a second initialize().
      const shared = O11yService.getInstance("id-reused");
      await shared.initialize("ext-first", "http://endpoint");
      expect(shared.instrumentation).toBe(instrByName.get("ext-first"));

      await shared.initialize("ext-second", "http://endpoint");

      // The footgun is flagged...
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          'a different extensionName ("ext-first" -> "ext-second")',
        ),
      );
      // ...and (last-writer, non-fatal) the per-event identity is now re-bound to the last name.
      expect(shared.instrumentation).toBe(instrByName.get("ext-second"));
      expect(shared.environment.loggerName).toBe("ext-second");
      errorSpy.mockRestore();
    });

    test("does not flag idempotent re-init with the SAME extensionName", async () => {
      resetShared();
      const { modules } = buildIdentityMocks();
      (loadO11yModules as jest.Mock).mockResolvedValue(modules);

      const svc = O11yService.getInstance("id-idempotent");
      await svc.initialize("ext-same", "http://endpoint");

      const errorSpy = jest
        .spyOn(console, "error")
        .mockImplementation(() => {});
      await svc.initialize("ext-same", "http://endpoint");

      const reuseWarnings = errorSpy.mock.calls.filter(
        (args) =>
          typeof args[0] === "string" &&
          args[0].includes("a different extensionName"),
      );
      expect(reuseWarnings).toHaveLength(0);
      errorSpy.mockRestore();
    });

    describe("identity input validation (rejected init claims no shared state)", () => {
      // Assert that a rejected initialize() left the service uninitialized AND did not claim any
      // process-global identity/ownership. This is the core guarantee of Marty's review: an invalid
      // FIRST caller must not determine shared state for everyone else.
      const expectNoSharedStateClaimed = (svc: O11yService) => {
        expect(svc.isInitialized()).toBe(false);
        expect(svc.instrumentation).toBeUndefined();
        expect((O11yService as any).sharedInstrApp).toBeNull();
        expect((O11yService as any).sharedAppName).toBeNull();
        expect((O11yService as any).sharedUploadOwner).toBeNull();
        // The read-only identity mirror must not have been populated either.
        expect(svc.environment.appName).toBeUndefined();
        expect(svc.environment.loggerName).toBeUndefined();
      };

      // 76 "a"s + "_CUT" == 80 chars, so getInstrumentation truncation is NOT triggered; but an
      // 81-char name WOULD be silently truncated by the client -> must be rejected up front.
      const NAME_80 = "a".repeat(80);
      const NAME_81 = "a".repeat(81);

      const invalidExtensionNames: Array<[string, string]> = [
        ["empty string", ""],
        ["whitespace-only", "   "],
        ["leading whitespace", " leading"],
        ["trailing whitespace", "trailing "],
        ["contains a backtick", "ext`name"],
        ["exceeds 80 characters (would be silently truncated)", NAME_81],
        ["equals the registered app name", REGISTERED_APP_NAME],
        ["reserved o11y name IdleDetector", "IdleDetector"],
        ["reserved o11y name Network", "Network"],
        ["reserved o11y name WebVitals", "WebVitals"],
      ];

      test.each(invalidExtensionNames)(
        "rejects extensionName (%s) and does not initialize or claim shared state",
        async (_label, badName) => {
          resetShared();
          const { modules, collectorEnvironments } = buildIdentityMocks();
          (loadO11yModules as jest.Mock).mockResolvedValue(modules);
          const errorSpy = jest
            .spyOn(console, "error")
            .mockImplementation(() => {});

          const svc = O11yService.getInstance(`id-invalid-${_label}`);
          await expect(
            svc.initialize(badName, "http://endpoint"),
          ).resolves.toBeUndefined();

          expect(errorSpy).toHaveBeenCalledWith(
            expect.stringContaining("Invalid extensionName"),
          );
          // Shared resources were never even loaded — validation short-circuits before that.
          expect(loadO11yModules).not.toHaveBeenCalled();
          expect(modules.registerInstrumentedApp).not.toHaveBeenCalled();
          expect(modules.getInstrumentation).not.toHaveBeenCalled();
          expect(collectorEnvironments).toHaveLength(0);
          expectNoSharedStateClaimed(svc);
          errorSpy.mockRestore();
        },
      );

      test("accepts an 80-character extensionName exactly (boundary, not truncated)", async () => {
        resetShared();
        const { modules } = buildIdentityMocks();
        (loadO11yModules as jest.Mock).mockResolvedValue(modules);

        const svc = O11yService.getInstance("id-boundary-80");
        await svc.initialize(NAME_80, "http://endpoint");

        expect(svc.isInitialized()).toBe(true);
        // Preserved EXACTLY: instrumentation name === extensionName === loggerName (no "_CUT").
        expect(modules.getInstrumentation).toHaveBeenCalledWith(NAME_80);
        expect(svc.environment.loggerName).toBe(NAME_80);
      });

      test("preserves a valid extensionName exactly (no prefixing/hashing/trimming)", async () => {
        resetShared();
        const { modules } = buildIdentityMocks();
        (loadO11yModules as jest.Mock).mockResolvedValue(modules);

        const svc = O11yService.getInstance("id-preserve-exact");
        await svc.initialize("salesforcedx-vscode-core", "http://endpoint");

        expect(modules.getInstrumentation).toHaveBeenCalledWith(
          "salesforcedx-vscode-core",
        );
        expect(svc.environment.loggerName).toBe("salesforcedx-vscode-core");
      });

      const invalidAppNames: Array<[string, string]> = [
        ["empty string", ""],
        ["whitespace-only", "   "],
        ["tab/newline only", "\t\n"],
      ];

      test.each(invalidAppNames)(
        "rejects a blank appName (%s) and does not create the shared collector or claim identity",
        async (_label, badAppName) => {
          resetShared();
          const { modules, collectorEnvironments } = buildIdentityMocks();
          (loadO11yModules as jest.Mock).mockResolvedValue(modules);
          const errorSpy = jest
            .spyOn(console, "error")
            .mockImplementation(() => {});

          const svc = O11yService.getInstance(`id-bad-appname-${_label}`);
          await expect(
            svc.initialize("valid-ext", "http://endpoint", undefined, {
              appName: badAppName,
            }),
          ).resolves.toBeUndefined();

          expect(errorSpy).toHaveBeenCalledWith(
            expect.stringContaining("Invalid appName"),
          );
          // No shared collector was constructed with the blank appName, and no identity was claimed.
          expect(collectorEnvironments).toHaveLength(0);
          expect((O11yService as any).sharedAppName).toBeNull();
          expectNoSharedStateClaimed(svc);
          errorSpy.mockRestore();
        },
      );

      test("still accepts a valid non-blank appName", async () => {
        resetShared();
        const { modules, collectorEnvironments } = buildIdentityMocks();
        (loadO11yModules as jest.Mock).mockResolvedValue(modules);

        const svc = O11yService.getInstance("id-valid-appname");
        await svc.initialize("valid-ext", "http://endpoint", undefined, {
          appName: "salesforce-extension-pack",
        });

        expect(svc.isInitialized()).toBe(true);
        expect(collectorEnvironments[0].appName).toBe(
          "salesforce-extension-pack",
        );
        expect((O11yService as any).sharedAppName).toBe(
          "salesforce-extension-pack",
        );
      });

      test("an invalid FIRST caller does not poison shared state for a later valid caller", async () => {
        resetShared();
        const { modules, instrByName } = buildIdentityMocks();
        (loadO11yModules as jest.Mock).mockResolvedValue(modules);
        const errorSpy = jest
          .spyOn(console, "error")
          .mockImplementation(() => {});

        // First caller is invalid (reserved name) -> rejected, claims nothing.
        const bad = O11yService.getInstance("id-poison-bad");
        await bad.initialize("Network", "http://endpoint");
        expect((O11yService as any).sharedInstrApp).toBeNull();
        expect((O11yService as any).sharedAppName).toBeNull();

        // A subsequent VALID caller initializes cleanly and becomes the first writer.
        const good = O11yService.getInstance("id-poison-good");
        await good.initialize(
          "salesforcedx-vscode-core",
          "http://endpoint",
          undefined,
          {
            appName: "salesforce-extension-pack",
          },
        );

        expect(good.isInitialized()).toBe(true);
        expect(modules.registerInstrumentedApp).toHaveBeenCalledTimes(1);
        expect((O11yService as any).sharedAppName).toBe(
          "salesforce-extension-pack",
        );
        expect((O11yService as any).sharedUploadOwner).toBe(good);
        expect(good.environment.loggerName).toBe("salesforcedx-vscode-core");
        // The reserved framework instrumentation was never handed out to a consumer.
        expect(good.instrumentation).toBe(
          instrByName.get("salesforcedx-vscode-core"),
        );
        expect(good.instrumentation).not.toBe(instrByName.get("Network"));
        errorSpy.mockRestore();
      });

      test("fails closed (no telemetry, no throw) if getInstrumentation throws despite validation", async () => {
        // Defense in depth: even for a name that passes our validation, a future o11y client could
        // throw from getInstrumentation. initialize() must swallow it and leave the service
        // uninitialized rather than let the exception escape into the host application.
        resetShared();
        const { modules } = buildIdentityMocks();
        modules.getInstrumentation = jest.fn(() => {
          throw new Error("simulated client-side rejection");
        });
        (loadO11yModules as jest.Mock).mockResolvedValue(modules);
        const errorSpy = jest
          .spyOn(console, "error")
          .mockImplementation(() => {});

        const svc = O11yService.getInstance("id-getinstr-throws");
        await expect(
          svc.initialize("valid-ext", "http://endpoint"),
        ).resolves.toBeUndefined();

        expect(svc.isInitialized()).toBe(false);
        expect(svc.instrumentation).toBeUndefined();
        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining('getInstrumentation("valid-ext") failed'),
          expect.anything(),
        );
        errorSpy.mockRestore();
      });
    });
  });

  test("should log events with custom schema using logEventWithSchema", async () => {
    const logMock = jest.fn();
    const customSchema = { name: "sf_customSchema", version: "1.0.0" };

    const mockModules = {
      o11yClientVersion: "1.0.0",
      o11ySchemaVersion: "1.0.0",
      a4d_instrumentation: { name: "sf_a4dInstrumentation" },
      getInstrumentation: jest.fn().mockReturnValue({ log: logMock }),
      registerInstrumentedApp: jest.fn().mockReturnValue({
        registerLogCollector: jest.fn(),
        registerMetricsCollector: jest.fn(),
      }),
      ConsoleCollector: jest.fn(),
      simpleCollectorModule: { default: { SimpleCollector: jest.fn() } },
      collectorsModule: {
        default: { encodeCoreEnvelopeContentsRaw: jest.fn() },
      },
    };

    (loadO11yModules as jest.Mock).mockResolvedValue(mockModules);
    await o11yService.initialize("test-extension", "http://test-endpoint");

    // Manually set instrumentation for testing
    o11yService.instrumentation = { log: logMock } as any;

    o11yService.logEventWithSchema({ event: "customEvent" }, customSchema);

    // Should pass schema and properties directly (no message wrapper)
    expect(logMock).toHaveBeenCalledWith(customSchema, {
      event: "customEvent",
    });
  });

  test("should not log event with logEventWithSchema if schema is null", async () => {
    const logMock = jest.fn();

    const mockModules = {
      o11yClientVersion: "1.0.0",
      o11ySchemaVersion: "1.0.0",
      a4d_instrumentation: { name: "sf_a4dInstrumentation" },
      getInstrumentation: jest.fn().mockReturnValue({ log: logMock }),
      registerInstrumentedApp: jest.fn().mockReturnValue({
        registerLogCollector: jest.fn(),
        registerMetricsCollector: jest.fn(),
      }),
      ConsoleCollector: jest.fn(),
      simpleCollectorModule: { default: { SimpleCollector: jest.fn() } },
      collectorsModule: {
        default: { encodeCoreEnvelopeContentsRaw: jest.fn() },
      },
    };

    (loadO11yModules as jest.Mock).mockResolvedValue(mockModules);
    await o11yService.initialize("test-extension", "http://test-endpoint");

    o11yService.logEventWithSchema({ event: "test" }, null as any);

    // Should not log when schema is null
    expect(logMock).not.toHaveBeenCalled();
  });

  test("should use default schema with logEvent and custom schema with logEventWithSchema", async () => {
    const logMock = jest.fn();
    const customSchema = { name: "sf_customSchema" };
    const defaultSchema = { name: "sf_a4dInstrumentation" };

    const mockModules = {
      o11yClientVersion: "1.0.0",
      o11ySchemaVersion: "1.0.0",
      a4d_instrumentation: defaultSchema,
      getInstrumentation: jest.fn().mockReturnValue({ log: logMock }),
      registerInstrumentedApp: jest.fn().mockReturnValue({
        registerLogCollector: jest.fn(),
        registerMetricsCollector: jest.fn(),
      }),
      ConsoleCollector: jest.fn(),
      simpleCollectorModule: { default: { SimpleCollector: jest.fn() } },
      collectorsModule: {
        default: { encodeCoreEnvelopeContentsRaw: jest.fn() },
      },
    };

    (loadO11yModules as jest.Mock).mockResolvedValue(mockModules);
    await o11yService.initialize("test-extension", "http://test-endpoint");

    // Manually set instrumentation for testing
    o11yService.instrumentation = { log: logMock } as any;
    o11yService.a4dO11ySchema = defaultSchema;

    // Log with default schema
    o11yService.logEvent({ event: "defaultEvent" });
    expect(logMock).toHaveBeenCalledWith(defaultSchema, {
      message: JSON.stringify({ event: "defaultEvent" }),
    });

    // Log with custom schema (properties passed directly, no message wrapper)
    o11yService.logEventWithSchema({ event: "customEvent" }, customSchema);
    expect(logMock).toHaveBeenCalledWith(customSchema, {
      event: "customEvent",
    });
  });

  describe("Batching and Flush Mechanism", () => {
    beforeEach(() => {
      // Set up required shared resources for batching tests
      (o11yService as any).headlessMode = false;
      const mockProtoEncoder = jest
        .fn()
        .mockReturnValue(new Uint8Array([1, 2, 3]));
      const mockSimpleCollector = {
        hasData: true,
        estimatedByteSize: 10000,
        getRawContentsOfCoreEnvelope: jest.fn().mockReturnValue({}),
      };

      (O11yService as any).sharedProtoEncoderFunc = mockProtoEncoder;
      (O11yService as any).sharedInstrApp = {
        simpleCollector: mockSimpleCollector,
      };
      (O11yService as any).sharedO11yModules = { test: "module" };
      o11yService.instrumentation = { log: jest.fn() } as any;
      o11yService.a4dO11ySchema = {};
    });

    describe("forceFlush", () => {
      test("headless force flush exposes collector drain validation errors", async () => {
        (o11yService as any).headlessMode = true;
        (O11yService as any).sharedUploadOwner = o11yService;
        (
          O11yService as any
        ).sharedInstrApp.simpleCollector.getRawContentsOfCoreEnvelope.mockImplementation(
          () => {
            throw new Error("validation drain failed");
          },
        );
        jest.spyOn(console, "error").mockImplementation(() => {});
        await expect(o11yService.forceFlush()).rejects.toThrow(
          "validation drain failed",
        );
      });
      test("should force flush when service is initialized", async () => {
        jest.spyOn(o11yService, "uploadAsNeededAsync").mockResolvedValue([]);

        await o11yService.forceFlush();

        expect(o11yService.uploadAsNeededAsync).toHaveBeenCalledWith(true);
      });

      test("should not flush when service is not initialized", async () => {
        (O11yService as any).sharedProtoEncoderFunc = null;
        jest.spyOn(console, "error").mockImplementation(() => {});

        await o11yService.forceFlush();

        // forceFlush() delegates to upload(), so it uses upload()'s error message
        expect(console.error).toHaveBeenCalledWith(
          "O11yService: Cannot upload - Service not fully initialized",
        );
      });

      test("should handle errors gracefully during force flush", async () => {
        jest
          .spyOn(o11yService, "uploadAsNeededAsync")
          .mockRejectedValue(new Error("Upload failed"));
        jest.spyOn(console, "error").mockImplementation(() => {});

        await expect(o11yService.forceFlush()).resolves.toBeUndefined();

        // forceFlush() delegates to upload(), so it uses upload()'s error message
        expect(console.error).toHaveBeenCalledWith(
          "Telemetry upload failed:",
          expect.any(Error),
        );
      });
    });

    describe("enableAutoBatching", () => {
      beforeEach(() => {
        jest.useFakeTimers();
      });

      afterEach(() => {
        jest.useRealTimers();
      });

      test("should set up periodic flush with default 30s interval", async () => {
        jest.spyOn(o11yService, "uploadAsNeededAsync").mockResolvedValue([]);

        const cleanup = o11yService.enableAutoBatching();

        // Fast-forward 5 seconds - should trigger threshold check
        jest.advanceTimersByTime(5000);
        await Promise.resolve(); // Allow async operations to complete
        expect(o11yService.uploadAsNeededAsync).toHaveBeenCalledWith(false);

        // Fast-forward 30 seconds total - should trigger full flush (ignoreThreshold = true)
        // Timer runs every 5s, checking threshold each time
        // After 30s total, it should have triggered a full flush (ignoreThreshold = true)
        jest.advanceTimersByTime(25000); // Advance to 30s total
        await Promise.resolve(); // Allow async operations to complete
        // Verify that at some point it was called with true (full flush)
        const calls = (o11yService.uploadAsNeededAsync as jest.Mock).mock.calls;
        const hasFullFlush = calls.some((call) => call[0] === true);
        expect(hasFullFlush).toBe(true);

        cleanup();
      });

      test("should use custom flush interval", async () => {
        jest.spyOn(o11yService, "uploadAsNeededAsync").mockResolvedValue([]);

        const cleanup = o11yService.enableAutoBatching({
          flushInterval: 10000, // 10 seconds
        });

        // Fast-forward 10 seconds - should trigger threshold check and full flush
        jest.advanceTimersByTime(10000);
        await Promise.resolve(); // Allow async operations to complete
        // Timer runs every 5s, checking threshold each time
        // After 10s total, it should have triggered a full flush (ignoreThreshold = true)
        expect(o11yService.uploadAsNeededAsync).toHaveBeenCalledWith(false);
        // Verify that at some point it was called with true (full flush)
        const calls = (o11yService.uploadAsNeededAsync as jest.Mock).mock.calls;
        const hasFullFlush = calls.some((call) => call[0] === true);
        expect(hasFullFlush).toBe(true);

        cleanup();
      });

      test("should use custom thresholdBytes when provided", () => {
        const customThreshold = 20000; // 20KB
        o11yService.enableAutoBatching({
          thresholdBytes: customThreshold,
        });

        const status = o11yService.getBatchStatus();
        expect(status.thresholdBytes).toBe(customThreshold);

        // Test with data over custom threshold
        const mockSimpleCollector = {
          hasData: true,
          estimatedByteSize: 25000, // Over 20KB threshold
          getRawContentsOfCoreEnvelope: jest.fn().mockReturnValue({}),
        };

        (O11yService as any).sharedInstrApp = {
          simpleCollector: mockSimpleCollector,
        };

        const statusWithData = o11yService.getBatchStatus();
        expect(statusWithData.thresholdBytes).toBe(customThreshold);
        expect(statusWithData.isOverThreshold).toBe(true);
      });

      test("should set up shutdown hooks when enabled", () => {
        const cleanup = o11yService.enableAutoBatching({
          enableShutdownHook: true,
        });

        const beforeExitListeners = process.listeners("beforeExit");
        const sigintListeners = process.listeners("SIGINT");
        const sigtermListeners = process.listeners("SIGTERM");

        expect(beforeExitListeners.length).toBeGreaterThan(0);
        expect(sigintListeners.length).toBeGreaterThan(0);
        expect(sigtermListeners.length).toBeGreaterThan(0);

        cleanup();
      });

      test("should not set up shutdown hooks when disabled", () => {
        const beforeExitCount = process.listeners("beforeExit").length;
        const sigintCount = process.listeners("SIGINT").length;
        const sigtermCount = process.listeners("SIGTERM").length;

        const cleanup = o11yService.enableAutoBatching({
          enableShutdownHook: false,
        });

        expect(process.listeners("beforeExit").length).toBe(beforeExitCount);
        expect(process.listeners("SIGINT").length).toBe(sigintCount);
        expect(process.listeners("SIGTERM").length).toBe(sigtermCount);

        cleanup();
      });

      test("should cleanup timers and listeners on cleanup", () => {
        const cleanup = o11yService.enableAutoBatching();

        const beforeExitCount = process.listeners("beforeExit").length;
        const sigintCount = process.listeners("SIGINT").length;
        const sigtermCount = process.listeners("SIGTERM").length;

        cleanup();

        expect(process.listeners("beforeExit").length).toBe(
          beforeExitCount - 1,
        );
        expect(process.listeners("SIGINT").length).toBe(sigintCount - 1);
        expect(process.listeners("SIGTERM").length).toBe(sigtermCount - 1);
      });

      test("should clear existing timer when enableAutoBatching is called again", () => {
        const clearIntervalSpy = jest.spyOn(global, "clearInterval");

        o11yService.enableAutoBatching();
        o11yService.enableAutoBatching();

        expect(clearIntervalSpy).toHaveBeenCalled();
      });

      test("should handle errors in periodic flush gracefully", async () => {
        jest
          .spyOn(o11yService, "uploadAsNeededAsync")
          .mockRejectedValue(new Error("Upload failed"));
        jest.spyOn(console, "error").mockImplementation(() => {});

        o11yService.enableAutoBatching();

        // Fast-forward 5 seconds and wait for async operations
        jest.advanceTimersByTime(5000);
        await Promise.resolve(); // Allow async operations to complete

        expect(console.error).toHaveBeenCalledWith(
          "[O11yService] Auto-batching flush failed:",
          expect.any(Error),
        );
      });
    });

    describe("getBatchStatus", () => {
      test("should return correct batch status when data exists", () => {
        const status = o11yService.getBatchStatus();

        expect(status.hasData).toBe(true);
        expect(status.estimatedByteSize).toBe(10000);
        expect(status.thresholdBytes).toBe(50000);
        expect(status.isOverThreshold).toBe(false);
      });

      test("should return correct batch status when over threshold", () => {
        const mockSimpleCollector = {
          hasData: true,
          estimatedByteSize: 60000,
          getRawContentsOfCoreEnvelope: jest.fn().mockReturnValue({}),
        };

        (O11yService as any).sharedInstrApp = {
          simpleCollector: mockSimpleCollector,
        };

        const status = o11yService.getBatchStatus();

        expect(status.hasData).toBe(true);
        expect(status.estimatedByteSize).toBe(60000);
        expect(status.thresholdBytes).toBe(50000);
        expect(status.isOverThreshold).toBe(true);
      });

      test("should return correct batch status when no data", () => {
        const mockSimpleCollector = {
          hasData: false,
          estimatedByteSize: 0,
          getRawContentsOfCoreEnvelope: jest.fn().mockReturnValue({}),
        };

        (O11yService as any).sharedInstrApp = {
          simpleCollector: mockSimpleCollector,
        };

        const status = o11yService.getBatchStatus();

        expect(status.hasData).toBe(false);
        expect(status.estimatedByteSize).toBe(0);
        expect(status.thresholdBytes).toBe(50000);
        expect(status.isOverThreshold).toBe(false);
      });

      test("should handle missing simpleCollector gracefully", () => {
        (O11yService as any).sharedInstrApp = null;

        const status = o11yService.getBatchStatus();

        expect(status.hasData).toBe(false);
        expect(status.estimatedByteSize).toBe(0);
        expect(status.thresholdBytes).toBe(50000);
        expect(status.isOverThreshold).toBe(false);
      });
    });
  });

  describe("Opt-in Falcon publishing and routing chain", () => {
    const DEV = "https://falcon-dev.example.net/ui-telemetry";
    const PROD = "https://falcon-prod.example.net/ui-telemetry";
    const KEY = "o11y_pk_test_key";

    const buildMockModules = () => ({
      o11yClientVersion: "1.0.0",
      o11ySchemaVersion: "1.0.0",
      a4d_instrumentation: { name: "sf_a4dInstrumentation" },
      getInstrumentation: jest.fn().mockReturnValue({ log: jest.fn() }),
      registerInstrumentedApp: jest.fn().mockReturnValue({
        registerLogCollector: jest.fn(),
        registerMetricsCollector: jest.fn(),
      }),
      ConsoleCollector: jest.fn(),
      simpleCollectorModule: { default: { SimpleCollector: jest.fn() } },
      collectorsModule: {
        default: { encodeCoreEnvelopeContentsRaw: jest.fn() },
      },
    });

    // Fully initialize a service instance with the given Falcon/headless options.
    const initWith = async (
      endpoint: string,
      getConnection?: () => Promise<any>,
      options?: any,
    ): Promise<O11yService> => {
      (O11yService as any).sharedInstrApp = null;
      (O11yService as any).sharedO11yModules = null;
      (O11yService as any).sharedAppName = null;
      (O11yService as any).sharedResourcesInitPromise = null;
      (O11yService as any).sharedProtoEncoderFunc = null;
      (loadO11yModules as jest.Mock).mockResolvedValue(buildMockModules());
      const svc = O11yService.getInstance(`falcon-${Math.random()}`);
      await svc.initialize("ext", endpoint, getConnection, options);
      return svc;
    };

    // Prime the shared buffer with data so uploadAsNeededAsync reaches the drain/route branch.
    const primeForUpload = (svc: O11yService) => {
      (O11yService as any).sharedProtoEncoderFunc = jest
        .fn()
        .mockReturnValue(new Uint8Array([1, 2, 3]));
      (O11yService as any).sharedInstrApp = {
        simpleCollector: {
          hasData: true,
          estimatedByteSize: 60000,
          getRawContentsOfCoreEnvelope: jest.fn().mockReturnValue({}),
        },
      };
      (O11yService as any).sharedO11yModules = { test: "module" };
      svc.instrumentation = { log: jest.fn() } as any;
    };

    beforeEach(() => {
      jest.spyOn(console, "error").mockImplementation(() => {});
    });

    describe("Falcon config resolution (dev/prod flag)", () => {
      test("defaults to dev endpoint when environment is omitted", async () => {
        const svc = await initWith("http://static", undefined, {
          falcon: { apiKey: KEY, endpoints: { dev: DEV, prod: PROD } },
        });
        expect((svc as any).falconUpload).toEqual({
          endpoint: DEV,
          apiKey: KEY,
        });
      });

      test("selects prod endpoint when environment is prod", async () => {
        const svc = await initWith("http://static", undefined, {
          falcon: {
            apiKey: KEY,
            environment: "prod",
            endpoints: { dev: DEV, prod: PROD },
          },
        });
        expect((svc as any).falconUpload).toEqual({
          endpoint: PROD,
          apiKey: KEY,
        });
      });

      test("coerces an invalid environment to dev (never prod)", async () => {
        const svc = await initWith("http://static", undefined, {
          falcon: {
            apiKey: KEY,
            environment: "staging",
            endpoints: { dev: DEV, prod: PROD },
          },
        });
        expect((svc as any).falconUpload.endpoint).toBe(DEV);
      });

      test("uses the endpoint shorthand when endpoints map is absent", async () => {
        const svc = await initWith("http://static", undefined, {
          falcon: { apiKey: KEY, endpoint: DEV },
        });
        expect((svc as any).falconUpload).toEqual({
          endpoint: DEV,
          apiKey: KEY,
        });
      });

      test("disables Falcon when apiKey is missing", async () => {
        const svc = await initWith("http://static", undefined, {
          falcon: { endpoint: DEV },
        });
        expect((svc as any).falconUpload).toBeNull();
      });

      test("keeps Falcon opted in with an undefined endpoint when none resolves for the selected environment", async () => {
        // Opt-in is keyed on the API key: a missing endpoint does NOT disable Falcon; it
        // leaves the endpoint undefined so the routing chain falls back (headless collector
        // when injected, otherwise the existing org/static path).
        const svc = await initWith("http://static", undefined, {
          falcon: { apiKey: KEY, environment: "prod", endpoints: { dev: DEV } },
        });
        expect((svc as any).falconUpload).toEqual({
          endpoint: undefined,
          apiKey: KEY,
        });
      });
    });

    describe("Falcon endpoint normalization (consumer supplies base host)", () => {
      // The consumer configures only the pod base host; the library appends the fixed
      // /ui-telemetry ingest path. /telemetry on the same host is SSO-gated, so the path
      // is a service protocol detail the library owns, not a consumer choice.
      const HOST = "https://o11y.sfproxy-core002.example.net";

      test("appends /ui-telemetry to a bare base host", async () => {
        const svc = await initWith("http://static", undefined, {
          falcon: { apiKey: KEY, endpoint: HOST },
        });
        expect((svc as any).falconUpload.endpoint).toBe(`${HOST}/ui-telemetry`);
      });

      test("appends /ui-telemetry to a base host with a trailing slash (no double slash)", async () => {
        const svc = await initWith("http://static", undefined, {
          falcon: { apiKey: KEY, endpoint: `${HOST}/` },
        });
        expect((svc as any).falconUpload.endpoint).toBe(`${HOST}/ui-telemetry`);
      });

      test("does not double-append when the URL already ends in /ui-telemetry", async () => {
        const svc = await initWith("http://static", undefined, {
          falcon: { apiKey: KEY, endpoint: `${HOST}/ui-telemetry` },
        });
        expect((svc as any).falconUpload.endpoint).toBe(`${HOST}/ui-telemetry`);
      });

      test("normalizes a trailing slash on an existing /ui-telemetry path", async () => {
        const svc = await initWith("http://static", undefined, {
          falcon: { apiKey: KEY, endpoint: `${HOST}/ui-telemetry/` },
        });
        expect((svc as any).falconUpload.endpoint).toBe(`${HOST}/ui-telemetry`);
      });

      test("preserves any other explicit path as an override", async () => {
        const override = `${HOST}/custom-ingest`;
        const svc = await initWith("http://static", undefined, {
          falcon: { apiKey: KEY, endpoint: override },
        });
        expect((svc as any).falconUpload.endpoint).toBe(override);
      });

      test("applies normalization per-environment via the endpoints map", async () => {
        const svc = await initWith("http://static", undefined, {
          falcon: {
            apiKey: KEY,
            environment: "prod",
            endpoints: { dev: HOST, prod: "https://prod-pod.example.net/" },
          },
        });
        expect((svc as any).falconUpload.endpoint).toBe(
          "https://prod-pod.example.net/ui-telemetry",
        );
      });
    });

    describe("headless-collector fallback (Falcon opted in, no endpoint)", () => {
      test("enters headless mode and registers the collector on the shared app", async () => {
        const collector = { close: jest.fn() };
        const svc = await initWith("http://static", undefined, {
          falcon: { apiKey: KEY },
          headlessCollector: collector,
        });

        expect((svc as any).headlessMode).toBe(true);
        expect((svc as any).headlessCollector).toBe(collector);
        // Registered on the shared app so it captures log events retroactively.
        expect(
          (O11yService as any).sharedInstrApp.registerLogCollector,
        ).toHaveBeenCalledWith(collector, { retroactive: true });
      });

      test("does not enter headless mode when a Falcon endpoint resolves", async () => {
        const collector = { close: jest.fn() };
        const svc = await initWith("http://static", undefined, {
          falcon: { apiKey: KEY, endpoint: DEV },
          headlessCollector: collector,
        });
        expect((svc as any).headlessMode).toBe(false);
      });

      test("does not enter headless mode when no collector is injected", async () => {
        const svc = await initWith("http://static", undefined, {
          falcon: { apiKey: KEY },
        });
        expect((svc as any).headlessMode).toBe(false);
      });
    });

    describe("destination selection in uploadAsNeededAsync", () => {
      test("routes to Falcon when a Falcon key is configured", async () => {
        const svc = await initWith("http://static", undefined, {
          falcon: { apiKey: KEY, endpoint: DEV },
        });
        primeForUpload(svc);
        jest
          .spyOn(svc, "postToFalconServiceAsync")
          .mockResolvedValue({ status: 202, ok: true } as Response);
        jest.spyOn(svc, "uploadViaConnectionOrStaticAsync");

        await svc.uploadAsNeededAsync(true);

        expect(svc.postToFalconServiceAsync).toHaveBeenCalled();
        expect(svc.uploadViaConnectionOrStaticAsync).not.toHaveBeenCalled();
      });

      test("routes to the existing path when no Falcon key is configured", async () => {
        const svc = await initWith("http://static");
        primeForUpload(svc);
        jest
          .spyOn(svc, "uploadViaConnectionOrStaticAsync")
          .mockResolvedValue({ status: 200, ok: true } as Response);
        jest.spyOn(svc, "postToFalconServiceAsync");

        await svc.uploadAsNeededAsync(true);

        expect(svc.uploadViaConnectionOrStaticAsync).toHaveBeenCalled();
        expect(svc.postToFalconServiceAsync).not.toHaveBeenCalled();
      });

      test("routes to the existing path when Falcon is opted in but no endpoint resolves (no collector)", async () => {
        const svc = await initWith("http://static", undefined, {
          falcon: { apiKey: KEY },
        });
        primeForUpload(svc);
        jest
          .spyOn(svc, "uploadViaConnectionOrStaticAsync")
          .mockResolvedValue({ status: 200, ok: true } as Response);
        jest.spyOn(svc, "postToFalconServiceAsync");

        await svc.uploadAsNeededAsync(true);

        expect(svc.uploadViaConnectionOrStaticAsync).toHaveBeenCalled();
        expect(svc.postToFalconServiceAsync).not.toHaveBeenCalled();
      });

      test("performs no network upload in headless mode (collector already captured locally)", async () => {
        const collector = { close: jest.fn() };
        const svc = await initWith("http://static", undefined, {
          falcon: { apiKey: KEY },
          headlessCollector: collector,
        });
        primeForUpload(svc);
        const fetchSpy = jest.spyOn(global, "fetch");
        jest.spyOn(svc, "postToFalconServiceAsync");
        jest.spyOn(svc, "uploadViaConnectionOrStaticAsync");

        const results = await svc.uploadAsNeededAsync(true);

        expect(results).toEqual([]);
        expect(svc.postToFalconServiceAsync).not.toHaveBeenCalled();
        expect(svc.uploadViaConnectionOrStaticAsync).not.toHaveBeenCalled();
        expect(fetchSpy).not.toHaveBeenCalled();
      });
    });

    describe("postToFalconServiceAsync", () => {
      test("posts raw bytes with octet-stream and x-o11y-api-key to the selected endpoint", async () => {
        const svc = await initWith("http://static", undefined, {
          falcon: { apiKey: KEY, endpoint: DEV },
        });
        const fetchSpy = jest
          .spyOn(global, "fetch")
          .mockResolvedValue({ status: 202, ok: true } as Response);

        await svc.postToFalconServiceAsync(new Uint8Array([1, 2, 3]));

        expect(fetchSpy).toHaveBeenCalledWith(
          DEV,
          expect.objectContaining({
            method: "POST",
            headers: {
              "Content-Type": "application/octet-stream",
              "x-o11y-api-key": KEY,
            },
          }),
        );
      });

      test("rejects when Falcon is not configured", async () => {
        const svc = await initWith("http://static");
        await expect(
          svc.postToFalconServiceAsync(new Uint8Array([1])),
        ).rejects.toThrow("Falcon publishing is not configured");
      });
    });

    describe("uploadViaConnectionOrStaticAsync fallback chain (no Falcon key)", () => {
      test("uses the authenticated org connection when available", async () => {
        const requestPost = jest.fn().mockResolvedValue({});
        const getConnection = jest.fn().mockResolvedValue({ requestPost });
        const svc = await initWith("http://static", getConnection);
        const fetchSpy = jest.spyOn(global, "fetch");

        const res = await svc.uploadViaConnectionOrStaticAsync(
          new Uint8Array([1, 2, 3]),
        );

        expect(requestPost).toHaveBeenCalled();
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(res.ok).toBe(true);
      });

      test("falls back to the static endpoint when there is no connection", async () => {
        const svc = await initWith("http://static");
        const fetchSpy = jest
          .spyOn(global, "fetch")
          .mockResolvedValue({ status: 200, ok: true } as Response);

        await svc.uploadViaConnectionOrStaticAsync(new Uint8Array([1, 2, 3]));

        expect(fetchSpy).toHaveBeenCalledWith(
          "http://static",
          expect.objectContaining({ method: "POST" }),
        );
      });

      test("falls back to the static endpoint when the connection call throws", async () => {
        const getConnection = jest.fn().mockRejectedValue(new Error("no auth"));
        const svc = await initWith("http://static", getConnection);
        const fetchSpy = jest
          .spyOn(global, "fetch")
          .mockResolvedValue({ status: 200, ok: true } as Response);

        await svc.uploadViaConnectionOrStaticAsync(new Uint8Array([1, 2, 3]));

        expect(fetchSpy).toHaveBeenCalledWith(
          "http://static",
          expect.objectContaining({ method: "POST" }),
        );
      });

      test("rejects when neither a connection nor a static endpoint is configured", async () => {
        const svc = await initWith("");
        await expect(
          svc.uploadViaConnectionOrStaticAsync(new Uint8Array([1])),
        ).rejects.toThrow("o11yUploadEndpoint is not defined");
      });

      test("deprecated uploadToFalconAsync alias forwards to uploadViaConnectionOrStaticAsync", async () => {
        const svc = await initWith("http://static");
        const binary = new Uint8Array([1, 2, 3]);
        const spy = jest
          .spyOn(svc, "uploadViaConnectionOrStaticAsync")
          .mockResolvedValue({ status: 200, ok: true } as Response);

        const res = await svc.uploadToFalconAsync(binary);

        expect(spy).toHaveBeenCalledWith(binary);
        expect(res.ok).toBe(true);
      });
    });

    describe("multi-instance shared-buffer routing (first-writer-wins)", () => {
      // Initialize a SECOND instance against the already-initialized shared app, without
      // resetting shared statics. Mirrors the Salesforce Extension Pack: several extensions in
      // one VS Code extension host share one registered o11y app and one pooled buffer.
      const initSecond = (
        extName: string,
        options?: any,
      ): Promise<O11yService> => {
        const svc = O11yService.getInstance(`falcon-2-${Math.random()}`);
        return svc
          .initialize(extName, "http://static", undefined, options)
          .then(() => svc);
      };

      test("owner (first initialize) wins: a later headless instance's drain still routes to the owner's Falcon endpoint", async () => {
        // Instance A opts into Falcon first -> claims the shared upload destination.
        const a = await initWith("http://static", undefined, {
          falcon: { apiKey: KEY, endpoint: DEV },
        });
        // Instance B initializes headless against the SAME shared app.
        const collector = { collect: jest.fn(), close: jest.fn() };
        const b = await initSecond("ext-b", {
          falcon: { apiKey: KEY },
          headlessCollector: collector,
        });
        expect((O11yService as any).sharedUploadOwner).toBe(a);

        primeForUpload(b);
        jest
          .spyOn(a, "postToFalconServiceAsync")
          .mockResolvedValue({ status: 202, ok: true } as Response);
        jest.spyOn(b, "postToFalconServiceAsync");
        jest.spyOn(b, "uploadViaConnectionOrStaticAsync");

        // B's timer drains the pooled buffer, but routing follows the OWNER (A) -> Falcon.
        await b.uploadAsNeededAsync(true);

        expect(a.postToFalconServiceAsync).toHaveBeenCalled();
        expect(b.postToFalconServiceAsync).not.toHaveBeenCalled();
        expect(b.uploadViaConnectionOrStaticAsync).not.toHaveBeenCalled();
      });

      test("headless owner wins: a later Falcon instance's drain performs no network upload (owner is zero-egress)", async () => {
        const collector = { collect: jest.fn(), close: jest.fn() };
        const a = await initWith("http://static", undefined, {
          falcon: { apiKey: KEY },
          headlessCollector: collector,
        });
        expect((a as any).headlessMode).toBe(true);
        const b = await initSecond("ext-b", {
          falcon: { apiKey: KEY, endpoint: DEV },
        });
        expect((O11yService as any).sharedUploadOwner).toBe(a);

        primeForUpload(b);
        const fetchSpy = jest.spyOn(global, "fetch");
        jest.spyOn(b, "postToFalconServiceAsync");
        jest.spyOn(b, "uploadViaConnectionOrStaticAsync");

        // Owner A is headless -> B's drain discards bytes; zero egress preserved.
        const results = await b.uploadAsNeededAsync(true);

        expect(results).toEqual([]);
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(b.postToFalconServiceAsync).not.toHaveBeenCalled();
        expect(b.uploadViaConnectionOrStaticAsync).not.toHaveBeenCalled();
      });

      test("logs a conflict error when a later instance resolves a different destination", async () => {
        const errorSpy = jest.spyOn(console, "error");
        await initWith("http://static", undefined, {
          falcon: { apiKey: KEY, endpoint: DEV },
        });
        errorSpy.mockClear();
        // No Falcon -> existing connection/static path, which conflicts with the owner's Falcon.
        await initSecond("ext-b");

        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining("Conflicting telemetry upload destination"),
        );
      });

      test("does not log a conflict error when a later instance resolves the same destination", async () => {
        const errorSpy = jest.spyOn(console, "error");
        await initWith("http://static", undefined, {
          falcon: { apiKey: KEY, endpoint: DEV },
        });
        errorSpy.mockClear();
        await initSecond("ext-b", { falcon: { apiKey: KEY, endpoint: DEV } });

        expect(errorSpy).not.toHaveBeenCalledWith(
          expect.stringContaining("Conflicting telemetry upload destination"),
        );
      });

      test("logs a conflict error for the SAME Falcon endpoint with a DIFFERENT API key (cross-tenant misattribution)", async () => {
        const errorSpy = jest.spyOn(console, "error");
        await initWith("http://static", undefined, {
          falcon: { apiKey: KEY, endpoint: DEV },
        });
        errorSpy.mockClear();
        // Same pod, different tenant key -> the shared buffer would upload under the owner's key,
        // so this MUST be flagged as a conflict.
        await initSecond("ext-b", {
          falcon: { apiKey: `${KEY}-other-tenant`, endpoint: DEV },
        });

        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining("Conflicting telemetry upload destination"),
        );
      });

      test("the conflict error never contains the raw API key (fingerprint only)", async () => {
        const errorSpy = jest.spyOn(console, "error");
        await initWith("http://static", undefined, {
          falcon: { apiKey: KEY, endpoint: DEV },
        });
        errorSpy.mockClear();
        const otherKey = `${KEY}-other-tenant`;
        await initSecond("ext-b", {
          falcon: { apiKey: otherKey, endpoint: DEV },
        });

        for (const call of errorSpy.mock.calls) {
          const joined = call.join(" ");
          expect(joined).not.toContain(KEY);
          expect(joined).not.toContain(otherKey);
        }
      });
    });
  });
});
