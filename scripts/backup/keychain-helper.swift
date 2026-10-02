import CryptoKit
import Darwin
import Foundation
import Security

private enum KeychainHelperLimits {
  static let maximumInputBytes = 4_096
}

enum MetadataAttribute: Hashable {
  case account
  case service
  case label
  case generic
  case comment
}

enum MetadataValue: Equatable {
  case string(String)
  case data(Data)
}

struct MetadataQuery: Equatable {
  let keychainPath: String
  let attributes: [MetadataAttribute: MetadataValue]
  let matchSearchListOnly: Bool
  let matchLimitAll: Bool
  let returnPersistentReferences: Bool
  let returnData: Bool
  let useKeychain: Bool
}

struct InspectionRequest: Equatable {
  let broad: MetadataQuery
  let exact: MetadataQuery
}

struct InspectionSnapshot: Equatable {
  let broadPersistentReferences: [Data]
  let exactPersistentReferences: [Data]
}

enum KeychainItemClass: Equatable {
  case genericPassword
}

struct CreationRequest: Equatable {
  let keychainPath: String
  let itemClass: KeychainItemClass
  let account: String
  let service: String
  let label: String
  let generic: Data
  let comment: String
  let valueData: Data
  let useKeychainForAdd: Bool
  let returnPersistentReference: Bool
  let trustedApplicationPaths: [String]
}

enum KeychainAdapterError: Error, Equatable {
  case status(Int32)
  case provenanceMismatch
  case unavailable
  case ambiguousResult
}

protocol KeychainAdapter {
  func resolveDefaultKeychainPath() throws -> String
  func inspect(_ request: InspectionRequest) throws -> InspectionSnapshot
  func validateCreateTarget(_ expectedPath: String) throws
  func create(_ request: CreationRequest) throws -> Data?
}

protocol RandomByteSource {
  func bytes(count: Int) throws -> [UInt8]
}

struct HelperExecution {
  let output: Data
  let exitCode: Int32
}

private enum HelperMode: String {
  case resolveDefault = "resolve-default"
  case inspect
  case create
}

private struct CredentialIdentity {
  let account: String
  let service: String
  let label: String
  let installationID: String
  let credentialGenerationID: String
  let keychainPath: String
}

private enum InputFailure: Error {
  case invalid
}

private enum RandomFailure: Error {
  case failed
}

struct KeychainHelper {
  let adapter: any KeychainAdapter
  let random: any RandomByteSource

  func run(arguments: [String], input: Data) -> HelperExecution {
    guard
      arguments.count == 1,
      let rawMode = arguments.first,
      let mode = HelperMode(rawValue: rawMode),
      input.count <= KeychainHelperLimits.maximumInputBytes
    else {
      return failure(code: "KEYCHAIN_INPUT_INVALID", exitCode: 64)
    }

    do {
      switch mode {
      case .resolveDefault:
        try validateResolveInput(input)
        let path = try adapter.resolveDefaultKeychainPath()
        guard isLexicallyCanonicalAbsolutePath(path) else {
          throw KeychainAdapterError.provenanceMismatch
        }
        return success(["schema": 1, "keychainPath": path])

      case .inspect:
        let identity = try parseCredentialInput(input)
        let snapshot = try adapter.inspect(inspectionRequest(for: identity))
        return inspectResult(snapshot)

      case .create:
        let identity = try parseCredentialInput(input)
        try adapter.validateCreateTarget(identity.keychainPath)
        var entropy: [UInt8]
        do {
          entropy = try random.bytes(count: 32)
        } catch {
          throw RandomFailure.failed
        }
        guard entropy.count == 32 else {
          entropy.resetBytes(in: entropy.indices)
          throw RandomFailure.failed
        }
        defer { entropy.resetBytes(in: entropy.indices) }

        var encodedPassword = lowercaseHex(entropy)
        defer { encodedPassword.resetBytes(in: encodedPassword.indices) }
        let request = CreationRequest(
          keychainPath: identity.keychainPath,
          itemClass: .genericPassword,
          account: identity.account,
          service: identity.service,
          label: identity.label,
          generic: Data(identity.credentialGenerationID.utf8),
          comment: identity.installationID,
          valueData: Data(encodedPassword),
          useKeychainForAdd: true,
          returnPersistentReference: true,
          trustedApplicationPaths: ["/usr/bin/security"]
        )
        let persistentReference = try adapter.create(request)
        guard
          let persistentReference,
          !persistentReference.isEmpty,
          persistentReference.count <= 4_096
        else {
          return failure(code: "KEYCHAIN_CREATE_AMBIGUOUS")
        }
        return success(["schema": 1, "created": true])
      }
    } catch is InputFailure {
      return failure(code: "KEYCHAIN_INPUT_INVALID", exitCode: 64)
    } catch is RandomFailure {
      return failure(code: "KEYCHAIN_RNG_FAILED")
    } catch let error as KeychainAdapterError {
      return failure(code: safeCode(for: error, mode: mode))
    } catch {
      return failure(
        code: mode == .create ? "KEYCHAIN_CREATE_FAILED" : "KEYCHAIN_UNAVAILABLE"
      )
    }
  }

