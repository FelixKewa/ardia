import CryptoKit
import Darwin
import Foundation

struct WebKitExtensionFailure: LocalizedError {
  let message: String
  var errorDescription: String? { message }
}

struct WebKitExtensionRecord: Codable {
  var id: String
  var path: String
  var fingerprint: String
  var name: String
  var version: String
  var enabled: Bool
  var requestedPermissions: [String]
  var requestedOrigins: [String]
  var permissions: [String]
  var origins: [String]
}

struct WebKitExtensionDocument: Codable {
  let version: Int
  let extensions: [WebKitExtensionRecord]

  private enum CodingKeys: String, CodingKey { case version, extensions }

  init(extensions: [WebKitExtensionRecord]) {
    version = 1
    self.extensions = extensions
  }

  init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    version = try values.decode(Int.self, forKey: .version)
    guard version == 1 else {
      throw DecodingError.dataCorruptedError(forKey: .version, in: values, debugDescription: "Unsupported extension settings version.")
    }
    extensions = try values.decode([WebKitExtensionRecord].self, forKey: .extensions)
  }
}

enum WebKitExtensionPackage {
  static let files = DispatchQueue(label: "ardia.webkit.extension-files", qos: .utility)
  static let supportedPermissions: Set<String> = ["activeTab", "scripting", "storage", "unlimitedStorage", "contextMenus", "tabs"]
  static let maxBytes = 512 * 1024 * 1024
  static let maxFiles = 50000

  struct Snapshot {
    let source: URL
    let directory: URL
    let fingerprint: String
    let legacyFingerprint: String
  }

  static func failure(_ message: String) -> WebKitExtensionFailure { WebKitExtensionFailure(message: message) }

  static func source(_ path: String) throws -> URL {
    guard path.hasPrefix("/"), !path.contains("\0") else { throw failure("Choose an extension folder using an absolute path.") }
    let url = URL(fileURLWithPath: path, isDirectory: true).standardizedFileURL
    let values = try url.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
    guard values.isDirectory == true, values.isSymbolicLink != true else { throw failure("The extension must be a folder, not a symbolic link.") }
    guard let canonical = realpath(url.path, nil) else { throw failure("The extension folder could not be resolved.") }
    defer { free(canonical) }
    return URL(fileURLWithPath: String(cString: canonical), isDirectory: true)
  }

  static func snapshot(_ path: String, into directory: URL) throws -> Snapshot {
    let root = try source(path)
    let manager = FileManager.default
    let names = try resources(root)
    try manager.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    do {
      let fingerprints = try fingerprints(names, root: root) { name, data in
        let target = directory.appendingPathComponent(name)
        try manager.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
        guard !manager.fileExists(atPath: target.path) else { throw failure("The extension contains colliding resource paths.") }
        try data.write(to: target, options: .atomic)
      }
      return Snapshot(source: root, directory: directory, fingerprint: fingerprints.current, legacyFingerprint: fingerprints.legacy)
    } catch {
      try? manager.removeItem(at: directory)
      throw error
    }
  }

  static func unchanged(_ path: String, since approved: String) throws -> Bool {
    let root = try source(path)
    let found = try fingerprints(resources(root), root: root) { _, _ in }
    return found.current == approved || found.legacy == approved
  }

  private static func resources(_ root: URL) throws -> [String: String] {
    guard let entries = FileManager.default.enumerator(at: root, includingPropertiesForKeys: [.isRegularFileKey, .isDirectoryKey, .isSymbolicLinkKey, .fileSizeKey]) else {
      throw failure("The extension folder could not be read.")
    }
    var names: [String: String] = [:]
    var size = 0
    for case let file as URL in entries {
      let values = try file.resourceValues(forKeys: [.isRegularFileKey, .isDirectoryKey, .isSymbolicLinkKey, .fileSizeKey])
      guard values.isSymbolicLink != true else { throw failure("Extension folders must not contain symbolic links.") }
      if values.isDirectory == true { continue }
      guard values.isRegularFile == true, file.path.hasPrefix(root.path + "/") else { throw failure("The extension contains an unsupported file.") }
      size += values.fileSize ?? maxBytes
      let name = String(file.path.dropFirst(root.path.count + 1))
      let canonical = name.precomposedStringWithCanonicalMapping
      guard names[canonical] == nil else { throw failure("The extension contains equivalent resource paths.") }
      names[canonical] = name
      guard names.count <= maxFiles, size <= maxBytes else { throw failure("The extension exceeds the package size limit.") }
    }
    guard names["manifest.json"] != nil else { throw failure("The selected folder has no manifest.json.") }
    return names
  }

