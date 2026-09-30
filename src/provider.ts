import {
  GatewayError,
  object,
  type Account,
  type Invocation,
} from "./model.ts";
import type { ProviderAdapter } from "./registry.ts";
export const UPSTREAM_ORIGIN = "https://api.tikhub.io";
const MAX_BYTES = 1024 * 1024;
export type Transport = typeof fetch;
function parseJson(text: string): unknown {
  return JSON.parse(
    text,
    (_key, value: unknown, context?: { source: string }) =>
      typeof value === "number" &&
      !Number.isSafeInteger(value) &&
      context &&
      /^-?\d+$/.test(context.source)
        ? context.source
        : value,
  );
}
const numericId = (value: unknown) =>
  typeof value === "string"
    ? value
    : typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      ? String(value)
      : "";
const counter = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
type TikHubSettings = { secUid: string; postIds: string[] };
function settings(account: Account): TikHubSettings {
  const value = account.settings;
  if (
    account.provider !== "tikhub" ||
    typeof value.secUid !== "string" ||
    !/^[a-zA-Z0-9_-]{1,256}$/.test(value.secUid) ||
    !Array.isArray(value.postIds) ||
    !value.postIds.every((x) => typeof x === "string" && /^\d{1,32}$/.test(x))
  )
    throw new GatewayError(503, "invalid_account_config");
  return value as TikHubSettings;
}
export class TikHub implements ProviderAdapter {
  readonly id = "tikhub";
  readonly operations = ["posts.list", "posts.metrics"];
  validateAccount(account: Account) {
    settings(account);
  }
  validate(input: Invocation, account: Account) {
    const config = settings(account);
    if (input.operation === "posts.list") {
      if (
        Object.keys(input.args).some((k) => k !== "cursor") ||
        (input.args.cursor !== undefined &&
          (typeof input.args.cursor !== "string" ||
            !/^\d{1,20}$/.test(input.args.cursor)))
      )
        throw new GatewayError(400, "invalid_arguments");
    } else if (input.operation === "posts.metrics") {
      if (
        Object.keys(input.args).length !== 1 ||
        typeof input.args.postId !== "string" ||
        !/^\d{1,32}$/.test(input.args.postId)
      )
        throw new GatewayError(400, "invalid_arguments");
      if (!config.postIds.includes(String(input.args.postId)))
        throw new GatewayError(403, "forbidden");
    } else throw new GatewayError(400, "invalid_operation");
  }
  private key: string;
  private transport: Transport;
  constructor(key: string, transport: Transport = fetch) {
    this.key = key;
    this.transport = transport;
    if (!key || key.startsWith("replace-"))
      throw new Error("Provider key required");
  }
  async invoke(input: Invocation, account: Account): Promise<unknown> {
    this.validate(input, account);
    const config = settings(account);
    const url = new URL(
      input.operation === "posts.list"
        ? "/api/v1/douyin/app/v3/fetch_user_post_videos"
        : "/api/v1/douyin/app/v3/fetch_video_statistics",
      UPSTREAM_ORIGIN,
    );
    if (input.operation === "posts.list") {
      url.search = new URLSearchParams({
        sec_user_id: config.secUid,
        max_cursor: String(input.args.cursor ?? "0"),
        count: "20",
        sort_type: "0",
        channel: "normal",
      }).toString();
    } else {
      if (
        !input.args.postId ||
        !config.postIds.includes(String(input.args.postId))
      )
        throw new GatewayError(403, "forbidden");
      url.search = new URLSearchParams({
        aweme_ids: String(input.args.postId),
      }).toString();
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await this.transport(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.key}`,
          Accept: "application/json",
        },
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error("upstream");
      }
      if (Number(response.headers.get("content-length")) > MAX_BYTES) {
        await response.body.cancel();
        throw new Error("size");
      }
      const reader = response.body.getReader();
      let total = 0;
      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_BYTES) {
          await reader.cancel();
          throw new Error("size");
        }
        chunks.push(value);
      }
      const body = parseJson(Buffer.concat(chunks).toString("utf8"));
      if (!object(body) || Number(body.code) !== 200 || !object(body.data))
        throw new Error("schema");
      const clean = (value: unknown) =>
        typeof value === "string"
          ? value.split(this.key).join("[REDACTED]").slice(0, 2000)
          : null;
      if (input.operation === "posts.list") {
        if (
          !Array.isArray(body.data.aweme_list) ||
          body.data.aweme_list.length > 100
        )
          throw new Error("schema");
        const seen = new Set<string>();
        const posts = body.data.aweme_list
          .map((item) => {
            if (
              !object(item) ||
              !object(item.author) ||
              item.author.sec_uid !== config.secUid
            )
              throw new Error("ownership");
            const id = numericId(item.aweme_id ?? item.group_id);
            if (!/^\d{1,32}$/.test(id)) throw new Error("schema");
            return {
              id,
              title: clean(item.item_title ?? item.preview_title ?? item.desc),
              createdAt: counter(item.create_time),
            };
          })
          .filter((item) => {
            if (seen.has(item.id)) return false;
            seen.add(item.id);
            return true;
          });
        const cursor = numericId(body.data.max_cursor);
        return {
          posts,
          nextCursor:
            /^\d{1,20}$/.test(cursor) &&
            cursor !== (input.args.cursor ?? "0") &&
            posts.length
              ? cursor
              : null,
          hasMore:
            typeof body.data.has_more === "boolean" ? body.data.has_more : null,
        };
      }
      if (!Array.isArray(body.data.statistics_list)) throw new Error("schema");
      const item: unknown = body.data.statistics_list.find(
        (item) =>
          object(item) && numericId(item.aweme_id) === input.args.postId,
      );
      if (!object(item)) throw new Error("schema");
      return {
        postId: input.args.postId,
        plays: counter(item.play_count),
        viewsAsOf: new Date().toISOString(),
      };
    } catch {
      throw new GatewayError(502, "upstream_unavailable");
    } finally {
      clearTimeout(timer);
    }
  }
}
