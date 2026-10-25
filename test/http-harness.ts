import { IncomingMessage, ServerResponse, type Server } from "node:http";
import { Duplex } from "node:stream";
import type { Socket } from "node:net";

/** Exercise Node HTTP request/response handling without binding a listening port. */
export function request(app: Server, path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  let wire = "";
  const socket = new Duplex({ read() {}, write(chunk, _encoding, done) { wire += chunk.toString(); done(); } });
  const req = new IncomingMessage(socket as Socket);
  req.method = init.method ?? "GET";
  req.url = path;
  req.headers = { host: "localhost", ...init.headers };
  if (init.body) req.headers["content-length"] = String(Buffer.byteLength(init.body));
  req.rawHeaders = Object.entries(req.headers).flatMap(([k, v]) => [k, String(v)]);
  const res = new ServerResponse(req);
  res.assignSocket(socket as Socket);
  const response = new Promise<{ status: number; json: () => Promise<any> }>((resolve) => {
    res.once("finish", () => {
      resolve({ status: res.statusCode, json: async () => {
        const raw = wire.slice(wire.indexOf("\r\n\r\n") + 4);
        // Node uses chunked encoding when the transport has not supplied a length.
        const body = res.getHeader("content-length") ? raw : raw.replace(/^[\da-f]+\r\n/i, "").replace(/\r\n0\r\n\r\n$/, "");
        return JSON.parse(body);
      } });
      res.emit("close");
    });
  });
  app.emit("request", req, res);
  if (init.body) req.push(Buffer.from(init.body));
  req.complete = true;
  req.push(null);
  return { response, disconnect: () => { res.emit("close"); socket.destroy(); } };
}
