// Loaded before every test file (`node --import ./test/setup.ts --test ...`). Hard rule: tests never touch the
// network (DESIGN-agnostic §7.1 item 11, Tester gap 6). Any real fetch or outbound socket connect throws.
// Tests use in-process handlers (`mcp-server.ts` handle()), injected fetch/spawn/exec fakes, or local child processes.
import net from 'node:net';

const refuse = (what: string) => () => { throw new Error(`network call attempted in a test (${what}); inject a fake instead`); };
(globalThis as { fetch: unknown }).fetch = refuse('fetch');
(net.Socket.prototype as unknown as { connect: unknown }).connect = refuse('net.Socket.connect');
(globalThis as { __VES_NETWORK_LOCKED__?: boolean }).__VES_NETWORK_LOCKED__ = true;
