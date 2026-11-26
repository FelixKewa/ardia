import CryptoKit
import Foundation

enum WebKitExtensionPreparation {
  struct Manifest {
    let data: Data
    let supported: Bool
  }

  static let websites = ["http://*/*", "https://*/*"]
  static let kimchiHashes: Set<String> = [
    "891ea6e2a765ed997fd6348aa0cd02a7a38469fe4e305bbca561a1df073716f6",
    "4044f6ea0d2cce9a09156ff0855166f660bea6d64e393440cdf72f2445bb5e6f",
  ]

  static func manifest(_ data: Data, allWebsites: Bool, knownHashes: Set<String> = kimchiHashes, read: (String) throws -> Data) throws -> Manifest {
    guard var manifest = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
      throw WebKitExtensionPackage.failure("The extension manifest is invalid.")
    }
    let declared = (manifest["host_permissions"] as? [String] ?? []) + (manifest["optional_host_permissions"] as? [String] ?? []) +
      (manifest["permissions"] as? [String] ?? []) + (manifest["optional_permissions"] as? [String] ?? []) +
      (manifest["content_scripts"] as? [[String: Any]] ?? []).flatMap { $0["matches"] as? [String] ?? [] }
    let broad = declared.contains("<all_urls>") || declared.contains("*://*/*") || websites.allSatisfy(declared.contains)
    if broad { return Manifest(data: data, supported: true) }
    let script = "contentScripts/index.global.js"
    let known = manifest["name"] as? String == "Kimchi Reader" && manifest["version"] as? String == "0.21.7" &&
      manifest["manifest_version"] as? Int == 3 &&
      (manifest["content_scripts"] as? [[String: Any]] ?? []).contains { ($0["js"] as? [String] ?? []).contains(script) }
    let code = known ? try? read(script) : nil
    let supported = code.map { knownHashes.contains(SHA256.hash(data: $0).map { String(format: "%02x", $0) }.joined()) } ?? false
    guard allWebsites, supported else { return Manifest(data: data, supported: supported) }
    manifest["optional_host_permissions"] = Array(Set((manifest["optional_host_permissions"] as? [String] ?? []) + websites)).sorted()
    return Manifest(data: try JSONSerialization.data(withJSONObject: manifest, options: [.sortedKeys, .withoutEscapingSlashes]), supported: true)
  }
}
