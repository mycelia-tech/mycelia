import Darwin
import Foundation
import SQLite3

enum ProbeError: LocalizedError {
  case failed(String)

  var errorDescription: String? {
    switch self {
    case .failed(let message): return message
    }
  }
}

struct ProbeReport: Codable {
  let checkedAt: Date
  let folder: String
  let catalogRows: Int
  let newestCatalogDate: Date?
  let sampleFile: String
  let sampleDate: Date
  let sampleBytesRead: Int
  let skippedRecentFiles: Int
}

/// Only accepts regular files below the selected directory. In particular, a
/// catalog may not redirect the probe to another folder via '..' or symlinks.
func checkedFile(root: URL, relativePath: String) throws -> URL {
  let parts = relativePath.split(separator: "/", omittingEmptySubsequences: false)
  guard !parts.isEmpty, !relativePath.hasPrefix("/"), !relativePath.contains("\0"),
    parts.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." })
  else {
    throw ProbeError.failed("Unsafe path in the catalog: \(relativePath)")
  }
  var result = root
  for (index, part) in parts.enumerated() {
    result.appendPathComponent(String(part))
    let values = try result.resourceValues(forKeys: [
      .isSymbolicLinkKey, .isDirectoryKey, .isRegularFileKey,
    ])
    guard values.isSymbolicLink != true else {
      throw ProbeError.failed("Symbolic links are not allowed: \(relativePath)")
    }
    if index < parts.count - 1 {
      guard values.isDirectory == true else {
        throw ProbeError.failed("The file parent is not a directory: \(relativePath)")
      }
    } else if values.isRegularFile != true {
      throw ProbeError.failed("Not a regular file: \(relativePath)")
    }
  }
  return result
}

/// Reads only a small header, never decodes, copies, or modifies the recording.
func readAudioHeader(_ url: URL) throws -> Int {
  let descriptor = open(url.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
  guard descriptor >= 0 else {
    throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
  }
  defer { close(descriptor) }
  var attributes = stat()
  guard fstat(descriptor, &attributes) == 0,
    attributes.st_mode & S_IFMT == S_IFREG
  else {
    throw ProbeError.failed("The audio is not a regular file")
  }
  var header = [UInt8](repeating: 0, count: 32)
  let count = read(descriptor, &header, header.count)
  guard count >= 0 else {
    throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
  }
  guard count >= 12, Array(header[4..<8]) == Array("ftyp".utf8) else {
    throw ProbeError.failed("The file header does not look like M4A/MP4")
  }
  return count
}

private func query<T>(
  _ database: OpaquePointer, sql: String,
  row: (OpaquePointer) throws -> T
) throws -> [T] {
  var statement: OpaquePointer?
  guard sqlite3_prepare_v2(database, sql, -1, &statement, nil) == SQLITE_OK,
    let statement
  else {
    throw ProbeError.failed("SQLite: \(String(cString: sqlite3_errmsg(database)))")
  }
  defer { sqlite3_finalize(statement) }
  var result: [T] = []
  while true {
    switch sqlite3_step(statement) {
    case SQLITE_ROW: result.append(try row(statement))
    case SQLITE_DONE: return result
    default: throw ProbeError.failed("SQLite: \(String(cString: sqlite3_errmsg(database)))")
    }
  }
}

func probeVoiceMemos(folder: URL) throws -> ProbeReport {
  let folderValues = try folder.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
  guard folderValues.isDirectory == true, folderValues.isSymbolicLink != true else {
    throw ProbeError.failed("Choose a regular Recordings folder, not a symbolic link")
  }
  // Enumerate to distinguish an unreadable folder from a missing catalog.
  _ = try FileManager.default.contentsOfDirectory(atPath: folder.path)
  let databaseURL = try checkedFile(root: folder, relativePath: "CloudRecordings.db")
  // SQLite may consult these files even when its primary database is read-only.
  for suffix in ["-wal", "-shm", "-journal"] {
    let sidecar = "CloudRecordings.db" + suffix
    if (try? folder.appendingPathComponent(sidecar).resourceValues(forKeys: [.isSymbolicLinkKey]))
      != nil
    {
      _ = try checkedFile(root: folder, relativePath: sidecar)
    }
  }
  var handle: OpaquePointer?
  let opened = sqlite3_open_v2(
    databaseURL.path, &handle, SQLITE_OPEN_READONLY | SQLITE_OPEN_NOFOLLOW, nil)
  defer { if let handle { sqlite3_close(handle) } }
  guard opened == SQLITE_OK, let database = handle else {
    let detail = handle.map { String(cString: sqlite3_errmsg($0)) } ?? "no connection"
    let systemError = handle.map { sqlite3_system_errno($0) } ?? 0
    let sqliteError = handle.map { sqlite3_extended_errcode($0) } ?? opened
    throw ProbeError.failed(
      "Could not open SQLite read-only: \(detail)\nSQLite: \(sqliteError), errno: \(systemError)\n\(databaseURL.path)"
    )
  }
  guard sqlite3_db_readonly(database, "main") == 1 else {
    throw ProbeError.failed("SQLite did not confirm read-only mode")
  }
  sqlite3_busy_timeout(database, 1500)
  // No immutable=1: it would silently ignore the live catalog's WAL updates.
  // Bound VM work as well as lock waits; a corrupt/huge catalog must not hang.
  var instructionsRemaining: Int32 = 10_000
  return try withUnsafeMutablePointer(to: &instructionsRemaining) { budget in
    sqlite3_progress_handler(
      database, 1000,
      { context in
        guard let context else { return 1 }
        let budget = context.assumingMemoryBound(to: Int32.self)
        budget.pointee -= 1
        return budget.pointee > 0 ? 0 : 1
      }, budget)
    defer { sqlite3_progress_handler(database, 0, nil, nil) }
    let summary = try query(database, sql: "SELECT COUNT(*), MAX(ZDATE) FROM ZCLOUDRECORDING") {
      row in
      (
        Int(sqlite3_column_int64(row, 0)),
        sqlite3_column_type(row, 1) == SQLITE_NULL
          ? nil : Date(timeIntervalSinceReferenceDate: sqlite3_column_double(row, 1))
      )
    }
    let recent = try query(
      database,
      sql:
        "SELECT ZPATH, ZDATE FROM ZCLOUDRECORDING WHERE ZPATH IS NOT NULL AND ZDATE IS NOT NULL ORDER BY ZDATE DESC LIMIT 20"
    ) { row in
      (
        String(cString: sqlite3_column_text(row, 0)),
        Date(timeIntervalSinceReferenceDate: sqlite3_column_double(row, 1))
      )
    }
    var failures: [String] = []
    for (path, date) in recent {
      do {
        let audio = try checkedFile(root: folder, relativePath: path)
        let bytes = try readAudioHeader(audio)
        return ProbeReport(
          checkedAt: Date(), folder: folder.path,
          catalogRows: summary.first?.0 ?? 0,
          newestCatalogDate: summary.first?.1,
          sampleFile: path, sampleDate: date, sampleBytesRead: bytes,
          skippedRecentFiles: failures.count)
      } catch {
        failures.append(error.localizedDescription)
      }
    }
    throw ProbeError.failed(
      "The catalog was read, but none of the \(recent.count) most recent files could be read. \(failures.first ?? "The catalog is empty")"
    )
  }
}
