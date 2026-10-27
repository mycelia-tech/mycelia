import { strict as assert } from "node:assert";
import { Buffer } from "node:buffer";
import { once } from "node:events";
import { type ClientRequest, createServer, request } from "node:http";
import { deflateSync, gzipSync } from "node:zlib";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { createBodyParsers } from "./body-parsers.ts";

// A disposable loopback app tests only middleware, using synthetic data and
// deliberately small limits. It imports no application startup or databases.
const app = express();
app.use(createBodyParsers({ limit: 128, parameterLimit: 4 }));
app.use((req: Request, res: Response, _next: NextFunction) => {
  if (req.url === "/health") {
    res.status(200).end("alive");
    return;
  }
  if (req.headers.authorization !== "Bearer synthetic") {
    res.status(401).end("unauthorized");
  } else {
    res.json(req.body);
  }
});
app.use((
  _error: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
) => {
  // Parser errors must not reach the application's generic error logger.
  // A fixed sentinel fails the parent assertion without logging request data.
  console.error("Unexpected middleware error reached fallback");
  res.status(500).end("unexpected middleware error");
});
const server = createServer(app);
server.requestTimeout = 3_000;
server.headersTimeout = 3_000;
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert.ok(address && typeof address !== "string");
const port = address.port;

async function send(
  body: Uint8Array,
  headers: Record<string, string>,
  path = "/echo",
): Promise<{ status: number; body: string }> {
  let client: ClientRequest;
  const response = new Promise<{ status: number; body: string }>(
    (resolve, reject) => {
      client = request({
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        agent: false,
        headers: { ...headers, "Content-Length": String(body.length) },
      }, (res) => {
        let result = "";
        res.setEncoding("utf8");
        res.on("data", (data: string) => result += data);
        res.on("error", reject);
        res.on(
          "end",
          () => resolve({ status: res.statusCode ?? 0, body: result }),
        );
      });
      client.on("error", reject);
    },
  );
  const deadline = setTimeout(
    () => client.destroy(new Error("HTTP parser request exceeded 3 seconds")),
    3_000,
  );
  try {
    client!.end(body);
    return await response;
  } finally {
    clearTimeout(deadline);
    client!.destroy();
  }
}

try {
  const scenario = Deno.args[0];
  const json = '{"message":"synthetic"}';
  const form = "message=synthetic&nested[value]=yes";
  const privateMarker = "synthetic-private-marker";
  const rejectedBody = JSON.stringify({
    success: false,
    error: "Invalid request body",
  });
  if (scenario === "compatible") {
    for (
      const [encoding, encode] of [
        ["identity", (value: string) => Buffer.from(value)],
        ["gzip", gzipSync],
        ["deflate", deflateSync],
      ] as const
    ) {
      const result = await send(encode(json), {
        "Content-Type": "application/json",
        "Content-Encoding": encoding,
        Authorization: "Bearer synthetic",
      });
      assert.equal(result.status, 200);
      assert.deepEqual(JSON.parse(result.body), { message: "synthetic" });
      const formResult = await send(encode(form), {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Encoding": encoding,
        Authorization: "Bearer synthetic",
      });
      assert.equal(formResult.status, 200);
      assert.deepEqual(JSON.parse(formResult.body), {
        message: "synthetic",
        nested: { value: "yes" },
      });
    }
    const unauthenticated = await send(Buffer.from(json), {
      "Content-Type": "application/json",
    });
    assert.equal(unauthenticated.status, 401);
  } else if (scenario === "malformed-json") {
    const result = await send(Buffer.from(`{"token":"${privateMarker}",`), {
      "Content-Type": "application/json",
      Authorization: `Bearer ${privateMarker}`,
    });
    assert.equal(result.status, 400);
    assert.equal(result.body, rejectedBody);
  } else if (scenario === "body-size") {
    const result = await send(
      Buffer.from(JSON.stringify({ message: privateMarker.repeat(8) })),
      {
        "Content-Type": "application/json",
        Authorization: `Bearer ${privateMarker}`,
      },
    );
    assert.equal(result.status, 413);
    assert.equal(result.body, rejectedBody);
  } else if (scenario === "form-parameters") {
    const result = await send(Buffer.from("a=1&b=2&c=3&d=4&e=5"), {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Bearer ${privateMarker}`,
    });
    assert.equal(result.status, 413);
    assert.equal(result.body, rejectedBody);
  } else if (scenario === "unsupported-encoding") {
    const result = await send(Buffer.from(json), {
      "Content-Type": "application/json",
      "Content-Encoding": "compress",
      Authorization: `Bearer ${privateMarker}`,
    });
    assert.equal(result.status, 415);
    assert.equal(result.body, rejectedBody);
  } else if (scenario === "unsupported-charset") {
    const result = await send(Buffer.from(json), {
      "Content-Type": "application/json; charset=unsupported",
      Authorization: `Bearer ${privateMarker}`,
    });
    assert.equal(result.status, 415);
    assert.equal(result.body, rejectedBody);
  } else {
    throw new Error(`Unknown parser test scenario: ${scenario}`);
  }
  const health = await send(new Uint8Array(), {}, "/health");
  assert.deepEqual(health, { status: 200, body: "alive" });
  console.log("PASS");
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve())
  );
}
