// GeneralStaff — Phase 6 web dashboard server (scaffold).
//
// Minimal Bun.serve() skeleton. Later tasks add routes, templates,
// and static assets on top of this entrypoint.

export interface StartServerOptions {
  port?: number;
  host?: string;
}

export interface RunningServer {
  url: string;
  stop: () => void;
}

export async function startServer(
  opts: StartServerOptions = {},
): Promise<RunningServer> {
  const hostname = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 3737;

  const server = Bun.serve({
    hostname,
    port,
    fetch(req: Request): Response {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/health") {
        return new Response("ok", { status: 200 });
      }
      return new Response("Not Found", { status: 404 });
    },
  });

  return {
    url: `http://${server.hostname}:${server.port}`,
    stop: () => {
      server.stop(true);
    },
  };
}
