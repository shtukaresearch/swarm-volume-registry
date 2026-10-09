/**
 * `isows` for the Lambda bundle. viem imports it for its WebSocket transport,
 * which the keeper never uses, and on Node it resolves to `ws` — CommonJS.
 * Node 24 has WebSocket built in, which is all isows' own native build uses.
 */
export const WebSocket = globalThis.WebSocket;
