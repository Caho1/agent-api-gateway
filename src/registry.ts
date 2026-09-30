import {
  GatewayError,
  validName,
  type Account,
  type Config,
  type Invocation,
} from "./model.ts";
/** Adapters are trusted server code, installed locally, never supplied by a client. */
export interface ProviderAdapter {
  readonly id: string;
  readonly operations: readonly string[];
  validateAccount(account: Account): void;
  /** Must be pure/local. No network or billable work before the core reserves quota. */
  validate(input: Invocation, account: Account): void;
  /** Exactly one upstream request per invocation; no hidden retries or pagination. */
  invoke(input: Invocation, account: Account): Promise<unknown>;
}
export class AdapterRegistry {
  private adapters = new Map<string, ProviderAdapter>();
  constructor(adapters: ProviderAdapter[]) {
    for (const adapter of adapters) {
      if (
        !validName(adapter.id) ||
        this.adapters.has(adapter.id) ||
        !adapter.operations.length ||
        !adapter.operations.every(validName)
      )
        throw new Error("Invalid adapter registration");
      this.adapters.set(adapter.id, adapter);
    }
  }
  validateConfig(config: Config) {
    for (const account of Object.values(config.accounts)) {
      const adapter = this.adapters.get(account.provider);
      if (!adapter) throw new Error("Unknown account provider");
      adapter.validateAccount(account);
    }
  }
  resolve(input: Invocation, account: Account) {
    const adapter = this.adapters.get(account.provider);
    if (!adapter || !adapter.operations.includes(input.operation))
      throw new GatewayError(403, "forbidden");
    adapter.validate(input, account);
    return adapter;
  }
}