  private func inspectResult(_ snapshot: InspectionSnapshot) -> HelperExecution {
    let broadCount = snapshot.broadPersistentReferences.count
    let exactCount = snapshot.exactPersistentReferences.count
    let counts: [String: Any] = [
      "schema": 1,
      "broadCount": broadCount,
      "exactCount": exactCount,
    ]

    if broadCount == 0, exactCount == 0 {
      return failure(
        code: "KEYCHAIN_ITEM_MISSING",
        additionalFields: counts
      )
    }
    guard
      broadCount == 1,
      exactCount == 1,
      snapshot.broadPersistentReferences.first
        == snapshot.exactPersistentReferences.first,
      let reference = snapshot.exactPersistentReferences.first,
      !reference.isEmpty,
      reference.count <= 4_096
    else {
      return failure(
        code: "KEYCHAIN_ITEM_AMBIGUOUS",
        additionalFields: counts
      )
    }
    return success([
      "schema": 1,
      "broadCount": broadCount,
      "exactCount": exactCount,
      "itemPersistentRefSha256": sha256Hex(reference),
    ])
  }

  private func inspectionRequest(for identity: CredentialIdentity) -> InspectionRequest {
    let common = MetadataQuery(
      keychainPath: identity.keychainPath,
      attributes: [
        .account: .string(identity.account),
        .service: .string(identity.service),
      ],
      matchSearchListOnly: true,
      matchLimitAll: true,
      returnPersistentReferences: true,
      returnData: false,
      useKeychain: false
    )
    let exact = MetadataQuery(
      keychainPath: identity.keychainPath,
      attributes: [
        .account: .string(identity.account),
        .service: .string(identity.service),
        .label: .string(identity.label),
        .generic: .data(Data(identity.credentialGenerationID.utf8)),
        .comment: .string(identity.installationID),
      ],
      matchSearchListOnly: true,
      matchLimitAll: true,
      returnPersistentReferences: true,
      returnData: false,
      useKeychain: false
    )
    return InspectionRequest(broad: common, exact: exact)
  }

  private func safeCode(for error: KeychainAdapterError, mode: HelperMode) -> String {
    switch error {
    case .provenanceMismatch:
      return "KEYCHAIN_PROVENANCE_MISMATCH"
    case .unavailable:
      return "KEYCHAIN_UNAVAILABLE"
    case .ambiguousResult:
      return mode == .create ? "KEYCHAIN_CREATE_AMBIGUOUS" : "KEYCHAIN_ITEM_AMBIGUOUS"
    case .status(let status):
      if status == Int32(errSecDuplicateItem) {
        return "KEYCHAIN_DUPLICATE_ITEM"
      }
      if status == Int32(errSecUserCanceled) {
        return "KEYCHAIN_CANCELLED"
      }
      if [
        Int32(errSecNotAvailable),
        Int32(errSecAuthFailed),
        Int32(errSecNoSuchKeychain),
        Int32(errSecInteractionNotAllowed),
      ].contains(status) {
        return "KEYCHAIN_UNAVAILABLE"
      }
      return mode == .create ? "KEYCHAIN_CREATE_FAILED" : "KEYCHAIN_UNAVAILABLE"
    }
  }

