import { equal, match } from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const decoder = new TextDecoder();
async function run(args: string[]) {
  const output = await new Deno.Command(args[0], {
    args: args.slice(1),
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
    signal: AbortSignal.timeout(60_000),
  }).output();
  return {
    code: output.code,
    text: decoder.decode(output.stdout),
    error: decoder.decode(output.stderr),
  };
}

Deno.test("nginx redirects HTTP, routes sessions and consent, and excludes URL credentials from logs", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const directory = await Deno.makeTempDir({
    prefix: "mycelia-nginx-contract-",
  });
  const name = `mycelia-nginx-contract-${crypto.randomUUID()}`;
  let created = false;
  try {
    await Deno.mkdir(join(directory, "templates"));
    await Deno.mkdir(join(directory, "ssl"));
    const source = await Deno.readTextFile(
      join(root, "misc/nginx/templates/site.conf.template"),
    );
    // Internal stub upstreams avoid DNS/network access. All routing/header/logging
    // directives and the real entrypoint remain under test.
    await Deno.writeTextFile(
      join(directory, "templates/site.conf.template"),
      source
        .replace("http://frontend:8080", "http://127.0.0.1:8080")
        .replace("http://backend:5173", "http://127.0.0.1:5173"),
    );
    await Deno.writeTextFile(
      join(directory, "templates/stubs.conf.template"),
      'server { listen 8080; access_log off; location / { return 200 "frontend:$request_method"; } }\n' +
        'server { listen 5173; access_log off; location / { return 200 "backend:$request_method:$http_host:$http_x_forwarded_proto"; } }\n',
    );
    const certificate = await run([
      "openssl",
      "req",
      "-x509",
      "-nodes",
      "-days",
      "1",
      "-newkey",
      "rsa:2048",
      "-keyout",
      join(directory, "ssl/privkey.pem"),
      "-out",
      join(directory, "ssl/fullchain.pem"),
      "-subj",
      "/CN=localhost",
    ]);
    equal(certificate.code, 0, "Synthetic certificate generation failed");
    const launch = await run([
      "docker",
      "run",
      "--detach",
      "--name",
      name,
      "--network",
      "none",
      "--memory",
      "128m",
      "--cpus",
      "1",
      "--pids-limit",
      "64",
      "--env",
      "APP_MODE=prod",
      "--env",
      "NGINX_RESOLVER=127.0.0.1",
      "--env",
      "NGINX_HTTPS_PORT=4433",
      "--volume",
      `${directory}/templates:/etc/nginx/templates:ro`,
      "--volume",
      `${directory}/ssl:/etc/nginx/ssl:ro`,
      "--volume",
      `${root}misc/nginx/nginx-entrypoint.sh:/wrapper.sh:ro`,
      "--entrypoint",
      "/bin/sh",
      "nginx:1.27-alpine",
      "/wrapper.sh",
      "nginx",
      "-g",
      "daemon off;",
    ]);
    equal(launch.code, 0, "Isolated nginx failed to start");
    created = true;
    const request = (...args: string[]) =>
      run([
        "docker",
        "exec",
        name,
        "wget",
        "--no-check-certificate",
        "-q",
        "-O",
        "-",
        ...args,
      ]);
    let session = await request("https://127.0.0.1:4433/auth/session");
    for (let attempt = 0; session.code && attempt < 20; attempt++) {
      await new Promise((done) => setTimeout(done, 100));
      session = await request("https://127.0.0.1:4433/auth/session");
    }
    equal(session.code, 0, "Isolated nginx did not become ready");
    equal(session.text, "backend:GET:127.0.0.1:4433:https");
    equal(
      (await request("https://127.0.0.1/oauth/consent")).text,
      "frontend:GET",
    );
    match(
      (await request("--post-data=fixture", "https://127.0.0.1/oauth/consent"))
        .text,
      /^backend:POST:/,
    );
    const redirect = await request(
      "-S",
      "http://127.0.0.1/api/ping?token=SYNTHETIC_URL_CANARY",
    );
    equal(redirect.code, 0);
    match(redirect.error, /308/);
    match(
      redirect.error,
      /[Ll]ocation: https:\/\/127\.0\.0\.1:4433\/api\/ping/,
    );
    match(redirect.error, /X-Content-Type-Options: nosniff/i);
    const ipv6 = await request("-S", "http://[::1]/api/ping");
    equal(ipv6.code, 0, "IPv6 redirect must reach the HTTPS application");
    match(ipv6.error, /308/);
    match(ipv6.text, /^backend:GET:/);
    const localhost = await request("-S", "http://localhost/api/ping");
    equal(localhost.code, 0);
    match(localhost.error, /308/);
    match(localhost.text, /^backend:GET:/);
    const logs = await run(["docker", "logs", name]);
    equal((logs.text + logs.error).includes("SYNTHETIC_URL_CANARY"), false);
  } finally {
    if (created) await run(["docker", "rm", "--force", name]);
    await Deno.remove(directory, { recursive: true });
  }
});
