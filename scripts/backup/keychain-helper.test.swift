import Foundation

private let account = "mycelia-backup"
private let service = "tech.mycelia.backup"
private let installationID = "11111111-1111-4111-8111-111111111111"
private let generationID = "22222222-2222-4222-8222-222222222222"
private let keychainPath = "/Users/test/Library/Keychains/login.keychain-db"

private func credentialInput(
  extra: String = "",
  accountValue: String = account,
  serviceValue: String = service,
  label: String? = nil,
  path: String = keychainPath
) -> Data {
  let effectiveLabel = label ?? serviceValue
  return Data(
    """
    {"schema":1,"account":"\(accountValue)","service":"\(serviceValue)","label":"\(effectiveLabel)","installationId":"\(installationID)","credentialGenerationId":"\(generationID)","keychainPath":"\(path)"\(extra)}
    """.utf8
  )
}

private func object(_ output: Data) throws -> [String: Any] {
  guard let value = try JSONSerialization.jsonObject(with: output) as? [String: Any] else {
    throw TestFailure("output was not a JSON object")
  }
  return value
}

private func string(_ value: Any?) -> String? {
  value as? String
}

private func integer(_ value: Any?) -> Int? {
  (value as? NSNumber)?.intValue
}

private struct TestFailure: Error, CustomStringConvertible {
  let description: String

  init(_ description: String) {
    self.description = description
  }
}

private func expect(_ condition: @autoclosure () -> Bool, _ message: String) throws {
  if !condition() { throw TestFailure(message) }
}

private final class FakeRandomSource: RandomByteSource {
  var bytesToReturn = Array(UInt8(0)...UInt8(31))
  var error: Error?
  var beforeRead: (() throws -> Void)?
  private(set) var requestedCounts: [Int] = []

  func bytes(count: Int) throws -> [UInt8] {
    try beforeRead?()
    requestedCounts.append(count)
    if let error { throw error }
    return bytesToReturn
  }
}

private final class FakeKeychainAdapter: KeychainAdapter {
  var resolvedPath = keychainPath
  var inspection = InspectionSnapshot(
    broadPersistentReferences: [],
    exactPersistentReferences: []
  )
  var persistentReference: Data? = Data("create-ref".utf8)
  var resolveError: Error?
  var inspectError: Error?
  var validationError: Error?
  var createError: Error?
  private(set) var inspectionRequests: [InspectionRequest] = []
  private(set) var validatedCreatePaths: [String] = []
  private(set) var creationRequests: [CreationRequest] = []

  func resolveDefaultKeychainPath() throws -> String {
    if let resolveError { throw resolveError }
    return resolvedPath
  }

  func inspect(_ request: InspectionRequest) throws -> InspectionSnapshot {
    inspectionRequests.append(request)
    if let inspectError { throw inspectError }
    return inspection
  }

  func validateCreateTarget(_ expectedPath: String) throws {
    validatedCreatePaths.append(expectedPath)
    if let validationError { throw validationError }
  }

  func create(_ request: CreationRequest) throws -> Data? {
    creationRequests.append(request)
    if let createError { throw createError }
    return persistentReference
  }
}

private func run(
  _ mode: String,
  _ input: Data,
  adapter: FakeKeychainAdapter = FakeKeychainAdapter(),
  random: FakeRandomSource = FakeRandomSource()
) -> HelperExecution {
  KeychainHelper(adapter: adapter, random: random).run(
    arguments: [mode],
    input: input
  )
}

