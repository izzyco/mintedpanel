declare module "pako" {
  export function deflateRaw(
    data: Uint8Array | string,
    options?: Record<string, unknown>,
  ): Uint8Array;
  export function inflateRaw(data: Uint8Array, options?: Record<string, unknown>): Uint8Array;
  export function deflate(data: Uint8Array | string, options?: Record<string, unknown>): Uint8Array;
  export function inflate(data: Uint8Array, options?: Record<string, unknown>): Uint8Array;
  const pako: {
    deflateRaw(data: Uint8Array | string, options?: Record<string, unknown>): Uint8Array;
    inflateRaw(data: Uint8Array, options?: Record<string, unknown>): Uint8Array;
    deflate(data: Uint8Array | string, options?: Record<string, unknown>): Uint8Array;
    inflate(data: Uint8Array, options?: Record<string, unknown>): Uint8Array;
  };
  export default pako;
}
