// Every local server in this repo binds a port from 4770-4789 and nothing else. Parallel test workers can
// race for the same port, so listen() walks the range until one is free.
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

export const PORT_MIN = 4770;
export const PORT_MAX = 4789;

// Within one process the next server starts at the port after the previous one instead of at a random port.
// Two consecutive servers on the same port made fetch() (which keeps idle connections in a pool per address) reuse
// a connection the old server had just closed, which showed up as a load-dependent ECONNRESET in the tests.
// A different process picks its own random starting point, and EADDRINUSE moves a server on to the next port.
let nextStart = PORT_MIN + Math.floor(Math.random() * (PORT_MAX - PORT_MIN + 1));

export async function listenInRange(server: Server, preferred?: number): Promise<number> {
  const start = preferred ?? nextStart;
  const span = PORT_MAX - PORT_MIN + 1;
  for (let i = 0; i < span; i++) {
    const port = PORT_MIN + ((start - PORT_MIN + i) % span);
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: NodeJS.ErrnoException): void => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = (): void => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, "127.0.0.1");
      });
      const bound = (server.address() as AddressInfo).port;
      nextStart = PORT_MIN + ((bound - PORT_MIN + 1) % span);
      return bound;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    }
  }
  throw new Error(`no free port in ${PORT_MIN}-${PORT_MAX}`);
}

export function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}
