import CryptoKit
import Darwin
import Foundation

enum WebKitImportedStores {
  struct Entry: Codable {
    let profile: String
    let sourceScope: String
    let sourceProfile: String
    let identifier: UUID
  }

  struct Document: Codable {
    let version: Int
    let destination: String
    let entries: [Entry]
  }

  static let filename = "WebKit Imported Stores.json"
  private static let installedData: Data? = {
    guard LaunchConfig.shared.dataDirectory == nil, Bundle.main.bundleIdentifier == "com.ardia.browser" else { return nil }
    let file = URL(fileURLWithPath: ArdiaHost.dataDirectory).appendingPathComponent(filename)
    let descriptor = open(file.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
    guard descriptor >= 0 else { return nil }
    defer { close(descriptor) }
    var details = stat()
    guard fstat(descriptor, &details) == 0, details.st_mode & S_IFMT == S_IFREG,
      details.st_uid == getuid(), details.st_size > 0, details.st_size <= 1024 * 1024 else { return nil }
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 8192)
    while data.count <= 1024 * 1024 {
      let count = Darwin.read(descriptor, &buffer, min(buffer.count, 1024 * 1024 - data.count + 1))
      guard count >= 0 else { return nil }
      if count == 0 { return data }
      data.append(buffer, count: count)
    }
    return nil
  }()

  static func identifier(scope: String, profile: String) -> UUID {
    var bytes = Array(SHA256.hash(data: Data("ardia.webkit|\(scope)|\(profile)".utf8)).prefix(16))
    bytes[6] = (bytes[6] & 0x0F) | 0x50
    bytes[8] = (bytes[8] & 0x3F) | 0x80
    return bytes.withUnsafeBufferPointer { NSUUID(uuidBytes: $0.baseAddress!) as UUID }
  }

  static func importedProfile(scope: String, profile: String) -> String {
    let digest = SHA256.hash(data: Data("ardia.preview-import|\(scope)|\(profile)".utf8))
    return "preview-import-" + digest.prefix(16).map { String(format: "%02x", $0) }.joined()
  }

  static func resolve(_ profile: String, scratch: String?, bundle: String?, destination: String, data: Data?) -> UUID? {
    guard scratch == nil, bundle == "com.ardia.browser", profile.hasPrefix("preview-import-"),
      let data, data.count <= 1024 * 1024,
      let document = try? JSONDecoder().decode(Document.self, from: data),
      document.version == 1, document.destination == destination, document.entries.count <= 100 else { return nil }
    var profiles = Set<String>()
    var identifiers = Set<UUID>()
    for entry in document.entries {
      guard entry.sourceScope.hasPrefix("/"), entry.sourceScope != "/", !entry.sourceScope.contains("\0"),
        (entry.sourceScope as NSString).standardizingPath == entry.sourceScope,
        entry.sourceScope != (destination as NSString).deletingLastPathComponent,
        entry.sourceProfile.isEmpty || entry.sourceProfile.range(of: "^[A-Za-z0-9_-]{1,200}$", options: .regularExpression) != nil,
        !entry.sourceProfile.hasPrefix("incognito"),
        entry.profile == importedProfile(scope: entry.sourceScope, profile: entry.sourceProfile),
        entry.identifier == identifier(scope: entry.sourceScope, profile: entry.sourceProfile),
        profiles.insert(entry.profile).inserted, identifiers.insert(entry.identifier).inserted else { return nil }
    }
    return document.entries.first { $0.profile == profile }?.identifier
  }

  static func resolve(_ profile: String) -> UUID? {
    guard LaunchConfig.shared.dataDirectory == nil, profile.hasPrefix("preview-import-") else { return nil }
    return resolve(profile, scratch: nil, bundle: Bundle.main.bundleIdentifier, destination: ArdiaHost.dataDirectory, data: installedData)
  }
}