  private func validateResolveInput(_ input: Data) throws {
    let value = try parseClosedObject(input)
    guard Set(value.keys) == ["schema"], schemaIsOne(value["schema"]) else {
      throw InputFailure.invalid
    }
  }

  private func parseCredentialInput(_ input: Data) throws -> CredentialIdentity {
    let value = try parseClosedObject(input)
    let expectedKeys: Set<String> = [
      "schema",
      "account",
      "service",
      "label",
      "installationId",
      "credentialGenerationId",
      "keychainPath",
    ]
    guard
      Set(value.keys) == expectedKeys,
      schemaIsOne(value["schema"]),
      let account = value["account"] as? String,
      let service = value["service"] as? String,
      let label = value["label"] as? String,
      let installationID = value["installationId"] as? String,
      let credentialGenerationID = value["credentialGenerationId"] as? String,
      let keychainPath = value["keychainPath"] as? String,
      isClosedIdentifier(account),
      isClosedIdentifier(service),
      label == service,
      isCanonicalUUID(installationID),
      isCanonicalUUID(credentialGenerationID),
      isLexicallyCanonicalAbsolutePath(keychainPath)
    else {
      throw InputFailure.invalid
    }
    return CredentialIdentity(
      account: account,
      service: service,
      label: label,
      installationID: installationID,
      credentialGenerationID: credentialGenerationID,
      keychainPath: keychainPath
    )
  }

  private func parseClosedObject(_ input: Data) throws -> [String: Any] {
    do {
      var scanner = TopLevelKeyScanner(input)
      let keys = try scanner.scan()
      guard Set(keys).count == keys.count else { throw InputFailure.invalid }
      guard
        let object = try JSONSerialization.jsonObject(with: input) as? [String: Any]
      else {
        throw InputFailure.invalid
      }
      return object
    } catch is InputFailure {
      throw InputFailure.invalid
    } catch {
      throw InputFailure.invalid
    }
  }

  private func schemaIsOne(_ value: Any?) -> Bool {
    guard let number = value as? NSNumber else { return false }
    guard CFGetTypeID(number) != CFBooleanGetTypeID() else { return false }
    return number.intValue == 1 && number.doubleValue == 1
  }

  private func isClosedIdentifier(_ value: String) -> Bool {
    let bytes = Array(value.utf8)
    guard !bytes.isEmpty, bytes.count <= 128, isASCIIAlphanumeric(bytes[0]) else {
      return false
    }
    return bytes.dropFirst().allSatisfy {
      isASCIIAlphanumeric($0) || [0x5f, 0x2e, 0x2d].contains($0)
    }
  }

  private func isASCIIAlphanumeric(_ byte: UInt8) -> Bool {
    (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x5a)
      || (byte >= 0x61 && byte <= 0x7a)
  }

  private func isCanonicalUUID(_ value: String) -> Bool {
    guard value.utf8.count == 36, let parsed = UUID(uuidString: value) else {
      return false
    }
    return parsed.uuidString.lowercased() == value
  }

