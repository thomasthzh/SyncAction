import { z } from "zod";

export const ONBOARDING_STORAGE_KEY = "syncaction.onboarding.v1";

export const OnboardingStateSchema = z
  .object({
    version: z.literal(1),
    dismissedAtClientMs: z.number().int().nonnegative().safe(),
    clientVersion: z.string().regex(/^\d+\.\d+\.\d+$/u),
  })
  .strict();

export interface OnboardingStorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export interface OnboardingStateStoreOptions {
  area: OnboardingStorageArea;
  clientVersion: unknown;
  now?: () => number;
}

export class OnboardingStateStore {
  readonly #area: OnboardingStorageArea;
  readonly #clientVersion: string;
  readonly #now: () => number;
  #tail: Promise<void> = Promise.resolve();

  public constructor(options: OnboardingStateStoreOptions) {
    this.#area = options.area;
    this.#clientVersion = z
      .string()
      .regex(/^\d+\.\d+\.\d+$/u)
      .parse(options.clientVersion);
    this.#now = options.now ?? Date.now;
  }

  public async isRequired(): Promise<boolean> {
    await this.#tail;
    return (await this.#read()) === null;
  }

  public dismiss(): Promise<boolean> {
    const operation = this.#tail.then(async () => {
      if ((await this.#read()) !== null) {
        return false;
      }
      const record = OnboardingStateSchema.parse({
        version: 1,
        dismissedAtClientMs: this.#now(),
        clientVersion: this.#clientVersion,
      });
      await this.#area.set({ [ONBOARDING_STORAGE_KEY]: record });
      return true;
    });
    this.#tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async #read(): Promise<z.infer<typeof OnboardingStateSchema> | null> {
    const value = (await this.#area.get(ONBOARDING_STORAGE_KEY))[ONBOARDING_STORAGE_KEY];
    const parsed = OnboardingStateSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  }
}
