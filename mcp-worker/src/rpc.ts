// JSON-RPC error raised by the MCP dispatcher.
//
// httpStatus: the status of the HTTP response when this error answers a
// single (non-batch) request. JSON-RPC errors are normally sent with 200;
// MCP 2026-07-28 uses 400 for version, header and _meta errors and 404 for
// unknown methods.
export class RpcError extends Error {
  constructor(
    public code: number,
    message: string,
    public data?: unknown,
    public httpStatus?: number,
  ) {
    super(message);
  }
}
