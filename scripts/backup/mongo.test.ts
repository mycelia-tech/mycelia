import { runInNewContext } from "node:vm";
import { readMongoSourcePaths } from "./mongo.ts";
import type { Runner } from "./types.ts";

function assert(value: unknown, message = "assertion failed"): asserts value {
  if (!value) throw new Error(message);
}

// Docker is the only external boundary; execute the actual submitted JavaScript
// against a database double so auth ordering, projection, and filtering matter.
function mongoRunner(options: {
  auth?: boolean;
  authFails?: boolean;
  records?: unknown[];
  output?: string;
  code?: number;
  timedOut?: boolean;
}) {
  let calls = 0;
  let authenticated = false;
  const runner: Runner = {
    run() {
      throw new Error("expected streamed script");
    },
    spawn(argv) {
      calls++;
      assert(
        JSON.stringify(argv) === JSON.stringify([
          "docker",
          "compose",
          "--project-directory",
          "/compose root",
          "exec",
          "-T",
          "mongo",
          "mongosh",
          "--quiet",
          "--norc",
          "app_db",
          "--file",
          "/dev/stdin",
        ]),
        "unexpected argv or leaked credential",
      );
      let script = "";
      let finish!: (value: {
        code: number;
        timedOut: boolean;
        terminationConfirmed: true;
        forcedKill: false;
      }) => void;
      let out!: ReadableStreamDefaultController<Uint8Array>;
      let err!: ReadableStreamDefaultController<Uint8Array>;
      const status = new Promise<{
        code: number;
        timedOut: boolean;
        terminationConfirmed: true;
        forcedKill: false;
      }>(
        (resolve) => {
          finish = resolve;
        },
      );
      return {
        stdin: new WritableStream({
          write(bytes) {
            script += new TextDecoder().decode(bytes);
          },
          close() {
            const lines: string[] = [];
            const docs = options.records ??
              [
                { _id: { $oid: "0123456789abcdef01234567" }, path: "/media/a" },
                { _id: "metadata" },
              ];
            let code = options.code ?? 0;
            try {
              runInNewContext(script, {
                process: {
                  env: {
                    MONGO_INITDB_ROOT_USERNAME: "secret-user",
                    MONGO_INITDB_ROOT_PASSWORD: "secret-password",
                  },
                },
                db: {
                  getSiblingDB(name: string) {
                    assert(name === "admin");
                    return {
                      auth(user: string, password: string) {
                        assert(
                          user === "secret-user" &&
                            password === "secret-password",
                        );
                        if (options.authFails) {
                          throw new Error("secret-password");
                        }
                        authenticated = true;
                        return { ok: 1 };
                      },
                    };
                  },
                  getCollection(name: string) {
                    assert(name === "source_files");
                    assert(!options.auth || authenticated, "query before auth");
                    const filtered = docs.filter((doc) =>
                      doc !== null && typeof doc === "object" &&
                      Object.hasOwn(doc, "path")
                    );
                    const query = (filter: unknown) => {
                      assert(
                        JSON.stringify(filter) === '{"path":{"$exists":true}}',
                      );
                    };
                    return {
                      countDocuments(filter: unknown) {
                        query(filter);
                        return filtered.length;
                      },
                      find(filter: unknown, projection: unknown) {
                        query(filter);
                        assert(
                          JSON.stringify(projection) === '{"_id":1,"path":1}',
                        );
                        return {
                          forEach(fn: (record: unknown) => void) {
                            filtered.forEach(fn);
                          },
                        };
                      },
                    };
                  },
                },
                print(line: string) {
                  lines.push(line);
                },
                EJSON: { stringify: JSON.stringify },
                quit(value: number) {
                  throw new Error(String(value));
                },
              });
            } catch {
              code = 1;
            }
            out.enqueue(
              new TextEncoder().encode(
                options.output ?? lines.join("\n") + "\n",
              ),
            );
            out.close();
            err.close();
            finish({
              code,
              timedOut: options.timedOut ?? false,
              terminationConfirmed: true,
              forcedKill: false,
            });
          },
        }),
        stdout: new ReadableStream({
          start(controller) {
            out = controller;
          },
        }),
        stderr: new ReadableStream({
          start(controller) {
            err = controller;
          },
        }),
        status,
        kill() {},
      };
    },
  };
  return { runner, calls: () => calls, authenticated: () => authenticated };
}

Deno.test("Mongo filters external claims and authenticates only in explicit enabled mode", async () => {
  for (const authorization of ["enabled", "disabled"] as const) {
    const fake = mongoRunner({ auth: authorization === "enabled" });
    const result = await readMongoSourcePaths({
      composeRoot: "/compose root",
      databaseName: "app_db",
      authorization,
    }, fake.runner);
    assert(result.filteredCount === 1 && result.records.length === 1);
    assert(result.records[0].path === "/media/a");
    assert(fake.authenticated() === (authorization === "enabled"));
    assert(fake.calls() === 1);
  }
});

Deno.test("Mongo rejects malformed claims, missing count, mismatched count and command failure with closed errors", async () => {
  const badOutputs = [
    "",
    "not json",
    '{"type":"count","count":1}\n',
    '{"type":"count","count":0}\n{"_id":"a","path":"/a"}',
    ...[{}, { _id: "a" }, { _id: "a", path: null }, { _id: "a", path: "  " }, {
      path: "/a",
    }].map((doc) => '{"type":"count","count":1}\n' + JSON.stringify(doc)),
    '{"type":"count","count":2}\n{"_id":"a","path":"/a"}\n{"_id":"a","path":"/b"}',
  ];
  for (
    const options of [
      ...badOutputs.map((output) => ({ output })),
      { code: 2 },
      { timedOut: true },
      { auth: true, authFails: true },
    ]
  ) {
    const fake = mongoRunner(options);
    let caught: unknown;
    try {
      await readMongoSourcePaths({
        composeRoot: "/compose root",
        databaseName: "app_db",
        authorization: "enabled",
      }, fake.runner);
    } catch (error) {
      caught = error;
    }
    assert(
      caught instanceof Error &&
        caught.message === "SOURCE_COVERAGE_INCOMPLETE",
    );
    assert(fake.calls() === 1, "anonymous fallback attempted");
  }
});

Deno.test("Mongo confirms filtered zero and rejects invalid auth mode or URI before execution", async () => {
  const fake = mongoRunner({ records: [{ _id: "no-file" }] });
  const result = await readMongoSourcePaths({
    composeRoot: "/compose root",
    databaseName: "app_db",
    authorization: "disabled",
  }, fake.runner);
  assert(result.filteredCount === 0 && result.records.length === 0);
  for (
    const input of [
      {
        databaseName: "mongodb://secret:password@host",
        authorization: "disabled",
      },
      { databaseName: "app_db", authorization: undefined },
    ]
  ) {
    let caught = false;
    try {
      await readMongoSourcePaths(
        { composeRoot: "/compose root", ...input } as Parameters<
          typeof readMongoSourcePaths
        >[0],
        fake.runner,
      );
    } catch {
      caught = true;
    }
    assert(caught);
  }
  assert(fake.calls() === 1);
});