  private func isLexicallyCanonicalAbsolutePath(_ value: String) -> Bool {
    guard
      value.hasPrefix("/"),
      value != "/",
      value.utf8.count <= 1_024,
      !value.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7f })
    else {
      return false
    }
    return (value as NSString).standardizingPath == value
  }

  private func lowercaseHex(_ bytes: [UInt8]) -> [UInt8] {
    let digits = Array("0123456789abcdef".utf8)
    var result: [UInt8] = []
    result.reserveCapacity(bytes.count * 2)
    for byte in bytes {
      result.append(digits[Int(byte >> 4)])
      result.append(digits[Int(byte & 0x0f)])
    }
    return result
  }

  private func sha256Hex(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
  }

  private func success(_ fields: [String: Any]) -> HelperExecution {
    HelperExecution(output: encodeJSON(fields), exitCode: 0)
  }

  private func failure(
    code: String,
    exitCode: Int32 = 1,
    additionalFields: [String: Any] = [:]
  ) -> HelperExecution {
    var fields = additionalFields
    fields["schema"] = 1
    fields["code"] = code
    return HelperExecution(output: encodeJSON(fields), exitCode: exitCode)
  }

  private func encodeJSON(_ fields: [String: Any]) -> Data {
    (try? JSONSerialization.data(
      withJSONObject: fields,
      options: [.sortedKeys, .withoutEscapingSlashes]
    )) ?? Data(#"{"code":"KEYCHAIN_UNAVAILABLE","schema":1}"#.utf8)
  }
}

private struct TopLevelKeyScanner {
  private let bytes: [UInt8]
  private var index = 0

  init(_ data: Data) {
    bytes = Array(data)
  }

  mutating func scan() throws -> [String] {
    skipWhitespace()
    try consume(0x7b)
    skipWhitespace()
    var keys: [String] = []
    if consumeIfPresent(0x7d) {
      skipWhitespace()
      guard index == bytes.count else { throw InputFailure.invalid }
      return keys
    }
    while true {
      let key = try parseString()
      keys.append(key)
      skipWhitespace()
      try consume(0x3a)
      skipWhitespace()
      try skipScalarValue()
      skipWhitespace()
      if consumeIfPresent(0x7d) { break }
      try consume(0x2c)
      skipWhitespace()
    }
    skipWhitespace()
    guard index == bytes.count else { throw InputFailure.invalid }
    return keys
  }

  private mutating func parseString() throws -> String {
    guard index < bytes.count, bytes[index] == 0x22 else {
      throw InputFailure.invalid
    }
    let start = index
    index += 1
    var escaped = false
    while index < bytes.count {
      let byte = bytes[index]
      index += 1
      if escaped {
        escaped = false
      } else if byte == 0x5c {
        escaped = true
      } else if byte == 0x22 {
        let token = Data(bytes[start..<index])
        let wrapped = Data([0x5b]) + token + Data([0x5d])
        guard
          let decoded = try? JSONSerialization.jsonObject(with: wrapped) as? [String],
          decoded.count == 1,
          let value = decoded.first
        else {
          throw InputFailure.invalid
        }
        return value
      } else if byte < 0x20 {
        throw InputFailure.invalid
      }
    }
    throw InputFailure.invalid
  }

  private mutating func skipScalarValue() throws {
    guard index < bytes.count else { throw InputFailure.invalid }
    if bytes[index] == 0x22 {
      _ = try parseString()
      return
    }
    let start = index
    while index < bytes.count, ![0x2c, 0x7d, 0x09, 0x0a, 0x0d, 0x20].contains(bytes[index]) {
      if [0x7b, 0x5b].contains(bytes[index]) { throw InputFailure.invalid }
      index += 1
    }
    guard index > start else { throw InputFailure.invalid }
  }

  private mutating func skipWhitespace() {
    while index < bytes.count, [0x09, 0x0a, 0x0d, 0x20].contains(bytes[index]) {
      index += 1
    }
  }

  private mutating func consume(_ byte: UInt8) throws {
    guard consumeIfPresent(byte) else { throw InputFailure.invalid }
  }

  private mutating func consumeIfPresent(_ byte: UInt8) -> Bool {
    guard index < bytes.count, bytes[index] == byte else { return false }
    index += 1
    return true
  }
}

struct SystemRandomByteSource: RandomByteSource {
  func bytes(count: Int) throws -> [UInt8] {
    guard count > 0 && count <= 4_096 else { throw RandomFailure.failed }
    var output = [UInt8](repeating: 0, count: count)
    let status = output.withUnsafeMutableBytes { buffer in
      SecRandomCopyBytes(kSecRandomDefault, count, buffer.baseAddress!)
    }
    guard status == errSecSuccess else {
      output.resetBytes(in: output.indices)
      throw RandomFailure.failed
    }
    return output
  }
}

