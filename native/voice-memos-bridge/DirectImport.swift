import CryptoKit
import Darwin
import Foundation
import SQLite3

func importerSetupCommand(repository: String) throws -> String {
  guard repository.hasPrefix("/"), !repository.contains("\0"),
    !repository.contains("\n"), !repository.contains("\r")
  else {
    throw ProbeError.failed("Invalid repository path; rebuild Bridge from this checkout.")
  }
  let script = repository + "/scripts/install-voice-memos-importer.py"
  return "/usr/bin/python3 '" + script.replacingOccurrences(of: "'", with: "'\"'\"'") + "'"
}

struct EncodingPresentation {
  let state: [String: Any]
  let duration: Double
  let now: TimeInterval
  var encoded: Double { max(0, state["encoded_seconds"] as? Double ?? 0) }
  var ratio: Double { duration > 0 ? min(1, encoded / duration) : 0 }
  var hasProgress: Bool { state["encoded_seconds"] != nil }
  static func clock(_ seconds: Double) -> String {
    let value = Int(min(1_209_600, max(0, seconds.isFinite ? seconds : 0)))
    return String(format: "%02d:%02d:%02d", value / 3600, value / 60 % 60, value % 60)
  }
  var detail: String {
    guard hasProgress else {
      return
        "Encoding audio… Progress details need the updated local importer; no database chunks are expected yet."
    }
    let elapsed = state["encoding_elapsed_seconds"] as? Double ?? 0
    let speed = state["encoding_speed"] as? Double ?? 0
    let age = max(0, now - (state["encoding_updated_at"] as? Double ?? now))
    return "Encoded \(Self.clock(encoded)) / \(Self.clock(duration)) (\(Int(ratio * 100))%)"
      + " · \(String(format: "%.1f", speed))× · elapsed \(Self.clock(elapsed))"
      + "\nLast audio progress: \(Int(age))s ago"
      + (age >= 30
        ? " — waiting for encoder progress; Pause is available."
        : " · Saving to Mycelia follows encoding.")
  }
}

final class ImportCancellation: @unchecked Sendable {
  private let lock = NSLock()
  private var stopped = false
  func cancel() {
    lock.lock()
    stopped = true
    lock.unlock()
  }
  var isCancelled: Bool {
    lock.lock()
    defer { lock.unlock() }
    return stopped
  }
}

struct BridgeRecording: Codable {
  enum CodingKeys: String, CodingKey {
    case uuid, filename, duration, size, title
    case appleDate = "apple_date"
  }
  let uuid: String
  let filename: String
  let appleDate: Double
  let duration: Double
  let size: Int64
  let title: String
}

struct LibraryEntry {
  let recording: BridgeRecording
  let relativePath: String
  var state: String
  var error: String
  var availability = "local"
  var sourceDetail = ""
  var databaseCopies = 0

  var isImported: Bool { ["already_imported", "imported"].contains(state) }
  var canImport: Bool { availability == "local" && state == "pending" }
  var canRetry: Bool { availability == "local" && ["error", "failed"].contains(state) }
  var sourceLabel: String {
    switch availability {
    case "local": return "On this Mac"
    case "missing": return "Not on this Mac"
    case "removed": return "Removed / not in catalog"
    default: return "Source unavailable"
    }
  }
  var importLabel: String {
    if isImported { return "Imported" }
    if state == "pending" && availability != "local" { return "Not imported" }
    return state.replacingOccurrences(of: "_", with: " ").capitalized
  }
  var explanation: String {
    ([sourceDetail, error]
      + (databaseCopies > 1
        ? [
          "\(databaseCopies) Mycelia records share this Apple UUID; no extra copy will be imported."
        ]
        : []))
      .filter { !$0.isEmpty }.joined(separator: " · ")
  }
}

struct KnownRecording: Decodable {
  enum CodingKeys: String, CodingKey {
    case uuid, filename, title, duration, size, imported, error
    case sourceID = "source_id"
    case appleDate = "apple_date"
  }
  let sourceID: String
  let uuid: String
  let filename: String
  let title: String
  let appleDate: Double?
  let duration: Double
  let size: Int64
  let imported: Bool
  let error: String
}

struct InventoryResponse: Decodable {
  let records: [KnownRecording]
  let next: String?
}

