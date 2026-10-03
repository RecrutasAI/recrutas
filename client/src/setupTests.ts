import { beforeAll, afterEach, afterAll, vi } from 'vitest';
import { server } from './mocks/server';
import '@testing-library/jest-dom';

// No test may open a real socket. The dashboards connect to /ws on mount (DEV
// is true under vitest); MSW can't serve that, so it let the connection through
// to localhost, where it outlived the test and raced worker shutdown in CI
// ("Channel closed" after every test passed). Installed before any MSW server
// listens, so every server's passthrough lands on this stub: no network, ever.
class StubWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = StubWebSocket.CONNECTING;
  url: string;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  constructor(url: string | URL) { this.url = String(url); }
  send(): void { /* never connected */ }
  close(): void { this.readyState = StubWebSocket.CLOSED; }
  addEventListener(): void { /* no events */ }
  removeEventListener(): void { /* no events */ }
}
vi.stubGlobal('WebSocket', StubWebSocket);

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
