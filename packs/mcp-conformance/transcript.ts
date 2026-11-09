// The transcript contract lives in core now (src/proxy/mcp-transcript.ts), shared by MockAgent's reference rpc and
// the `mcp` connector's contract mode. Re-exported here so the pack and its tests keep one import path.
export * from '../../src/proxy/mcp-transcript.ts';