/// Only call after a COMPLETE catalog scan and all inventory pages succeed.
/// Date filtering comes last: outside the date range never means "removed".
func reconcileLibrary(
  _ catalog: [LibraryEntry], known: [KnownRecording], since: Date?,
  previouslySeen: [BridgeRecording] = []
)
  -> [LibraryEntry]
{
  let groups = Dictionary(grouping: known, by: { $0.uuid })
  let catalogIDs = Set(catalog.map { $0.recording.uuid })
  var result = catalog
  for recording in previouslySeen
  where !catalogIDs.contains(recording.uuid)
    && groups[recording.uuid] == nil
  {
    result.append(
      LibraryEntry(
        recording: recording, relativePath: "", state: "unchecked", error: "",
        availability: "removed",
        sourceDetail:
          "Seen in an earlier Bridge check, now absent from the complete Apple catalog. No successful Mycelia import was found; check your backup."
      ))
  }
  for (uid, rows) in groups where !catalogIDs.contains(uid) {
    guard let row = rows.first, !uid.isEmpty else { continue }
    result.append(
      LibraryEntry(
        recording: BridgeRecording(
          uuid: uid, filename: row.filename, appleDate: row.appleDate ?? .nan,
          duration: row.duration, size: row.size, title: row.title),
        relativePath: "", state: "unchecked", error: "", availability: "removed",
        sourceDetail:
          "Previously known to Mycelia, absent from the complete Apple catalog at this check. This can mean deletion or a different library. Mycelia audio is preserved."
      ))
  }
  for index in result.indices {
    let rows = groups[result[index].recording.uuid] ?? []
    result[index].databaseCopies = rows.count
    // A repeated identity in Apple's own catalog remains unsafe to import.
    if result[index].state == "conflict" { continue }
    if rows.contains(where: { $0.imported }) {
      result[index].state = "already_imported"
      result[index].error = ""
    } else if rows.count > 1 {
      result[index].state = "conflict"
      result[index].error = "Multiple pending Mycelia records share this Apple UUID."
    } else if let error = rows.first?.error, !error.isEmpty {
      result[index].state = "error"
      result[index].error = error
    } else {
      result[index].state = "pending"
      result[index].error = ""
    }
  }
  return result.filter {
    since == nil || $0.recording.appleDate >= since!.timeIntervalSinceReferenceDate
  }.sorted {
    ($0.recording.appleDate.isFinite ? $0.recording.appleDate : -.infinity)
      > ($1.recording.appleDate.isFinite ? $1.recording.appleDate : -.infinity)
  }
}

struct LibraryStatistics {
  let entries: [LibraryEntry]
  var local: [LibraryEntry] { entries.filter { $0.availability == "local" } }
  var missing: [LibraryEntry] { entries.filter { $0.availability == "missing" } }
  var removed: [LibraryEntry] { entries.filter { $0.availability == "removed" } }
  var duplicateIDs: Int {
    Set(
      entries.filter { $0.databaseCopies > 1 || $0.state == "conflict" }.map { $0.recording.uuid }
    ).count
  }
  var text: String {
    let errors = local.filter { ["error", "failed", "conflict"].contains($0.state) }.count
    let other = local.filter { !$0.isImported && !$0.canImport }.count - errors
    return
      "On this Mac: \(local.count) — \(local.filter { $0.isImported }.count) imported · \(local.filter { $0.canImport }.count) pending · \(errors) need attention"
      + (other > 0 ? " · \(other) processing/paused" : "") + "\n"
      + "Not local: \(missing.count) (\(missing.filter { $0.isImported }.count) imported) · Removed / not in catalog: \(removed.count) (\(removed.filter { $0.isImported }.count) imported · \(removed.filter { !$0.isImported }.count) NOT imported)\n"
      + "Source unavailable: \(entries.filter { $0.availability == "unavailable" }.count) · Duplicate Apple IDs in Mycelia/catalog: \(duplicateIDs) · \(entries.count) checked"
  }
}

