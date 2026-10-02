function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const decoder = new TextDecoder();
const helperSource = new URL("./keychain-helper.swift", import.meta.url);
const helperTests = new URL("./keychain-helper.test.swift", import.meta.url);

async function run(
  command: string,
  args: string[],
  env?: Record<string, string>,
): Promise<Deno.CommandOutput> {
  return await new Deno.Command(command, {
    args,
    clearEnv: true,
    env: env ?? { PATH: "/usr/bin:/bin" },
    stdout: "piped",
    stderr: "piped",
  }).output();
}

Deno.test("the production helper typechecks and its fake-backed contract passes", async () => {
  const sourcePath = helperSource.pathname;
  const testPath = helperTests.pathname;
  const directory = await Deno.makeTempDir();
  const binaryPath = `${directory}/keychain-helper-tests`;
  const productionBinaryPath = `${directory}/keychain-helper`;
  const moduleCachePath = `${directory}/module-cache`;

  try {
    const typecheck = await run("/usr/bin/swiftc", [
      "-module-cache-path",
      moduleCachePath,
      "-typecheck",
      sourcePath,
    ]);
    assert(
      typecheck.success,
      `production helper did not typecheck:\n${
        decoder.decode(typecheck.stderr)
      }`,
    );

    const productionCompile = await run("/usr/bin/swiftc", [
      "-module-cache-path",
      moduleCachePath,
      "-parse-as-library",
      sourcePath,
      "-o",
      productionBinaryPath,
    ]);
    assert(
      productionCompile.success,
      `production helper did not compile:\n${
        decoder.decode(productionCompile.stderr)
      }`,
    );

    const compile = await run("/usr/bin/swiftc", [
      "-module-cache-path",
      moduleCachePath,
      "-D",
      "KEYCHAIN_HELPER_TESTING",
      "-parse-as-library",
      sourcePath,
      testPath,
      "-o",
      binaryPath,
    ]);
    assert(
      compile.success,
      `fake-backed helper tests did not compile:\n${
        decoder.decode(compile.stderr)
      }`,
    );

    const fakeTests = await run(binaryPath, []);
    const fakeStdout = decoder.decode(fakeTests.stdout).trim();
    assert(
      fakeTests.success,
      `fake-backed helper tests failed:\n${decoder.decode(fakeTests.stderr)}`,
    );
    assert(
      fakeStdout === '{"failed":0,"passed":10}',
      `unexpected fake-backed test summary: ${fakeStdout}`,
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("the production source contains only the reviewed Security operations", async () => {
  const source = await Deno.readTextFile(helperSource);
  const required = [
    "SecKeychainCopyDefault",
    "SecKeychainGetPath",
    "SecKeychainOpen",
    "SecItemCopyMatching",
    "kSecMatchSearchList",
    "kSecMatchLimitAll",
    "SecRandomCopyBytes",
    "SecTrustedApplicationCreateFromPath",
    "SecAccessCreate",
    "SecItemAdd",
    "kSecUseKeychain",
    '"/usr/bin/security"',
  ];
  for (const symbol of required) {
    assert(source.includes(symbol), `missing reviewed operation: ${symbol}`);
  }

  const forbidden = [
    "SecItemUpdate",
    "SecItemDelete",
    "kSecReturnData",
    "kSecAttrSynchronizable",
    "kSecUseDataProtectionKeychain",
    "kSecAttrAccessible",
    "kSecAttrAccessGroup",
    "SecTrustedApplicationCreateFromPath(nil",
    '"/usr/bin/swift"',
    '"/usr/bin/swiftc"',
  ];
  for (const symbol of forbidden) {
    assert(!source.includes(symbol), `forbidden operation present: ${symbol}`);
  }
});