  private static func fingerprints(_ names: [String: String], root: URL, each: (String, Data) throws -> Void) throws -> (current: String, legacy: String) {
    var digest = SHA256()
    var legacyDigest = SHA256()
    var read = 0
    for canonical in names.keys.sorted() {
      guard let name = names[canonical] else { throw failure("The extension contains an invalid resource path.") }
      let original = root.appendingPathComponent(name)
      let values = try original.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
      guard values.isRegularFile == true, values.isSymbolicLink != true else { throw failure("The extension changed while it was being inspected.") }
      let data = try readFile(name, root: root, limit: min(maxBytes - read, name == "manifest.json" ? 1024 * 1024 : maxBytes))
      read += data.count
      guard read <= maxBytes, name != "manifest.json" || data.count <= 1024 * 1024 else { throw failure("The extension exceeds the package size limit.") }
      digest.update(data: Data("\(canonical.utf8.count):\(canonical):\(data.count):".utf8))
      digest.update(data: data)
      legacyDigest.update(data: Data("\(name.utf8.count):\(name):\(data.count):".utf8))
      legacyDigest.update(data: data)
      try each(name, data)
    }
    return (digest.finalize().map { String(format: "%02x", $0) }.joined(), legacyDigest.finalize().map { String(format: "%02x", $0) }.joined())
  }

  private static func readFile(_ name: String, root: URL, limit: Int) throws -> Data {
    let parts = name.split(separator: "/").map(String.init)
    guard !parts.isEmpty, parts.allSatisfy({ $0 != "." && $0 != ".." }) else { throw failure("The extension contains an invalid path.") }
    var parent = open(root.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    guard parent >= 0 else { throw failure("The extension folder could not be opened safely.") }
    defer { close(parent) }
    for part in parts.dropLast() {
      let child = openat(parent, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
      guard child >= 0 else { throw failure("The extension contains an unsafe directory.") }
      close(parent)
      parent = child
    }
    let descriptor = openat(parent, parts.last!, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
    guard descriptor >= 0 else { throw failure("An extension file could not be opened safely.") }
    defer { close(descriptor) }
    var details = stat()
    guard fstat(descriptor, &details) == 0, details.st_mode & S_IFMT == S_IFREG,
      details.st_size >= 0, details.st_size <= limit else { throw failure("An extension file is not regular or exceeds the size limit.") }
    var result = Data()
    var buffer = [UInt8](repeating: 0, count: 65536)
    while true {
      let count = Darwin.read(descriptor, &buffer, min(buffer.count, limit - result.count + 1))
      guard count >= 0 else { throw failure("An extension file could not be read.") }
      if count == 0 { return result }
      guard result.count + count <= limit else { throw failure("The extension changed or exceeds the size limit.") }
      result.append(buffer, count: count)
    }
  }

  static func exactOrigin(_ pattern: String, allowLoopback: Bool = false) -> Bool {
    guard pattern.hasSuffix("/*"), let url = URLComponents(string: String(pattern.dropLast(1))),
      let host = url.host, !host.isEmpty, !host.contains("*"), !host.contains("%"),
      url.user == nil, url.password == nil, url.port == nil, url.query == nil, url.fragment == nil,
      url.path == "/", pattern == "\(url.scheme ?? "")://\(host)/*" else { return false }
    return url.scheme == "https" || (allowLoopback && url.scheme == "http" && ["localhost", "127.0.0.1"].contains(host))
  }

  static func allows(_ url: URL, origins: [String], allowLoopback: Bool = false) -> Bool {
    guard url.user == nil, url.password == nil, let host = url.host?.lowercased(), let scheme = url.scheme?.lowercased(),
      url.port == nil || (allowLoopback && scheme == "http" && ["localhost", "127.0.0.1"].contains(host)) else { return false }
    return origins.contains("\(scheme)://\(host)/*")
  }
}