func readLibrary(source: URL, since: Date?) throws -> [LibraryEntry] {
  let databaseURL = try checkedFile(root: source, relativePath: "CloudRecordings.db")
  for suffix in ["-wal", "-shm", "-journal"] {
    var value = stat()
    if lstat(databaseURL.path + suffix, &value) == 0 {
      _ = try checkedFile(root: source, relativePath: "CloudRecordings.db" + suffix)
    }
  }
  var handle: OpaquePointer?
  defer { if let handle { sqlite3_close(handle) } }
  guard
    sqlite3_open_v2(databaseURL.path, &handle, SQLITE_OPEN_READONLY | SQLITE_OPEN_NOFOLLOW, nil)
      == SQLITE_OK,
    let database = handle, sqlite3_db_readonly(database, "main") == 1
  else {
    throw ProbeError.failed("Cannot read the Voice Memos catalog. Choose the source folder again.")
  }
  sqlite3_busy_timeout(database, 1500)
  // Bound sort/scan VM work before the first result row, not just wall-clock
  // checks between rows. A malformed catalog must not monopolize the UI task.
  let budget = UnsafeMutablePointer<Int32>.allocate(capacity: 1)
  budget.initialize(to: 10000)
  sqlite3_progress_handler(
    database, 1000,
    { context in
      guard let context else { return 1 }
      let remaining = context.assumingMemoryBound(to: Int32.self)
      remaining.pointee -= 1
      return remaining.pointee > 0 ? 0 : 1
    }, budget)
  defer {
    sqlite3_progress_handler(database, 0, nil, nil)
    budget.deinitialize(count: 1)
    budget.deallocate()
  }
  let sql =
    "SELECT ZUNIQUEID, ZPATH, ZDATE, ZDURATION, ZENCRYPTEDTITLE FROM ZCLOUDRECORDING WHERE ZDATE >= ? ORDER BY ZDATE DESC LIMIT 10001"
  var statement: OpaquePointer?
  guard sqlite3_prepare_v2(database, sql, -1, &statement, nil) == SQLITE_OK, let statement else {
    throw ProbeError.failed("Voice Memos catalog schema is not supported")
  }
  defer { sqlite3_finalize(statement) }
  sqlite3_bind_double(statement, 1, since?.timeIntervalSinceReferenceDate ?? -978_307_200)
  var entries: [LibraryEntry] = []
  let deadline = Date().addingTimeInterval(15)
  while true {
    if Date() > deadline {
      throw ProbeError.failed("Catalog scan exceeded 15 seconds; narrow the date range")
    }
    let step = sqlite3_step(statement)
    if step == SQLITE_DONE { break }
    guard step == SQLITE_ROW else {
      throw ProbeError.failed("Cannot finish reading the Voice Memos catalog")
    }
    func text(_ index: Int32) -> String {
      sqlite3_column_text(statement, index).map { String(cString: $0) } ?? ""
    }
    let uid = text(0)
    let path = text(1)
    let date = sqlite3_column_double(statement, 2)
    let duration = sqlite3_column_double(statement, 3)
    var size: Int64 = 0
    var failure = ""
    var availability = "local"
    do {
      guard uid.range(of: "^[A-Za-z0-9_-]{8,128}$", options: .regularExpression) != nil,
        duration > 0, duration <= 1_209_600, date.isFinite, !path.isEmpty
      else { throw ProbeError.failed("Invalid UUID, date or duration in Apple catalog") }
      let file = try checkedFile(root: source, relativePath: path)
      let info = try file.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey])
      size = Int64(info.fileSize ?? 0)
      guard size > 0, size <= 16 * 1024 * 1024 * 1024 else {
        throw ProbeError.failed("File is empty or exceeds 16 GiB")
      }
      guard let modified = info.contentModificationDate, Date().timeIntervalSince(modified) > 10
      else {
        throw ProbeError.failed("Recording is still changing; check again later")
      }
    } catch {
      failure = error.localizedDescription
      let reason = error as NSError
      let missing =
        (reason.domain == NSCocoaErrorDomain
          && [NSFileNoSuchFileError, NSFileReadNoSuchFileError].contains(reason.code))
        || (reason.domain == NSPOSIXErrorDomain && reason.code == Int(ENOENT))
      availability = missing ? "missing" : "unavailable"
      if missing {
        failure =
          "Listed by Apple, but audio is not on this Mac. It may be in iCloud or removed locally; this is not proof of deletion."
      }
    }
    entries.append(
      LibraryEntry(
        recording: BridgeRecording(
          uuid: uid, filename: URL(fileURLWithPath: path).lastPathComponent,
          appleDate: date, duration: duration, size: size, title: String(text(4).prefix(1024))),
        relativePath: path, state: failure.isEmpty ? "unchecked" : "unavailable", error: "",
        availability: availability, sourceDetail: failure))
  }
  guard entries.count <= 10000 else {
    throw ProbeError.failed("More than 10,000 recordings; narrow the date range")
  }
  let groups = Dictionary(grouping: entries.indices, by: { entries[$0].recording.uuid })
  for indices in groups.values where indices.count > 1 {
    for index in indices {
      entries[index].state = "conflict"
      entries[index].error = "Repeated Apple UUID in the catalog; resolve before importing"
    }
  }
  return entries
}

