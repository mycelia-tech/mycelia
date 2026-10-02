import Foundation
import SQLite3

@main
enum ProbeTests {
  static func main() throws {
    // macOS /var and /tmp are symlinks. Foundation may shorten a resolved
    // /private/var back to /var; use the explicit non-symlink fixture root.
    let temporary = URL(fileURLWithPath: "/private/tmp", isDirectory: true)
      .appendingPathComponent("mycelia-probe-tests-" + UUID().uuidString)
    try FileManager.default.createDirectory(at: temporary, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: temporary) }
    let root = temporary.appendingPathComponent("Recordings")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    let dbURL = root.appendingPathComponent("CloudRecordings.db")
    var handle: OpaquePointer?
    try require(sqlite3_open(dbURL.path, &handle) == SQLITE_OK, "fixture SQLite open")
    let database = handle!
    defer { sqlite3_close(database) }
    try execute(database, "CREATE TABLE ZCLOUDRECORDING (ZPATH TEXT, ZDATE REAL)")
    let header = Data([0, 0, 0, 24] + Array("ftypM4A ".utf8) + Array(repeating: 0, count: 64))
    try header.write(to: root.appendingPathComponent("first.m4a"))
    try execute(database, "INSERT INTO ZCLOUDRECORDING VALUES ('first.m4a', 100)")
    let before = try Data(contentsOf: dbURL)
    let report = try probeVoiceMemos(folder: root)
    try require(
      report.catalogRows == 1 && report.sampleFile == "first.m4a", "reads catalog and audio")
    try require(report.sampleBytesRead == 32, "bounded audio read")
    let after = try Data(contentsOf: dbURL)
    try require(before == after, "source database unchanged")
    let audioAfter = try Data(contentsOf: root.appendingPathComponent("first.m4a"))
    try require(audioAfter == header, "source recording unchanged")

    for invalid in [
      "", "../outside.m4a", "/tmp/outside.m4a", "a//b", "./first.m4a", "a/../first.m4a",
      "first.m4a\0",
    ] {
      try rejects("unsafe catalog path \(invalid)") {
        _ = try checkedFile(root: root, relativePath: invalid)
      }
    }
    try header.write(to: temporary.appendingPathComponent("outside.m4a"))
    try FileManager.default.createSymbolicLink(
      at: root.appendingPathComponent("linked.m4a"),
      withDestinationURL: temporary.appendingPathComponent("outside.m4a"))
    try rejects("symlink escape") { _ = try checkedFile(root: root, relativePath: "linked.m4a") }
    try rejects("no-follow audio descriptor") {
      _ = try readAudioHeader(root.appendingPathComponent("linked.m4a"))
    }
    try Data("not an audio header".utf8).write(to: root.appendingPathComponent("invalid.m4a"))
    try rejects("invalid M4A header") {
      _ = try readAudioHeader(root.appendingPathComponent("invalid.m4a"))
    }

    try execute(database, "PRAGMA journal_mode=WAL")
    try execute(database, "PRAGMA wal_autocheckpoint=0")
    try header.write(to: root.appendingPathComponent("wal-new.m4a"))
    try execute(database, "INSERT INTO ZCLOUDRECORDING VALUES ('wal-new.m4a', 200)")
    let walReport = try probeVoiceMemos(folder: root)
    try require(
      walReport.catalogRows == 2 && walReport.sampleFile == "wal-new.m4a", "live WAL is not ignored"
    )
    try execute(database, "INSERT INTO ZCLOUDRECORDING VALUES ('missing.m4a', 300)")
    let missing = try probeVoiceMemos(folder: root)
    try require(
      missing.skippedRecentFiles == 1 && missing.sampleFile == "wal-new.m4a",
      "partial coverage is explicit")
    try require(
      missing.newestCatalogDate == Date(timeIntervalSinceReferenceDate: 300),
      "catalog freshness differs from readable audio")

    let emptyRoot = temporary.appendingPathComponent("empty")
    try FileManager.default.createDirectory(at: emptyRoot, withIntermediateDirectories: true)
    try rejects("missing database is not an empty success") {
      _ = try probeVoiceMemos(folder: emptyRoot)
    }
    try Data("broken SQLite".utf8).write(to: emptyRoot.appendingPathComponent("CloudRecordings.db"))
    try rejects("corrupt database is not an empty success") {
      _ = try probeVoiceMemos(folder: emptyRoot)
    }
    print(
      "PASS: 19 checks (read-only bytes, bounded read, traversal/symlinks, live WAL, partial coverage, missing/corrupt database)"
    )

    try require(CommandLine.arguments.count == 2, "entitlements path is required")
    let entitlementData = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
    let entitlementPlist = try PropertyListSerialization.propertyList(
      from: entitlementData, format: nil)
    let expected: [String: Any] = [
      "com.apple.security.app-sandbox": true,
      "com.apple.security.files.bookmarks.app-scope": true,
      "com.apple.security.files.user-selected.read-only": true,
      "com.apple.security.network.client": true,
      "com.apple.security.temporary-exception.files.home-relative-path.read-only": [
        "/Library/Application Support/Mycelia/VoiceMemosBridge/pairing.json"
      ],
    ]
    try require(
      (entitlementPlist as? NSDictionary)?.isEqual(to: expected) == true,
      "exact capability allowlist")
    print(
      "PASS: exact sandbox capability allowlist (source read-only, pairing file read-only, network client; no staging writes)"
    )
    try DirectImportTests.run()
  }

  private static func execute(_ database: OpaquePointer, _ sql: String) throws {
    try require(sqlite3_exec(database, sql, nil, nil, nil) == SQLITE_OK, "fixture SQL: \(sql)")
  }

  private static func require(_ condition: Bool, _ message: String) throws {
    if !condition { throw ProbeError.failed("FAIL: " + message) }
  }

  private static func rejects(_ name: String, _ body: () throws -> Void) throws {
    do { try body() } catch { return }
    throw ProbeError.failed("FAIL: expected rejection: " + name)
  }
}
