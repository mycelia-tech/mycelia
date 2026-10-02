import CryptoKit
import Foundation
import SQLite3

enum DirectImportTests {
  static func run() throws {
    let presentation = EncodingPresentation(
      state: [
        "encoded_seconds": 30.0, "encoding_elapsed_seconds": 5.0,
        "encoding_speed": 6.0, "encoding_updated_at": 90.0,
      ], duration: 60, now: 100)
    guard presentation.ratio == 0.5, presentation.detail.contains("50%"),
      presentation.detail.contains("00:00:30 / 00:01:00"),
      presentation.detail.contains("10s ago"), !presentation.detail.contains("0/0")
    else {
      throw ProbeError.failed("Encoding progress presentation failed")
    }
    let stalled = EncodingPresentation(
      state: ["encoded_seconds": 0.0, "encoding_updated_at": 50.0], duration: 60, now: 100)
    guard stalled.detail.contains("waiting for encoder progress"),
      !EncodingPresentation(state: [:], duration: 60, now: 100).detail.contains("0/0"),
      try importerSetupCommand(repository: "/tmp/Mycelia's checkout")
        == "/usr/bin/python3 '/tmp/Mycelia'\"'\"'s checkout/scripts/install-voice-memos-importer.py'"
    else {
      throw ProbeError.failed("Safe setup or no-progress fallback failed")
    }
    do {
      _ = try importerSetupCommand(repository: "/tmp/bad\npath")
      throw ProbeError.failed("Unsafe setup command accepted")
    } catch ProbeError.failed(let reason) where reason.hasPrefix("Invalid repository path") {}
    let root = URL(fileURLWithPath: "/private/tmp/mycelia-direct-tests-" + UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    var database: OpaquePointer?
    sqlite3_open(root.appendingPathComponent("CloudRecordings.db").path, &database)
    defer { sqlite3_close(database) }
    func sql(_ query: String) throws {
      guard sqlite3_exec(database, query, nil, nil, nil) == SQLITE_OK else {
        throw ProbeError.failed("Fixture SQL")
      }
    }
    func require(_ value: Bool, _ name: String) throws {
      if !value { throw ProbeError.failed("FAIL: " + name) }
    }
    try sql(
      "CREATE TABLE ZCLOUDRECORDING (ZUNIQUEID TEXT, ZPATH TEXT, ZDATE REAL, ZDURATION REAL, ZENCRYPTEDTITLE TEXT)"
    )
    try sql(
      "INSERT INTO ZCLOUDRECORDING VALUES ('ABCD-1234-5678','one.m4a',800000000,10,'Fixture')")
    let audio = Data(repeating: 42, count: 1024)
    let file = root.appendingPathComponent("one.m4a")
    try audio.write(to: file)
    try FileManager.default.setAttributes(
      [.modificationDate: Date().addingTimeInterval(-60)], ofItemAtPath: file.path)
    let dbBefore = try Data(contentsOf: root.appendingPathComponent("CloudRecordings.db"))
    let result = try readLibrary(source: root, since: nil)
    try require(result.count == 1 && result[0].state == "unchecked", "catalog scan")
    try require(result[0].recording.uuid == "ABCD-1234-5678", "full UUID")
    let wire = try recordingJSON(result[0].recording)
    try require(
      wire["apple_date"] as? Double == 800_000_000 && wire["appleDate"] == nil,
      "server date wire contract")
    let empty = try readLibrary(
      source: root, since: Date(timeIntervalSinceReferenceDate: 800_000_001))
    try require(empty.isEmpty, "explicit cutoff")
    let hash = try recordingHash(file, expectedSize: 1024, cancelled: { false })
    try require(
      hash == SHA256.hash(data: audio).map { String(format: "%02x", $0) }.joined(), "streamed hash")
    do {
      _ = try recordingHash(file, expectedSize: 1024, cancelled: { true })
      throw ProbeError.failed("Cancellation ignored")
    } catch is CancellationError {}
    try require(try Data(contentsOf: file) == audio, "audio unchanged")
    try require(
      try Data(contentsOf: root.appendingPathComponent("CloudRecordings.db")) == dbBefore,
      "database unchanged")
    try sql(
      "INSERT INTO ZCLOUDRECORDING VALUES ('ABCD-1234-5678','one.m4a',800000000,10,'Duplicate')")
    try require(
      try readLibrary(source: root, since: nil).allSatisfy { $0.state == "conflict" },
      "duplicate identities fail closed")
    try sql(
      "INSERT INTO ZCLOUDRECORDING VALUES ('MISSING-1234','missing.m4a',800000100,10,'Missing')")
    try require(
      try readLibrary(source: root, since: nil).first?.state == "unavailable",
      "missing audio is visible")
    let missingCatalog = try readLibrary(source: root, since: nil).filter {
      $0.recording.uuid == "MISSING-1234"
    }
    let known = [
      KnownRecording(
        sourceID: "one", uuid: "MISSING-1234", filename: "missing.m4a", title: "Missing",
        appleDate: 800_000_100, duration: 10, size: 1024, imported: true, error: ""),
      KnownRecording(
        sourceID: "two", uuid: "MISSING-1234", filename: "missing.m4a", title: "Missing",
        appleDate: 800_000_100, duration: 10, size: 1024, imported: true, error: ""),
      KnownRecording(
        sourceID: "three", uuid: "REMOVED-1234", filename: "removed.m4a", title: "Removed",
        appleDate: 700_000_000, duration: 10, size: 1024, imported: true, error: ""),
    ]
    let reconciled = reconcileLibrary(missingCatalog, known: known, since: nil)
    try require(reconciled.count == 2, "historical identities are grouped, not duplicated")
    try require(
      reconciled[0].availability == "missing" && reconciled[0].isImported,
      "missing local audio can already be imported")
    try require(
      reconciled[0].databaseCopies == 2 && !reconciled[0].canImport,
      "duplicate imports are visible and skipped")
    try require(
      reconciled[1].availability == "removed" && reconciled[1].isImported
        && !reconciled[1].canRetry, "removed source preserves import status and cannot be requeued")
    let filtered = reconcileLibrary(
      missingCatalog, known: known, since: Date(timeIntervalSinceReferenceDate: 800_000_000))
    try require(
      filtered.count == 1 && filtered[0].availability == "missing",
      "date range does not manufacture removal")
    let stats = LibraryStatistics(entries: reconciled)
    try require(
      stats.local.isEmpty && stats.missing.count == 1 && stats.removed.count == 1
        && stats.duplicateIDs == 1, "statistics keep presence and import independent")
    let pendingMissing = reconcileLibrary(missingCatalog, known: [], since: nil)
    try require(
      !pendingMissing[0].canImport && pendingMissing[0].importLabel == "Not imported",
      "missing sources never enter import queue")
    let vanishedBeforeImport = reconcileLibrary(
      [], known: [], since: nil, previouslySeen: [result[0].recording])
    try require(
      vanishedBeforeImport.count == 1 && vanishedBeforeImport[0].availability == "removed"
        && !vanishedBeforeImport[0].isImported && !vanishedBeforeImport[0].canImport,
      "remember removal of scanned but never imported recordings")
    try require(
      LibraryStatistics(entries: vanishedBeforeImport).text.contains("1 NOT imported"),
      "unimported removed sources are explicit in statistics")
    print(
      "PASS: direct importer catalog, cutoff, full UUID, read-only bytes, SHA-256, cancellation, duplicate and missing-file states"
    )
  }
}