/// Hash from a no-follow descriptor. No staging file or in-memory audio copy.
func recordingHash(_ file: URL, expectedSize: Int64, cancelled: () -> Bool) throws -> String {
  let descriptor = open(file.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
  guard descriptor >= 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
  let stream = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
  defer { try? stream.close() }
  var before = stat()
  guard fstat(descriptor, &before) == 0, before.st_mode & S_IFMT == S_IFREG,
    before.st_size == expectedSize
  else { throw ProbeError.failed("Recording changed; scan again") }
  var hash = SHA256()
  while let bytes = try stream.read(upToCount: 1024 * 1024), !bytes.isEmpty {
    if cancelled() { throw CancellationError() }
    hash.update(data: bytes)
  }
  var after = stat()
  guard fstat(descriptor, &after) == 0, before.st_size == after.st_size,
    before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec,
    before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec,
    before.st_ctimespec.tv_sec == after.st_ctimespec.tv_sec,
    before.st_ctimespec.tv_nsec == after.st_ctimespec.tv_nsec
  else { throw ProbeError.failed("Recording changed while reading; scan again") }
  return hash.finalize().map { String(format: "%02x", $0) }.joined()
}

final class BridgeClient: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
  private let token: String
  private lazy var session: URLSession = {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.timeoutIntervalForRequest = 30
    configuration.timeoutIntervalForResource = 1800
    configuration.httpShouldSetCookies = false
    configuration.urlCredentialStorage = nil
    configuration.connectionProxyDictionary = [:]
    return URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
  }()

  init(home: URL) throws {
    let path = home.appendingPathComponent(
      "Library/Application Support/Mycelia/VoiceMemosBridge/pairing.json")
    let descriptor = open(path.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
    guard descriptor >= 0 else {
      throw ProbeError.failed("Local importer is not set up. Open Importer setup.")
    }
    let stream = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
    defer { try? stream.close() }
    var info = stat()
    guard fstat(descriptor, &info) == 0, info.st_mode & S_IFMT == S_IFREG,
      info.st_uid == getuid(), info.st_mode & 0o077 == 0, info.st_size < 4096,
      let data = try stream.read(upToCount: 4096),
      let value = try JSONSerialization.jsonObject(with: data) as? [String: Any],
      let token = value["token"] as? String, token.count == 64
    else { throw ProbeError.failed("Invalid private pairing file. Check importer setup.") }
    self.token = token
  }

  func urlSession(
    _ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void
  ) {
    completionHandler(nil)  // Never send the local token/audio to a redirected host.
  }

  private func request(_ path: String, method: String = "GET") throws -> URLRequest {
    guard path.hasPrefix("/"), !path.contains(".."), !path.contains("?"),
      let url = URL(string: "http://127.0.0.1:8012" + path), url.host == "127.0.0.1",
      url.port == 8012
    else { throw ProbeError.failed("Only the fixed local importer is allowed") }
    var request = URLRequest(url: url)
    request.httpMethod = method
    request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
    return request
  }

  private func decode(_ data: Data, _ response: URLResponse) throws -> [String: Any] {
    guard data.count <= 512 * 1024,
      let response = response as? HTTPURLResponse,
      let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { throw ProbeError.failed("Invalid local importer response") }
    guard (200..<300).contains(response.statusCode) else {
      throw ProbeError.failed(json["detail"] as? String ?? "Importer HTTP \(response.statusCode)")
    }
    return json
  }

  func json(_ path: String, body: [String: Any]? = nil) async throws -> [String: Any] {
    var request = try request(path, method: body == nil ? "GET" : "POST")
    if let body {
      request.httpBody = try JSONSerialization.data(withJSONObject: body)
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }
    let (data, response) = try await session.data(for: request)
    return try decode(data, response)
  }

  func upload(_ path: String, file: URL, size: Int64) async throws -> [String: Any] {
    var request = try request(path, method: "POST")
    request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
    request.setValue(String(size), forHTTPHeaderField: "Content-Length")
    let (data, response) = try await session.upload(for: request, fromFile: file)
    return try decode(data, response)
  }

  func close() { session.invalidateAndCancel() }
}

func recordingJSON(_ recording: BridgeRecording) throws -> [String: Any] {
  try JSONSerialization.jsonObject(with: JSONEncoder().encode(recording)) as! [String: Any]
}