// These deprecated legacy file-Keychain/ACL APIs are intentional. Any process
// acting as this user can invoke the sole trusted binary, /usr/bin/security.
// Successful compilation is API compatibility evidence, not live ACL proof.
struct MacOSKeychainAdapter: KeychainAdapter {
  func resolveDefaultKeychainPath() throws -> String {
    var keychain: SecKeychain?
    try requireSuccess(SecKeychainCopyDefault(&keychain))
    guard let keychain else { throw KeychainAdapterError.unavailable }
    return try canonicalPath(of: keychain)
  }

  func inspect(_ request: InspectionRequest) throws -> InspectionSnapshot {
    guard
      request.broad.keychainPath == request.exact.keychainPath,
      request.broad.matchSearchListOnly,
      request.exact.matchSearchListOnly,
      request.broad.matchLimitAll,
      request.exact.matchLimitAll,
      request.broad.returnPersistentReferences,
      request.exact.returnPersistentReferences,
      !request.broad.returnData,
      !request.exact.returnData,
      !request.broad.useKeychain,
      !request.exact.useKeychain
    else {
      throw KeychainAdapterError.provenanceMismatch
    }
    let keychain = try openExactKeychain(request.broad.keychainPath)
    return InspectionSnapshot(
      broadPersistentReferences: try persistentReferences(
        matching: request.broad,
        in: keychain
      ),
      exactPersistentReferences: try persistentReferences(
        matching: request.exact,
        in: keychain
      )
    )
  }

  func validateCreateTarget(_ expectedPath: String) throws {
    _ = try validatedCreateKeychain(expectedPath)
  }

  func create(_ request: CreationRequest) throws -> Data? {
    guard
      request.itemClass == .genericPassword,
      request.label == request.service,
      request.useKeychainForAdd,
      request.returnPersistentReference,
      request.trustedApplicationPaths == ["/usr/bin/security"],
      request.valueData.count == 64,
      request.valueData.allSatisfy({
        ($0 >= UInt8(ascii: "0") && $0 <= UInt8(ascii: "9"))
          || ($0 >= UInt8(ascii: "a") && $0 <= UInt8(ascii: "f"))
      })
    else {
      throw KeychainAdapterError.provenanceMismatch
    }

    let keychain = try validatedCreateKeychain(request.keychainPath)

    var trustedApplication: SecTrustedApplication?
    try requireSuccess(
      SecTrustedApplicationCreateFromPath(
        "/usr/bin/security",
        &trustedApplication
      )
    )
    guard let trustedApplication else { throw KeychainAdapterError.unavailable }

    var access: SecAccess?
    try requireSuccess(
      SecAccessCreate(
        request.label as CFString,
        [trustedApplication] as CFArray,
        &access
      )
    )
    guard let access else { throw KeychainAdapterError.unavailable }

    let attributes: [CFString: Any] = [
      kSecClass: kSecClassGenericPassword,
      kSecAttrAccount: request.account,
      kSecAttrService: request.service,
      kSecAttrLabel: request.label,
      kSecAttrGeneric: request.generic,
      kSecAttrComment: request.comment,
      kSecValueData: request.valueData,
      kSecUseKeychain: keychain,
      kSecAttrAccess: access,
      kSecReturnPersistentRef: true,
    ]
    var rawResult: CFTypeRef?
    let status = SecItemAdd(attributes as CFDictionary, &rawResult)
    guard status == errSecSuccess else {
      throw KeychainAdapterError.status(Int32(status))
    }
    return rawResult as? Data
  }

  private func validatedCreateKeychain(_ expectedPath: String) throws -> SecKeychain {
    let defaultPath = try resolveDefaultKeychainPath()
    guard defaultPath == expectedPath else {
      throw KeychainAdapterError.provenanceMismatch
    }
    return try openExactKeychain(expectedPath)
  }

