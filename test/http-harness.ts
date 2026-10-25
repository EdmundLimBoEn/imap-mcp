import { IncomingMessage, ServerResponse, type Server } from "node:http";
import { Socket } from "node:net";

// Exercise the real HTTP handler/SDK without requiring a listening TCP socket.
export function request(app: Server, path: string, init: RequestInit = {}) {
  const req = new IncomingMessage(new Socket());
  req.complete = true;
  req.url = path;
  req.method = init.method ?? "GET";
  req.headers = Object.fromEntries(new Headers(init.headers).entries());
  req.headers.host = "localhost";
  req.rawHeaders = Object.entries(req.headers).flatMap(([key, value]) => [key, String(value)]);
  const res = new ServerResponse(req);
  const chunks: Buffer[] = [];
  const response = new Promise<Response>((resolve) => {
    res.write = ((chunk: any) => { chunks.push(Buffer.from(chunk)); return true; }) as typeof res.write;
    res.end = ((chunk?: any) => {
      if (chunk) chunks.push(Buffer.from(chunk));
      const headers = new Headers();
      for (const [key, value] of Object.entries(res.getHeaders())) headers.set(key, String(value));
      resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers }));
      res.emit("finish");
      res.emit("close");
      return res;
    }) as typeof res.end;
  });
  req.push(init.body ? Buffer.from(String(init.body)) : null);
  if (init.body) req.push(null);
  app.emit("request", req, res);
  return { response, disconnect: () => res.emit("close") };
}
