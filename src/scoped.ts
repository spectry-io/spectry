import { assignExperiment, evaluateAllFlags, evaluateFlag } from "./evaluate.js";
import type { EventQueue } from "./events.js";
import type {
  Assignment,
  Attributes,
  FeatureResult,
  FlagValue,
  Logger,
  SpectryConfig,
  UserContext,
} from "./types.js";

/**
 * One user, for the life of one request.
 *
 * Every read here is synchronous and hits no network: the client holds the
 * definitions and this object just evaluates them. Create one per request,
 * hang it off `req`, and throw it away when the response is sent.
 */
export class ScopedSpectry {
  readonly attributes: Attributes;
  readonly visitorId: string;
  readonly sessionId: string | undefined;

  constructor(
    context: UserContext,
    private readonly getConfig: () => SpectryConfig | null,
    private readonly queue: EventQueue,
    private readonly logger: Logger,
  ) {
    this.attributes = context.attributes ?? {};
    // `visitorId` wins when set, so you can bucket on a stable anonymous id
    // while still reporting a logged-in `attributes.id`.
    this.visitorId = String(context.visitorId ?? this.attributes.id ?? "");
    this.sessionId = context.sessionId;
  }

  /** Has the config loaded? Everything resolves to fallbacks until it has. */
  get ready(): boolean {
    return this.getConfig() !== null;
  }

  /**
   * Is this feature on for this user?
   *
   * An unknown flag is `false`. The flag may genuinely not exist, or the config
   * may not have loaded — `getFeature().source` tells the two apart.
   */
  isOn(key: string): boolean {
    return this.getFeature(key).on;
  }

  isOff(key: string): boolean {
    return !this.isOn(key);
  }

  /**
   * The feature's value, or `fallback` when it has none for this user.
   *
   * The fallback also covers the window before `init()` resolves and any period
   * where the config could not be refreshed, so it should be the behaviour you
   * would ship if Spectry were unreachable.
   */
  getFeatureValue<T extends FlagValue>(key: string, fallback: T): T {
    const result = this.getFeature(key);
    if (result.source === "unknownFlag" || result.source === "notReady") return fallback;
    return (result.value === null || result.value === undefined
      ? fallback
      : result.value) as T;
  }

  /** The full evaluation, including why it came out this way. */
  getFeature(key: string): FeatureResult {
    const config = this.getConfig();
    if (!config) {
      return { value: null, on: false, off: true, source: "notReady" };
    }
    const flag = config.flags.find((f) => f.key === key);
    return evaluateFlag(flag, this.attributes, this.visitorId);
  }

  /** Every flag resolved for this user — handy for debug endpoints. */
  getAllFeatures(): Record<string, FeatureResult> {
    const config = this.getConfig();
    if (!config) return {};
    return evaluateAllFlags(config.flags, this.attributes, this.visitorId);
  }

  /**
   * This user's variation in an experiment, or `null` if they are not in it.
   *
   * `null` means "not exposed", which is different from being in the control
   * group — do not treat it as one.
   */
  getVariation(experimentId: string): Assignment | null {
    const config = this.getConfig();
    if (!config) return null;
    const experiment = config.experiments.find((e) => e.id === experimentId);
    if (!experiment) return null;
    return assignExperiment(experiment, this.attributes, this.visitorId);
  }

  /** Every experiment this user is currently in. */
  getExperiments(): Assignment[] {
    const config = this.getConfig();
    if (!config) return [];
    return config.experiments
      .map((experiment) => assignExperiment(experiment, this.attributes, this.visitorId))
      .filter((a): a is Assignment => a !== null);
  }

  /**
   * Record something this user did.
   *
   * Queued and sent in the background: this returns immediately and never
   * throws, because it is called from request handlers where neither latency
   * nor an exception is acceptable. Await `flush()` before the process exits.
   */
  logEvent(name: string, properties?: Record<string, unknown>): void {
    if (typeof name !== "string" || name.trim() === "") {
      this.logger.warn("logEvent called without a name; ignored");
      return;
    }

    this.queue.enqueue({
      name: name.trim(),
      ...(properties ? { properties } : {}),
      ...(this.visitorId ? { visitorId: this.visitorId } : {}),
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      ...(typeof this.attributes.url === "string" ? { url: this.attributes.url } : {}),
      // Sent explicitly because the API cannot derive them here: the connecting
      // address belongs to the customer's server, not to this user.
      attributes: {
        ...(this.attributes.country ? { country: this.attributes.country } : {}),
        ...(this.attributes.browser ? { browser: this.attributes.browser } : {}),
        ...(this.attributes.deviceType ? { deviceType: this.attributes.deviceType } : {}),
      },
    });
  }

  /** Send this user's queued events now. Shares the client-wide queue. */
  async flush(): Promise<void> {
    await this.queue.flush();
  }
}
