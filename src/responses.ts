/**
 * Plain HTTP response helpers shared by the public API and the internal relay.
 */

import { Buffer } from "node:buffer";
import type { ServerResponse } from "node:http";

/**
 * Sends response headers immediately when the implementation supports it.
 *
 * @param res - HTTP response whose headers should be flushed.
 */
export function flushHeaders(res: ServerResponse): void {
  try {
    res.flushHeaders();
  } catch {
    // Not available on every response implementation.
  }
}

/**
 * Writes a JSON response.
 *
 * @param res - HTTP response to write to.
 * @param status - HTTP status code.
 * @param body - JSON-serializable payload.
 * @param headOnly - When `true`, only headers are sent (HEAD requests).
 */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headOnly = false,
): void {
  const payload = Buffer.from(`${JSON.stringify(body, null, 2)}\n`, "utf8");
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(payload.length),
    "cache-control": "no-store",
  });
  res.end(headOnly ? undefined : payload);
}

/**
 * Writes a plain-text response.
 *
 * @param res - HTTP response to write to.
 * @param status - HTTP status code.
 * @param text - Response body.
 */
export function sendText(
  res: ServerResponse,
  status: number,
  text: string,
): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(text);
}