private func testResolveDefaultProtocol() throws {
  let adapter = FakeKeychainAdapter()
  let result = run("resolve-default", Data(#"{"schema":1}"#.utf8), adapter: adapter)
  let json = try object(result.output)
  try expect(result.exitCode == 0, "resolve-default should succeed")
  try expect(Set(json.keys) == ["schema", "keychainPath"], "resolve response was not closed")
  try expect(integer(json["schema"]) == 1, "resolve schema mismatch")
  try expect(string(json["keychainPath"]) == keychainPath, "resolved path mismatch")
}

private func testInputAndArgvAreClosed() throws {
  let invalid: [([String], Data)] = [
    ([], Data(#"{"schema":1}"#.utf8)),
    (["inspect", "extra"], credentialInput()),
    (["unknown"], credentialInput()),
    (["resolve-default"], Data(#"{"schema":1,"account":"reflected"}"#.utf8)),
    (["inspect"], credentialInput(extra: ",\"password\":\"never\"")),
    (["inspect"], credentialInput(label: "wrong-label")),
    (["inspect"], credentialInput(accountValue: "bad account")),
    (["inspect"], credentialInput(serviceValue: "bad/service")),
    (["inspect"], credentialInput(accountValue: "@bad")),
    (["inspect"], credentialInput(path: "relative.keychain")),
    (["inspect"], Data("{\"schema\":1,\"schema\":1}".utf8)),
    (["inspect"], Data(repeating: UInt8(ascii: "x"), count: 4_097)),
  ]
  for (arguments, input) in invalid {
    let result = KeychainHelper(
      adapter: FakeKeychainAdapter(),
      random: FakeRandomSource()
    ).run(arguments: arguments, input: input)
    let json = try object(result.output)
    try expect(result.exitCode == 64, "invalid invocation must use EX_USAGE")
    try expect(
      Set(json.keys) == ["schema", "code"],
      "invalid response must not reflect input"
    )
    try expect(string(json["code"]) == "KEYCHAIN_INPUT_INVALID", "invalid code mismatch")
    try expect(
      !String(decoding: result.output, as: UTF8.self).contains("reflected"), "input leaked")
  }
}

private func testInspectBuildsExactMetadataQueries() throws {
  let adapter = FakeKeychainAdapter()
  adapter.inspection = InspectionSnapshot(
    broadPersistentReferences: [Data("persistent-ref-1".utf8)],
    exactPersistentReferences: [Data("persistent-ref-1".utf8)]
  )
  let result = run("inspect", credentialInput(), adapter: adapter)
  let json = try object(result.output)
  try expect(result.exitCode == 0, "exact inspection should succeed")
  try expect(
    Set(json.keys) == ["schema", "broadCount", "exactCount", "itemPersistentRefSha256"],
    "inspect response was not closed"
  )
  try expect(integer(json["broadCount"]) == 1, "broad count mismatch")
  try expect(integer(json["exactCount"]) == 1, "exact count mismatch")
  try expect(
    string(json["itemPersistentRefSha256"])
      == "42ad858a237112368b6593aa4ad37d5fe2c6fca16bf4992d3ce7e97f964602e3",
    "persistent reference hash mismatch"
  )
  try expect(adapter.inspectionRequests.count == 1, "inspect call count mismatch")
  let request = try unwrap(adapter.inspectionRequests.first, "missing inspection request")
  try expect(request.broad.keychainPath == keychainPath, "broad keychain path mismatch")
  try expect(request.exact.keychainPath == keychainPath, "exact keychain path mismatch")
  try expect(
    request.broad.attributes == [
      .account: .string(account),
      .service: .string(service),
    ],
    "broad selector must contain account/service only"
  )
  try expect(
    request.exact.attributes == [
      .account: .string(account),
      .service: .string(service),
      .label: .string(service),
      .generic: .data(Data(generationID.utf8)),
      .comment: .string(installationID),
    ],
    "exact selector attributes mismatch"
  )
  for query in [request.broad, request.exact] {
    try expect(query.matchSearchListOnly, "query must pin kSecMatchSearchList")
    try expect(query.matchLimitAll, "query must use kSecMatchLimitAll")
    try expect(query.returnPersistentReferences, "query must request persistent refs")
    try expect(!query.returnData, "metadata query requested secret data")
    try expect(!query.useKeychain, "metadata query used kSecUseKeychain")
  }
}

private func testInspectMissingForeignAndAmbiguousMappings() throws {
  let cases: [(Int, Int, String)] = [
    (0, 0, "KEYCHAIN_ITEM_MISSING"),
    (1, 0, "KEYCHAIN_ITEM_AMBIGUOUS"),
    (2, 1, "KEYCHAIN_ITEM_AMBIGUOUS"),
    (2, 2, "KEYCHAIN_ITEM_AMBIGUOUS"),
    (0, 1, "KEYCHAIN_ITEM_AMBIGUOUS"),
  ]
  for (broadCount, exactCount, code) in cases {
    let adapter = FakeKeychainAdapter()
    adapter.inspection = InspectionSnapshot(
      broadPersistentReferences: (0..<broadCount).map { Data("b\($0)".utf8) },
      exactPersistentReferences: (0..<exactCount).map { Data("e\($0)".utf8) }
    )
    let result = run("inspect", credentialInput(), adapter: adapter)
    let json = try object(result.output)
    try expect(result.exitCode == 1, "non-exact inspection must fail")
    try expect(
      Set(json.keys) == ["schema", "code", "broadCount", "exactCount"],
      "inspect failure response was not closed"
    )
    try expect(string(json["code"]) == code, "inspect failure code mismatch")
    try expect(integer(json["broadCount"]) == broadCount, "failure broad count mismatch")
    try expect(integer(json["exactCount"]) == exactCount, "failure exact count mismatch")
  }

  let raced = FakeKeychainAdapter()
  raced.inspection = InspectionSnapshot(
    broadPersistentReferences: [Data("broad-ref".utf8)],
    exactPersistentReferences: [Data("exact-ref".utf8)]
  )
  let racedResult = run("inspect", credentialInput(), adapter: raced)
  let racedJSON = try object(racedResult.output)
  try expect(racedResult.exitCode == 1, "mismatched query refs must fail")
  try expect(
    string(racedJSON["code"]) == "KEYCHAIN_ITEM_AMBIGUOUS",
    "mismatched query refs must be ambiguous"
  )
}

private func testCreateBuildsExactAttributesAndDoesNotReturnSecret() throws {
  let adapter = FakeKeychainAdapter()
  let random = FakeRandomSource()
  random.beforeRead = {
    try expect(
      adapter.validatedCreatePaths == [keychainPath],
      "create target must be validated before RNG"
    )
  }
  let result = run("create", credentialInput(), adapter: adapter, random: random)
  let json = try object(result.output)
  try expect(result.exitCode == 0, "create should succeed")
  try expect(Set(json.keys) == ["schema", "created"], "create response was not closed")
  try expect(json["created"] as? Bool == true, "create confirmation missing")
  try expect(random.requestedCounts == [32], "create must request exactly 32 random bytes")
  try expect(adapter.validatedCreatePaths == [keychainPath], "create target validation mismatch")
  try expect(adapter.creationRequests.count == 1, "create call count mismatch")
  let request = try unwrap(adapter.creationRequests.first, "missing creation request")
  try expect(request.keychainPath == keychainPath, "create keychain mismatch")
  try expect(request.itemClass == .genericPassword, "wrong item class")
  try expect(request.account == account, "create account mismatch")
  try expect(request.service == service, "create service mismatch")
  try expect(request.label == service, "create label mismatch")
  try expect(request.generic == Data(generationID.utf8), "generation metadata mismatch")
  try expect(request.comment == installationID, "installation metadata mismatch")
  let expectedPassword = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
  try expect(request.valueData == Data(expectedPassword.utf8), "hex password encoding mismatch")
  try expect(request.useKeychainForAdd, "create must use captured keychain")
  try expect(request.returnPersistentReference, "create must request a persistent ref")
  try expect(
    request.trustedApplicationPaths == ["/usr/bin/security"],
    "ACL trust list must contain only /usr/bin/security"
  )
  try expect(
    !String(decoding: result.output, as: UTF8.self).contains(expectedPassword),
    "create response leaked password bytes"
  )
}

private func testCreateProvenanceFailurePrecedesRNG() throws {
  let adapter = FakeKeychainAdapter()
  adapter.validationError = KeychainAdapterError.provenanceMismatch
  let random = FakeRandomSource()
  let result = run("create", credentialInput(), adapter: adapter, random: random)
  let json = try object(result.output)
  try expect(result.exitCode == 1, "provenance mismatch must fail")
  try expect(
    string(json["code"]) == "KEYCHAIN_PROVENANCE_MISMATCH",
    "provenance mismatch code mismatch"
  )
  try expect(random.requestedCounts.isEmpty, "RNG ran before provenance validation")
  try expect(adapter.creationRequests.isEmpty, "provenance mismatch reached add")
}

private func testCreateRejectsWrongRandomLengthWithoutCallingKeychain() throws {
  let adapter = FakeKeychainAdapter()
  let random = FakeRandomSource()
  random.bytesToReturn = [1, 2, 3]
  let result = run("create", credentialInput(), adapter: adapter, random: random)
  let json = try object(result.output)
  try expect(result.exitCode == 1, "short RNG output must fail")
  try expect(string(json["code"]) == "KEYCHAIN_RNG_FAILED", "RNG code mismatch")
  try expect(adapter.creationRequests.isEmpty, "short RNG output reached Keychain")
}

private func testCreateStatusMapping() throws {
  let cases: [(Int32, String)] = [
    (-25_299, "KEYCHAIN_DUPLICATE_ITEM"),
    (-128, "KEYCHAIN_CANCELLED"),
    (-25_291, "KEYCHAIN_UNAVAILABLE"),
    (-25_293, "KEYCHAIN_UNAVAILABLE"),
    (-25_294, "KEYCHAIN_UNAVAILABLE"),
    (-25_308, "KEYCHAIN_UNAVAILABLE"),
    (-9_999, "KEYCHAIN_CREATE_FAILED"),
  ]
  for (status, code) in cases {
    let adapter = FakeKeychainAdapter()
    adapter.createError = KeychainAdapterError.status(status)
    let result = run("create", credentialInput(), adapter: adapter)
    let json = try object(result.output)
    try expect(result.exitCode == 1, "create status must fail")
    try expect(string(json["code"]) == code, "status \(status) mapped incorrectly")
    try expect(Set(json.keys) == ["schema", "code"], "status response leaked details")
  }
}

private func testSafeNonStatusMappings() throws {
  let mappings: [(KeychainAdapterError, String, String)] = [
    (.provenanceMismatch, "inspect", "KEYCHAIN_PROVENANCE_MISMATCH"),
    (.provenanceMismatch, "create", "KEYCHAIN_PROVENANCE_MISMATCH"),
    (.unavailable, "inspect", "KEYCHAIN_UNAVAILABLE"),
  ]
  for (error, mode, code) in mappings {
    let adapter = FakeKeychainAdapter()
    if mode == "inspect" { adapter.inspectError = error } else { adapter.createError = error }
    let result = run(mode, credentialInput(), adapter: adapter)
    let json = try object(result.output)
    try expect(result.exitCode == 1, "adapter error must fail")
    try expect(string(json["code"]) == code, "adapter error mapped incorrectly")
    try expect(Set(json.keys) == ["schema", "code"], "adapter error leaked details")
  }
}

private func testSuccessfulAddWithoutPersistentReferenceIsAmbiguous() throws {
  let adapter = FakeKeychainAdapter()
  adapter.persistentReference = nil
  let result = run("create", credentialInput(), adapter: adapter)
  let json = try object(result.output)
  try expect(result.exitCode == 1, "missing add result must fail")
  try expect(
    string(json["code"]) == "KEYCHAIN_CREATE_AMBIGUOUS",
    "missing add result must be ambiguous"
  )
}

private func unwrap<T>(_ value: T?, _ message: String) throws -> T {
  guard let value else { throw TestFailure(message) }
  return value
}

@main
private struct KeychainHelperFakeTests {
  static func main() {
    let tests: [(String, () throws -> Void)] = [
      ("resolve-default protocol", testResolveDefaultProtocol),
      ("closed input and argv", testInputAndArgvAreClosed),
      ("inspect exact queries", testInspectBuildsExactMetadataQueries),
      ("inspect safe mappings", testInspectMissingForeignAndAmbiguousMappings),
      ("create exact attributes", testCreateBuildsExactAttributesAndDoesNotReturnSecret),
      ("create validates before RNG", testCreateProvenanceFailurePrecedesRNG),
      ("create rejects short RNG", testCreateRejectsWrongRandomLengthWithoutCallingKeychain),
      ("create status mapping", testCreateStatusMapping),
      ("safe non-status mapping", testSafeNonStatusMappings),
      ("create ambiguous result", testSuccessfulAddWithoutPersistentReferenceIsAmbiguous),
    ]
    var passed = 0
    var failed = 0
    for (name, test) in tests {
      do {
        try test()
        passed += 1
      } catch {
        failed += 1
        FileHandle.standardError.write(Data("FAIL \(name)\n".utf8))
      }
    }
    FileHandle.standardOutput.write(Data("{\"failed\":\(failed),\"passed\":\(passed)}\n".utf8))
    if failed != 0 { Foundation.exit(1) }
  }
}
