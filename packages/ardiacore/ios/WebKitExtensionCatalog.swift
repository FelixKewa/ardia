import Darwin
import Foundation

final class WebKitExtensionCatalog {
  let root: URL
  let directory: URL
  private(set) var records: [String: WebKitExtensionRecord] = [:]
  private(set) var failure: Error?
  private var operation: UUID?

  init(root: URL) {
    self.root = root
    directory = root.appendingPathComponent("Shared Approvals")
    do {
      guard let data = try Self.contents(of: directory.appendingPathComponent("extensions.json")) else { return }
      let saved = try JSONDecoder().decode(WebKitExtensionDocument.self, from: data)
      var paths = Set<String>()
      for record in saved.extensions {
        guard Self.valid(record), records[record.id] == nil, paths.insert(record.path).inserted else { throw WebKitExtensionPackage.failure("Shared extension approvals contain invalid or duplicate records.") }
        records[record.id] = record
      }
    } catch { records = [:]; failure = WebKitExtensionPackage.failure("Shared extension approvals could not be read. Restore their saved document before changing access.") }
  }

  private static func contents(of file: URL) throws -> Data? {
    let descriptor = open(file.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
    guard descriptor >= 0 else {
      if errno == ENOENT { return nil }
      throw WebKitExtensionPackage.failure("Saved extension approvals could not be read.")
    }
    defer { close(descriptor) }
    var details = stat()
    guard fstat(descriptor, &details) == 0, details.st_mode & S_IFMT == S_IFREG,
      details.st_uid == getuid(), details.st_size >= 0, details.st_size <= 1024 * 1024 else {
      throw WebKitExtensionPackage.failure("Saved extension approvals are not a valid local document.")
    }
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 8192)
    while true {
      let count = Darwin.read(descriptor, &buffer, min(buffer.count, 1024 * 1024 - data.count + 1))
      guard count >= 0, data.count + count <= 1024 * 1024 else { throw WebKitExtensionPackage.failure("Saved extension approvals exceed the size limit.") }
      if count == 0 { return data }
      data.append(buffer, count: count)
    }
  }

  static func disabled(_ record: WebKitExtensionRecord, path: String, unless keep: (WebKitExtensionRecord) -> Bool) -> WebKitExtensionRecord {
    guard record.path == path, record.enabled, !keep(record) else { return record }
    var result = record
    result.enabled = false
    return result
  }

  func share(_ record: WebKitExtensionRecord, token: UUID, installing install: (() throws -> Void) throws -> Void,
             turningOff disable: ((WebKitExtensionRecord) -> Bool) throws -> Void) throws -> Result<Void, Error> {
    var updated = records
    updated[record.id] = record
    try install { try save(updated, token: token) }
    return Result { try disable { $0.grantsWithin(record) } }
  }

  func disableProfileCopies(path: String, except excluded: Set<String> = [], unless keep: (WebKitExtensionRecord) -> Bool = { _ in false }) throws {
    let entries: [URL]
    do { entries = try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil) }
    catch CocoaError.fileReadNoSuchFile { return }
    var unsaved = 0
    for profile in entries where UUID(uuidString: profile.lastPathComponent) != nil && !excluded.contains(profile.lastPathComponent) {
      let file = profile.appendingPathComponent("extensions.json")
      do {
        guard let data = try Self.contents(of: file), let saved = try? JSONDecoder().decode(WebKitExtensionDocument.self, from: data) else { continue }
        let updated = saved.extensions.map { Self.disabled($0, path: path, unless: keep) }
        if updated != saved.extensions { try JSONEncoder().encode(WebKitExtensionDocument(extensions: updated)).write(to: file, options: .atomic) }
      } catch { unsaved += 1 }
    }
    guard unsaved == 0 else { throw WebKitExtensionPackage.failure("Some profiles' saved extension settings could not be updated. Try again.") }
  }

  static func valid(_ record: WebKitExtensionRecord) -> Bool {
    UUID(uuidString: record.id) != nil && record.fingerprint.count == 64 && record.fingerprint.allSatisfy(\.isHexDigit) &&
      record.path.hasPrefix("/") && !record.path.contains("\0") &&
      Set(record.permissions).count == record.permissions.count && Set(record.origins).count == record.origins.count &&
      Set(record.permissions).isSubset(of: WebKitExtensionPackage.supportedPermissions) &&
      Set(record.permissions).isSubset(of: Set(record.requestedPermissions)) &&
      (record.allWebsites == true ? Set(record.origins) == Set(WebKitExtensionPreparation.websites) : record.origins.allSatisfy { WebKitExtensionPackage.exactOrigin($0, allowLoopback: true) })
  }

  func begin() throws -> UUID {
    if let failure { throw failure }
    guard operation == nil else { throw WebKitExtensionPackage.failure("Another extension approval is still being saved. Try again shortly.") }
    let token = UUID()
    operation = token
    return token
  }

  func active(_ token: UUID) -> Bool { operation == token }
  func cancel() { operation = nil }
  func finish(_ token: UUID) { if operation == token { operation = nil } }

  func package(_ record: WebKitExtensionRecord) -> URL {
    directory.appendingPathComponent(record.id).appendingPathComponent(record.fingerprint)
  }

  func overlay(local: [String: WebKitExtensionRecord]) -> [String: WebKitExtensionRecord] {
    var result: [String: WebKitExtensionRecord] = [:]
    for var shared in records.values where shared.allProfiles != false {
      if let existing = local.values.first(where: { $0.path == shared.path }) { shared.id = existing.id }
      if let existing = local[shared.id], existing.path != shared.path { continue }
      result[shared.id] = shared
    }
    return result
  }

  func save(_ updated: [String: WebKitExtensionRecord], token: UUID) throws {
    if let failure { throw failure }
    guard active(token), Set(updated.values.map(\.path)).count == updated.count,
      updated.allSatisfy({ $0.key == $0.value.id && Self.valid($0.value) }) else {
      throw WebKitExtensionPackage.failure("The shared extension approval is no longer current.")
    }
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    try JSONEncoder().encode(WebKitExtensionDocument(extensions: updated.values.sorted { $0.id < $1.id }))
      .write(to: directory.appendingPathComponent("extensions.json"), options: .atomic)
    records = updated
  }
}