  private func persistentReferences(
    matching request: MetadataQuery,
    in keychain: SecKeychain
  ) throws -> [Data] {
    var query: [CFString: Any] = [
      kSecClass: kSecClassGenericPassword,
      kSecMatchSearchList: [keychain],
      kSecMatchLimit: kSecMatchLimitAll,
      kSecReturnPersistentRef: true,
    ]
    for (attribute, value) in request.attributes {
      let key: CFString
      switch attribute {
      case .account: key = kSecAttrAccount
      case .service: key = kSecAttrService
      case .label: key = kSecAttrLabel
      case .generic: key = kSecAttrGeneric
      case .comment: key = kSecAttrComment
      }
      switch value {
      case .string(let string): query[key] = string
      case .data(let data): query[key] = data
      }
    }

    var rawResult: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &rawResult)
    if status == errSecItemNotFound { return [] }
    guard status == errSecSuccess else {
      throw KeychainAdapterError.status(Int32(status))
    }
    if let reference = rawResult as? Data { return [reference] }
    guard let values = rawResult as? [Any] else {
      throw KeychainAdapterError.ambiguousResult
    }
    let references = values.compactMap { $0 as? Data }
    guard references.count == values.count else {
      throw KeychainAdapterError.ambiguousResult
    }
    return references
  }

  private func openExactKeychain(_ expectedPath: String) throws -> SecKeychain {
    let canonicalExpected = try canonicalExistingPath(expectedPath)
    guard canonicalExpected == expectedPath else {
      throw KeychainAdapterError.provenanceMismatch
    }
    var keychain: SecKeychain?
    try requireSuccess(SecKeychainOpen(expectedPath, &keychain))
    guard let keychain else { throw KeychainAdapterError.unavailable }
    guard try canonicalPath(of: keychain) == expectedPath else {
      throw KeychainAdapterError.provenanceMismatch
    }
    return keychain
  }

  private func canonicalPath(of keychain: SecKeychain) throws -> String {
    var buffer = [CChar](repeating: 0, count: Int(PATH_MAX) + 1)
    var length = UInt32(buffer.count)
    let status = buffer.withUnsafeMutableBufferPointer { pointer in
      SecKeychainGetPath(keychain, &length, pointer.baseAddress!)
    }
    try requireSuccess(status)
    guard length > 0, Int(length) < buffer.count else {
      throw KeychainAdapterError.provenanceMismatch
    }
    return try canonicalExistingPath(String(cString: buffer))
  }

  private func canonicalExistingPath(_ path: String) throws -> String {
    guard path.utf8.count <= 1_024 else {
      throw KeychainAdapterError.provenanceMismatch
    }
    guard let resolved = realpath(path, nil) else {
      throw KeychainAdapterError.unavailable
    }
    defer { free(resolved) }
    return String(cString: resolved)
  }

  private func requireSuccess(_ status: OSStatus) throws {
    guard status == errSecSuccess else {
      throw KeychainAdapterError.status(Int32(status))
    }
  }
}

#if !KEYCHAIN_HELPER_TESTING
  @_cdecl("main")
  func keychainHelperMain(
    _: Int32,
    _: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
  ) -> Int32 {
    let input: Data
    do {
      input =
        try FileHandle.standardInput.read(
          upToCount: KeychainHelperLimits.maximumInputBytes + 1
        ) ?? Data()
    } catch {
      let result = KeychainHelper(
        adapter: MacOSKeychainAdapter(),
        random: SystemRandomByteSource()
      ).run(arguments: [], input: Data())
      FileHandle.standardOutput.write(result.output)
      return result.exitCode
    }
    let result = KeychainHelper(
      adapter: MacOSKeychainAdapter(),
      random: SystemRandomByteSource()
    ).run(
      arguments: Array(CommandLine.arguments.dropFirst()),
      input: input
    )
    FileHandle.standardOutput.write(result.output)
    return result.exitCode
  }
#endif
