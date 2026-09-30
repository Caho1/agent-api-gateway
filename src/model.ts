export type Operation = string;
export type Account = { provider: string; settings: Record<string, unknown> };
export type Config = {
  accounts: Record<string, Account>;
  globalDailyUnits: number;
};
export type Invocation = {
  operation: Operation;
  account: string;
  args: Record<string, unknown>;
};
export const validName = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9_.-]{1,64}$/.test(value);
export class GatewayError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}
export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function parseConfig(raw: unknown): Config {
  if (
    !object(raw) ||
    !object(raw.accounts) ||
    !Number.isSafeInteger(raw.globalDailyUnits) ||
    Number(raw.globalDailyUnits) < 1
  )
    throw new Error("Invalid config");
  const accounts: Record<string, Account> = Object.create(null);
  for (const [id, value] of Object.entries(raw.accounts)) {
    if (
      !validName(id) ||
      !object(value) ||
      !validName(value.provider) ||
      !object(value.settings)
    )
      throw new Error("Invalid account config");
    accounts[id] = { provider: value.provider, settings: value.settings };
  }
  return { accounts, globalDailyUnits: Number(raw.globalDailyUnits) };
}
export function parseInvocation(raw: unknown): Invocation {
  if (
    !object(raw) ||
    Object.keys(raw).some(
      (k) => !["operation", "account", "args"].includes(k),
    ) ||
    !validName(raw.operation) ||
    !validName(raw.account) ||
    !object(raw.args)
  )
    throw new GatewayError(400, "invalid_request");
  return raw as Invocation;
}
