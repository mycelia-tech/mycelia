import AppKit
import Darwin

@main
enum BridgeMain {
  static func main() {
    let app = NSApplication.shared
    let delegate = BridgeDelegate()
    app.delegate = delegate
    app.setActivationPolicy(.regular)
    app.run()
    withExtendedLifetime(delegate) {}
  }
}

@MainActor
final class BridgeDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate,
  NSTableViewDataSource, NSTableViewDelegate
{
  private var window: NSWindow!
  private var menuItem: NSStatusItem!
  private var menuStatus: NSMenuItem!
  private var headline: NSTextField!
  private var guidance: NSTextField!
  private var summary: NSTextField!
  private var coverage: NSTextField!
  private var filter: NSPopUpButton!
  private var serviceStatus: NSTextField!
  private var setupButton: NSButton!
  private var timing: NSTextField!
  private var details: NSTextField!
  private var progress: NSProgressIndicator!
  private var table: NSTableView!
  private var scanButton: NSButton!
  private var importButton: NSButton!
  private var retryButton: NSButton!
  private var pauseButton: NSButton!
  private var sourceButton: NSButton!
  private var automatic: NSButton!
  private var frequency: NSPopUpButton!
  private var allDates: NSButton!
  private var since: NSDatePicker!
  private var timer: Timer?
  private var working = false
  private var checkingService = false
  private var choosingSource = false
  private var serviceReady = false
  private var pendingQuit = false
  private var nextCheck: Date?
  private var cancellation = ImportCancellation()
  private var activeJob: String?
  private var client: BridgeClient?
  private var activity: NSObjectProtocol?
  private var entries: [LibraryEntry] = []
  private var visibleRows: [Int] = []
  private var completeScan = false
  private var checkedRange = ""
  private let preferences = UserDefaults.standard
  private let bookmarkKey = "voiceMemosReadOnlyBookmark"
  private let accountHome = URL(
    fileURLWithPath: String(cString: getpwuid(getuid())!.pointee.pw_dir))
  private var sourceFolder: URL {
    accountHome.appendingPathComponent(
      "Library/Group Containers/group.com.apple.VoiceMemos.shared/Recordings")
  }
  private var interval: TimeInterval { [60, 300, 900][max(0, frequency.indexOfSelectedItem)] }

  func applicationDidFinishLaunching(_ notification: Notification) {
    configureMenus()
    buildWindow()
    setState(
      "Ready to check your library",
      "Scan library, then Import pending. If the importer is unavailable, open Importer setup.")
    if let previous = preferences.string(forKey: "directLastScanSummary") {
      summary.stringValue = "Previous completed check (not live):\n" + previous
      coverage.stringValue = preferences.string(forKey: "directLastScanRange") ?? ""
    }
    timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
      Task { @MainActor in self?.tick() }
    }
    if automatic.state == .on { nextCheck = Date().addingTimeInterval(10) }
    tick()
    showWindow()
  }
  private func label(_ text: String, size: CGFloat = 13, weight: NSFont.Weight = .regular)
    -> NSTextField
  {
    let field = NSTextField(wrappingLabelWithString: text)
    field.font = .systemFont(ofSize: size, weight: weight)
    field.isSelectable = true
    return field
  }
  private func button(_ text: String, _ action: Selector) -> NSButton {
    NSButton(title: text, target: self, action: action)
  }
  private func configureMenus() {
    let main = NSMenu()
    let appMenu = NSMenu()
    appMenu.addItem(
      withTitle: "Quit Voice Memos Bridge", action: #selector(NSApplication.terminate(_:)),
      keyEquivalent: "q")
    let appItem = NSMenuItem()
    appItem.submenu = appMenu
    main.addItem(appItem)
    let edit = NSMenu(title: "Edit")
    edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
    edit.addItem(
      withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
    let editItem = NSMenuItem(title: "Edit", action: nil, keyEquivalent: "")
    editItem.submenu = edit
    main.addItem(editItem)
    NSApp.mainMenu = main
    menuItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    menuItem.button?.image = NSImage(
      systemSymbolName: "waveform", accessibilityDescription: "Voice Memos Bridge")
    let menu = NSMenu()
    menuStatus = NSMenuItem(title: "Bridge: idle", action: nil, keyEquivalent: "")
    menu.addItem(menuStatus)
    for (title, action) in [
      ("Show Bridge", #selector(showWindow)), ("Scan library", #selector(scan)),
      ("Import pending", #selector(importPending)), ("Pause", #selector(pause)),
    ] {
      let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
      item.target = self
      menu.addItem(item)
    }
    menu.addItem(.separator())
    menu.addItem(
      withTitle: "Quit Bridge", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    menuItem.menu = menu
  }
  private func buildWindow() {
    window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1140, height: 870),
      styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false
    )
    window.title = "Mycelia Voice Memos Import"
    window.minSize = NSSize(width: 1000, height: 830)
    window.delegate = self
    window.isReleasedWhenClosed = false
    headline = label("", size: 24, weight: .semibold)
    guidance = label("", size: 14)
    guidance.textColor = .secondaryLabelColor
    serviceStatus = label("Local importer: checking…")
    setupButton = button("Importer setup…", #selector(startService))
    let serviceRow = NSStackView(views: [
      serviceStatus, setupButton,
      button("Open pipeline", #selector(openPipeline)),
    ])
    serviceRow.spacing = 10
    sourceButton = button("Choose source folder…", #selector(chooseSource))
    let path = label(sourceFolder.path, size: 11)
    path.lineBreakMode = .byTruncatingHead
    path.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    let sourceRow = NSStackView(views: [
      path, button("Copy path", #selector(copyPath)), sourceButton,
    ])
    sourceRow.spacing = 8
    allDates = NSButton(
      checkboxWithTitle: "All recordings", target: self, action: #selector(rangeChanged))
    allDates.state = preferences.object(forKey: "directAllDates") as? Bool == false ? .off : .on
    since = NSDatePicker()
    since.datePickerElements = [.yearMonthDay]
    since.datePickerStyle = .textFieldAndStepper
    since.dateValue =
      preferences.object(forKey: "directSince") as? Date ?? Date().addingTimeInterval(-30 * 86400)
    since.target = self
    since.action = #selector(rangeChanged)
    automatic = NSButton(
      checkboxWithTitle: "Automatic import", target: self, action: #selector(changeAutomatic))
    // Never inherit the old copier's automaticSync preference.
    automatic.state = preferences.bool(forKey: "directAutomaticImport") ? .on : .off
    frequency = NSPopUpButton()
    frequency.addItems(withTitles: ["Every minute", "Every 5 minutes", "Every 15 minutes"])
    frequency.selectItem(at: min(2, max(0, preferences.integer(forKey: "directFrequency"))))
    frequency.target = self
    frequency.action = #selector(changeFrequency)
    let range = NSStackView(views: [allDates, label("or since:"), since, automatic, frequency])
    range.spacing = 10
    scanButton = button("Scan library", #selector(scan))
    importButton = button("Import pending", #selector(importPending))
    retryButton = button("Retry failed", #selector(retryFailed))
    pauseButton = button("Pause", #selector(pause))
    let controls = NSStackView(views: [
      scanButton, importButton, retryButton, pauseButton,
      button("Run in background", #selector(hideWindow)),
    ])
    controls.spacing = 10
    summary = label("Scan to see imported, pending and failed recordings.", weight: .medium)
    coverage = label("No completed check in this window. Scan does not import audio.", size: 12)
    filter = NSPopUpButton()
    filter.addItems(withTitles: [
      "All statuses", "On this Mac", "Pending", "Not local", "Removed / not in catalog",
      "Needs attention", "Duplicate IDs",
    ])
    filter.target = self
    filter.action = #selector(filterChanged)
    progress = NSProgressIndicator()
    progress.minValue = 0
    progress.maxValue = 1
    timing = label("", size: 12)
    table = NSTableView()
    for (key, title, width) in [
      ("date", "Recorded", 145.0), ("name", "Recording", 220.0),
      ("size", "Size", 80.0), ("source", "Apple source", 180.0),
      ("state", "Mycelia import", 140.0), ("error", "Details", 250.0),
    ] {
      let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier(key))
      column.title = title
      column.width = width
      table.addTableColumn(column)
    }
    table.dataSource = self
    table.delegate = self
    table.rowHeight = 25
    table.usesAlternatingRowBackgroundColors = true
    let scroll = NSScrollView()
    scroll.documentView = table
    scroll.hasVerticalScroller = true
    scroll.hasHorizontalScroller = true
    scroll.borderType = .bezelBorder
    details = label(
      "No permanent audio copies. Only one temporary recording + Opus chunks; removed after processing.",
      size: 12)
    let footer = label(
      "Close window = keep importing in the menu bar. Pause = stop safely. Quit = stop new work.\nSource stays read-only. Mycelia stores the audio; VAD and transcription continue in Pipeline. Login auto-start for Bridge is not configured.",
      size: 12)
    footer.textColor = .secondaryLabelColor
    let stack = NSStackView(views: [
      headline, guidance, serviceRow, sourceRow, range, controls,
      summary, coverage, progress, timing, filter, scroll, details, footer,
    ])
    stack.orientation = .vertical
    stack.alignment = .leading
    stack.spacing = 12
    stack.translatesAutoresizingMaskIntoConstraints = false
    window.contentView!.addSubview(stack)
    var constraints = [
      stack.leadingAnchor.constraint(equalTo: window.contentView!.leadingAnchor, constant: 24),
      stack.trailingAnchor.constraint(equalTo: window.contentView!.trailingAnchor, constant: -24),
      stack.topAnchor.constraint(equalTo: window.contentView!.topAnchor, constant: 24),
      stack.bottomAnchor.constraint(equalTo: window.contentView!.bottomAnchor, constant: -24),
      scroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 230),
    ]
    for view in [
      headline!, guidance!, serviceRow, sourceRow, summary!, coverage!, progress!, timing!, scroll,
      details!,
      footer,
    ] {
      constraints.append(view.widthAnchor.constraint(equalTo: stack.widthAnchor))
    }
    NSLayoutConstraint.activate(constraints)
    window.center()
    updateButtons()
  }
  func numberOfRows(in tableView: NSTableView) -> Int { visibleRows.count }
  func tableView(_ tableView: NSTableView, objectValueFor tableColumn: NSTableColumn?, row: Int)
    -> Any?
  {
    let entry = entries[visibleRows[row]]
    switch tableColumn?.identifier.rawValue {
    case "date":
      return entry.recording.appleDate.isFinite
        ? shortDate(Date(timeIntervalSinceReferenceDate: entry.recording.appleDate)) : "Unknown"
    case "name":
      return entry.recording.title.isEmpty ? entry.recording.filename : entry.recording.title
    case "size":
      return ByteCountFormatter.string(fromByteCount: entry.recording.size, countStyle: .file)
    case "source": return entry.sourceLabel
    case "state": return entry.importLabel
    default: return entry.explanation
    }
  }
  func tableViewSelectionDidChange(_ notification: Notification) {
    guard visibleRows.indices.contains(table.selectedRow) else { return }
    let entry = entries[visibleRows[table.selectedRow]]
    details.stringValue =
      "\(entry.recording.filename) · \(entry.recording.uuid)\n\(entry.sourceLabel) · \(entry.importLabel) · \(entry.explanation)"
  }
  @objc private func filterChanged() { updateSummary() }
  private func updateSummary() {
    summary.stringValue =
      completeScan
      ? LibraryStatistics(entries: entries).text
      : (working
        ? "Checking catalog and Mycelia identities… Counts are not confirmed yet."
        : "Scan library to confirm the current status. No audio is imported by Scan.")
    if completeScan {
      coverage.stringValue =
        checkedRange + "\nPending recording dates: "
        + dateSpan(entries.filter { $0.canImport })
      preferences.set(summary.stringValue, forKey: "directLastScanSummary")
      preferences.set(coverage.stringValue, forKey: "directLastScanRange")
    }
    visibleRows = entries.indices.filter { index in
      let entry = entries[index]
      switch filter?.indexOfSelectedItem ?? 0 {
      case 1: return entry.availability == "local"
      case 2: return entry.canImport
      case 3: return entry.availability == "missing"
      case 4: return entry.availability == "removed"
      case 5:
        return entry.canRetry || entry.state == "conflict" || entry.availability == "unavailable"
      case 6: return entry.databaseCopies > 1 || entry.state == "conflict"
      default: return true
      }
    }
    table.reloadData()
    if !working, visibleRows.indices.contains(table.selectedRow) {
      tableViewSelectionDidChange(Notification(name: NSTableView.selectionDidChangeNotification))
    }
    updateButtons()
  }
  private func setState(_ title: String, _ next: String) {
    headline.stringValue = title
    guidance.stringValue = next
    menuStatus.title = "Bridge: " + title
    menuItem.button?.toolTip = title
    updateButtons()
  }
  private func updateButtons() {
    setupButton?.isEnabled = !working && !serviceReady && !checkingService
    setupButton?.title = serviceReady ? "Importer running" : "Importer setup…"
    sourceButton?.isEnabled = !working
    scanButton?.isEnabled = !working && !choosingSource
    importButton?.isEnabled =
      !working && serviceReady && completeScan && entries.contains { $0.canImport }
    retryButton?.isEnabled =
      !working && serviceReady && completeScan && entries.contains { $0.canRetry }
    pauseButton?.isEnabled = working || automatic?.state == .on
    allDates?.isEnabled = !working
    since?.isEnabled = !working && allDates?.state == .off
    frequency?.isEnabled = !working
    automatic?.isEnabled = !working
  }
  private func resolveSource() throws -> URL {
    guard let bookmark = preferences.data(forKey: bookmarkKey) else {
      throw ProbeError.failed("Choose the Voice Memos Recordings folder first.")
    }
    var stale = false
    let source = try URL(
      resolvingBookmarkData: bookmark, options: [.withSecurityScope, .withoutUI],
      relativeTo: nil, bookmarkDataIsStale: &stale)
    guard !stale else {
      throw ProbeError.failed("Source permission expired. Choose the folder again.")
    }
    return source
  }
  @objc private func chooseSource() {
    guard !working, !choosingSource else { return }
    choosingSource = true
    updateButtons()
    let picker = NSOpenPanel()
    picker.title = "Choose read-only access to Voice Memos"
    picker.message = "Select only Recordings. Bridge never writes to Apple originals."
    picker.prompt = "Use this folder"
    picker.directoryURL = sourceFolder
    picker.canChooseFiles = false
    picker.canChooseDirectories = true
    picker.canCreateDirectories = false
    picker.allowsMultipleSelection = false
    picker.resolvesAliases = false
    picker.beginSheetModal(for: window) { [weak self] response in
      guard let self else { return }
      self.choosingSource = false
      defer { self.updateButtons() }
      guard response == .OK, let source = picker.url else { return }
      do {
        guard source.lastPathComponent == "Recordings",
          source.startAccessingSecurityScopedResource()
        else {
          throw ProbeError.failed("Choose only the Voice Memos Recordings folder")
        }
        defer { source.stopAccessingSecurityScopedResource() }
        _ = try checkedFile(root: source, relativePath: "CloudRecordings.db")
        let bookmark = try source.bookmarkData(
          options: [.withSecurityScope, .securityScopeAllowOnlyReadAccess],
          includingResourceValuesForKeys: nil, relativeTo: nil)
        self.preferences.set(bookmark, forKey: self.bookmarkKey)
        self.setState(
          "Source connected", "Next: Scan library. No audio will be imported by scanning.")
      } catch { self.setState("Source needs attention", error.localizedDescription) }
    }
  }
  @objc private func scan() { begin(importAudio: false) }
  @objc private func importPending() { begin(importAudio: true) }
  @objc private func retryFailed() {
    let alert = NSAlert()
    alert.messageText = "Retry failed recordings in this date range?"
    alert.informativeText =
      "Only these failed recordings will be retried. Existing errors are retained until a successful import."
    alert.addButton(withTitle: "Retry failed")
    alert.addButton(withTitle: "Cancel")
    if alert.runModal() == .alertFirstButtonReturn { begin(importAudio: true, retryErrors: true) }
  }
  private func begin(importAudio: Bool, retryErrors: Bool = false) {
    guard !working, !choosingSource else { return }
    working = true
    nextCheck = nil
    cancellation = ImportCancellation()
    let stop = cancellation
    let boundary = allDates.state == .on ? nil : Calendar.current.startOfDay(for: since.dateValue)
    completeScan = false
    entries = []
    coverage.stringValue =
      "Checking the complete catalog before applying the selected recording-date range."
    updateSummary()
    setState(
      "Scanning library…",
      "Reading Apple metadata and checking existing Mycelia IDs. No archive copies.")
    progress.isIndeterminate = true
    progress.startAnimation(nil)
    updateActivity()
    Task {
      defer {
        working = false
        activeJob = nil
        progress.stopAnimation(nil)
        progress.isIndeterminate = false
        nextCheck = automatic.state == .on ? Date().addingTimeInterval(interval) : nil
        updateSummary()
        updateActivity()
        if pendingQuit { NSApp.reply(toApplicationShouldTerminate: true) }
      }
      do {
        let source = try resolveSource()
        guard source.startAccessingSecurityScopedResource() else {
          throw ProbeError.failed("Source permission unavailable. Choose the folder again.")
        }
        defer { source.stopAccessingSecurityScopedResource() }
        let catalog = try await Task.detached { try readLibrary(source: source, since: nil) }.value
        let connection = try getClient()
        var known: [KnownRecording] = []
        var cursor: String?
        var seenCursors = Set<String>()
        repeat {
          if stop.isCancelled { throw CancellationError() }
          let response = try await connection.json(
            "/inventory", body: cursor.map { ["after": $0] } ?? [:])
          let page = try JSONDecoder().decode(
            InventoryResponse.self, from: JSONSerialization.data(withJSONObject: response))
          known.append(contentsOf: page.records)
          cursor = page.next
          guard known.count <= 10000, page.records.count <= 100,
            cursor == nil || seenCursors.insert(cursor!).inserted
          else {
            throw ProbeError.failed(
              "Incomplete or oversized Mycelia inventory; nothing will be imported.")
          }
          guidance.stringValue =
            "Checked \(known.count) Mycelia source records. Audio is not being transferred."
        } while cursor != nil
        if stop.isCancelled { throw CancellationError() }
        let historyData = preferences.data(forKey: "directCatalogHistoryV1") ?? Data("[]".utf8)
        guard historyData.count <= 16 * 1024 * 1024 else {
          throw ProbeError.failed(
            "Metadata history exceeds its safety limit; nothing will be imported.")
        }
        let history = try JSONDecoder().decode([BridgeRecording].self, from: historyData)
        guard history.count <= 10000 else {
          throw ProbeError.failed(
            "Metadata history exceeds 10,000 recordings; review before importing.")
        }
        entries = reconcileLibrary(catalog, known: known, since: boundary, previouslySeen: history)
        var remembered = Dictionary(
          history.map { ($0.uuid, $0) }, uniquingKeysWith: { first, _ in first })
        for item in catalog { remembered[item.recording.uuid] = item.recording }
        guard remembered.count <= 10000 else {
          throw ProbeError.failed(
            "Metadata history exceeds 10,000 recordings; review before importing.")
        }
        let updatedHistory = try JSONEncoder().encode(Array(remembered.values))
        guard updatedHistory.count <= 16 * 1024 * 1024 else {
          throw ProbeError.failed(
            "Metadata history exceeds its safety limit; nothing will be imported.")
        }
        preferences.set(updatedHistory, forKey: "directCatalogHistoryV1")
        completeScan = true
        let checkedAt = Date()
        preferences.set(checkedAt, forKey: "directLastCheck")
        checkedRange =
          "Checked \(shortDate(checkedAt)) · Selection: "
          + (boundary.map { "since \(shortDate($0)) (inclusive)" } ?? "all recording dates")
          + " · Recording dates in view: " + dateSpan(entries)
        updateSummary()
        progress.stopAnimation(nil)
        progress.isIndeterminate = false
        progress.doubleValue = 1
        guard importAudio else {
          setState(
            "Check complete — no audio imported",
            "Apple source and Mycelia import are separate columns. Missing local audio is not proof of deletion. Import pending skips existing IDs."
          )
          return
        }
        let queue = entries.indices.filter {
          retryErrors ? entries[$0].canRetry : entries[$0].canImport
        }
        progress.isIndeterminate = false
        progress.doubleValue = 0
        var completed = 0
        for index in queue {
          if stop.isCancelled { throw CancellationError() }
          let entry = entries[index]
          entries[index].state = "verifying"
          progress.isIndeterminate = true
          progress.startAnimation(nil)
          updateSummary()
          setState(
            "Importing \(completed + 1) of \(queue.count)",
            "\(entry.recording.filename) — verifying original, then processing in Mycelia.")
          let file = try checkedFile(root: source, relativePath: entry.relativePath)
          let hash = try await Task.detached {
            try recordingHash(
              file, expectedSize: entry.recording.size, cancelled: { stop.isCancelled })
          }.value
          if stop.isCancelled { throw CancellationError() }
          let prepared = try await connection.json(
            "/imports",
            body: [
              "recording": try recordingJSON(entry.recording),
              "retry_error": retryErrors, "sha256": hash,
            ])
          guard let id = prepared["id"] as? String else {
            throw ProbeError.failed("Importer did not return a job ID")
          }
          activeJob = id
          entries[index].state = "transferring"
          updateSummary()
          guidance.stringValue =
            "Transferring one recording to the local importer. No permanent copy is kept."
          _ = try await connection.upload(
            "/imports/\(id)/audio", file: file, size: entry.recording.size)
          var sentCancel = false
          while true {
            if stop.isCancelled && !sentCancel {
              _ = try await connection.json("/imports/\(id)/cancel", body: [:])
              sentCancel = true
            }
            let state = try await connection.json("/imports/\(id)")
            let phase = state["state"] as? String ?? "unknown"
            entries[index].state = phase
            entries[index].error = state["error"] as? String ?? ""
            let done = state["completed_chunks"] as? Int ?? 0
            let total = state["total_chunks"] as? Int ?? 0
            headline.stringValue = "Importing \(completed + 1) of \(queue.count)"
            guidance.stringValue =
              stop.isCancelled
              ? "Stopping the current recording safely…"
              : (phase == "encoding"
                ? "Encoding 10-second Opus chunks, using the same processor as daemon.py."
                : phase == "waiting_for_import_lock"
                  ? "Waiting for another local importer. You can pause safely."
                  : "Saving audio in Mycelia. Success is shown only after database confirmation.")
            if phase == "encoding" {
              let encoding = EncodingPresentation(
                state: state,
                duration: state["duration_seconds"] as? Double ?? entry.recording.duration,
                now: Date().timeIntervalSince1970)
              if encoding.hasProgress {
                progress.stopAnimation(nil)
                progress.isIndeterminate = false
                progress.doubleValue =
                  (Double(completed) + 0.7 * encoding.ratio)
                  / Double(max(queue.count, 1))
              }
              details.stringValue = entry.recording.filename + " · " + encoding.detail
            } else if total > 0 {
              progress.stopAnimation(nil)
              progress.isIndeterminate = false
              progress.doubleValue =
                (Double(completed) + 0.7 + 0.29 * Double(done) / Double(total))
                / Double(max(queue.count, 1))
              details.stringValue =
                "\(entry.recording.filename) · \(phase) · Opus chunks saved: \(done)/\(total)\n\(entries[index].error)"
            } else {
              details.stringValue =
                "\(entry.recording.filename) · \(phase)\n\(entries[index].error)"
            }
            updateSummary()
            if ["imported", "already_imported", "failed", "cancelled"].contains(phase) {
              if phase == "imported" { preferences.set(Date(), forKey: "directLastImport") }
              activeJob = nil
              break
            }
            try await Task.sleep(nanoseconds: 1_000_000_000)
          }
          completed += 1
          progress.doubleValue = Double(completed) / Double(max(queue.count, 1))
        }
        if stop.isCancelled { throw CancellationError() }
        let failures = entries.filter {
          ["error", "failed", "conflict", "unavailable"].contains($0.state)
        }.count
        setState(
          failures == 0 ? "Import complete" : "Import finished with items needing attention",
          failures == 0
            ? "Mycelia has acknowledged the audio. Open Pipeline for VAD and transcription. You can close this window."
            : "Select a row for details. Cached errors were not retried automatically. Open Pipeline for VAD and transcription."
        )
      } catch {
        if let id = activeJob, let client {
          _ = try? await client.json("/imports/\(id)/cancel", body: [:])
        }
        setState(
          stop.isCancelled ? "Import paused" : "Import needs attention",
          stop.isCancelled
            ? "No new recordings will be sent. Saved audio remains in Mycelia. Scan again to resume."
            : error.localizedDescription)
        automatic.state = .off
        preferences.set(false, forKey: "directAutomaticImport")
      }
    }
  }
  private func getClient() throws -> BridgeClient {
    if let client { return client }
    let connection = try BridgeClient(home: accountHome)
    client = connection
    return connection
  }
  @objc private func pause() {
    cancellation.cancel()
    automatic.state = .off
    preferences.set(false, forKey: "directAutomaticImport")
    nextCheck = nil
    setState(
      working ? "Pausing safely…" : "Import paused",
      "No new recordings will be sent. Existing Mycelia audio is preserved.")
    if let id = activeJob, let client {
      Task { _ = try? await client.json("/imports/\(id)/cancel", body: [:]) }
    }
    updateActivity()
  }
  @objc private func rangeChanged() {
    preferences.set(allDates.state == .on, forKey: "directAllDates")
    preferences.set(since.dateValue, forKey: "directSince")
    entries = []
    completeScan = false
    coverage.stringValue = "Date range changed. Scan again; previous counts are not current."
    updateSummary()
  }
  @objc private func changeAutomatic() {
    preferences.set(automatic.state == .on, forKey: "directAutomaticImport")
    nextCheck = automatic.state == .on ? Date() : nil
    updateButtons()
    updateActivity()
  }
  @objc private func changeFrequency() {
    preferences.set(frequency.indexOfSelectedItem, forKey: "directFrequency")
    if automatic.state == .on { nextCheck = Date().addingTimeInterval(interval) }
  }
  private func shortDate(_ date: Date) -> String {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US")
    formatter.dateFormat = "yyyy-MM-dd HH:mm"
    return formatter.string(from: date)
  }
  private func dateSpan(_ rows: [LibraryEntry]) -> String {
    let values = rows.map { $0.recording.appleDate }.filter { $0.isFinite }
    guard let first = values.min(), let last = values.max() else { return "none" }
    return shortDate(Date(timeIntervalSinceReferenceDate: first)) + " → "
      + shortDate(Date(timeIntervalSinceReferenceDate: last))
  }
  private func tick() {
    let lastCheck =
      (preferences.object(forKey: "directLastCheck") as? Date).map(shortDate) ?? "never"
    let lastImport =
      (preferences.object(forKey: "directLastImport") as? Date).map(shortDate) ?? "none in Bridge"
    timing.stringValue =
      "Last check: \(lastCheck) · Last successful import: \(lastImport) · Next: \(nextCheck.map(shortDate) ?? (working ? "after current run" : "manual"))"
    if !checkingService {
      checkingService = true
      Task {
        defer {
          checkingService = false
          updateButtons()
        }
        do {
          let response = try await getClient().json("/status")
          guard response["service"] as? String == "mycelia-voice-memos-importer",
            response["version"] as? Int == 1
          else {
            throw ProbeError.failed("Wrong service on importer port")
          }
          let free = response["free_bytes"] as? Int64 ?? 0
          serviceStatus.stringValue =
            "Local importer: ready · \(ByteCountFormatter.string(fromByteCount: free, countStyle: .file)) free"
          serviceReady = true
          if working, let active = response["active"] as? [String: Any],
            active["id"] as? String == activeJob, active["state"] as? String == "receiving"
          {
            let received = active["received_bytes"] as? Int64 ?? 0
            let size = active["size"] as? Int64 ?? 0
            details.stringValue =
              "Transferring to local importer: \(ByteCountFormatter.string(fromByteCount: received, countStyle: .file)) / \(ByteCountFormatter.string(fromByteCount: size, countStyle: .file))"
          }
        } catch {
          serviceReady = false
          serviceStatus.stringValue = "Local importer: unavailable — open Importer setup"
          if !working {
            client?.close()
            client = nil
          }
        }
      }
    }
    if let nextCheck, nextCheck <= Date(), !working, !choosingSource, serviceReady {
      begin(importAudio: true)
    }
  }
  private func updateActivity() {
    if working || automatic.state == .on {
      if activity == nil {
        activity = ProcessInfo.processInfo.beginActivity(
          options: [.userInitiatedAllowingIdleSystemSleep],
          reason: "Import Voice Memos in background")
      }
    } else if let activity {
      ProcessInfo.processInfo.endActivity(activity)
      self.activity = nil
    }
  }
  @objc private func startService() {
    // Never alter the active import headline or ask the sandbox to execute a
    // Terminal document. Setup is a user-run command, not a broader permission.
    guard !working, !serviceReady else { return }
    do {
      guard
        let repository = Bundle.main.object(forInfoDictionaryKey: "MyceliaRepository") as? String
      else {
        throw ProbeError.failed("Repository path missing; rebuild Bridge.")
      }
      let command = try importerSetupCommand(repository: repository)
      let alert = NSAlert()
      alert.messageText = "Set up the local importer"
      alert.informativeText =
        "1. Copy the command below.\n2. Open Terminal yourself, paste and press Return.\n3. Wait for Ready, then return here.\n\nNo Full Disk Access is needed. This installs/starts only the local helper, not audio imports."
      let field = NSTextField(wrappingLabelWithString: command)
      field.isSelectable = true
      field.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
      field.frame = NSRect(x: 0, y: 0, width: 500, height: 65)
      alert.accessoryView = field
      alert.addButton(withTitle: "Copy command")
      alert.addButton(withTitle: "Close")
      alert.beginSheetModal(for: window) { response in
        guard response == .alertFirstButtonReturn else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(command, forType: .string)
      }
    } catch {
      setState("Importer setup needs attention", error.localizedDescription)
    }
  }
  @objc private func copyPath() {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(sourceFolder.path, forType: .string)
  }
  @objc private func openPipeline() {
    NSWorkspace.shared.open(URL(string: "https://localhost:4433/audio/pipeline")!)
  }
  @objc private func showWindow() {
    NSApp.setActivationPolicy(.regular)
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
  }
  @objc private func hideWindow() {
    window.orderOut(nil)
    NSApp.setActivationPolicy(.accessory)
  }
  func windowShouldClose(_ sender: NSWindow) -> Bool {
    hideWindow()
    return false
  }
  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool
  {
    showWindow()
    return true
  }
  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    pause()
    guard working else { return .terminateNow }
    pendingQuit = true
    return .terminateLater
  }
}
