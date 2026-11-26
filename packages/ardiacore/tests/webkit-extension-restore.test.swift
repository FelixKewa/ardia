import AppKit
import Foundation
import Testing
import WebKit

enum ArdiaHost { nonisolated(unsafe) static var dataDirectory = "" }
final class LaunchConfig {
  nonisolated(unsafe) static let shared = LaunchConfig()
  let testInstance = false
}
final class WebKitStores {
  nonisolated(unsafe) static var identifier = UUID()
  static func storeIdentifier(_ profile: String) -> UUID { identifier }
  func dataStore(for profile: String) -> WKWebsiteDataStore { .nonPersistent() }
}
final class WebKitHub {
  nonisolated(unsafe) static let shared = WebKitHub()
  let stores = WebKitStores()
}
enum WebKitExtensions { typealias Reply = (Result<[String: Any], Error>) -> Void }
final class WebKitExtensionTabAdapter: NSObject, WKWebExtensionTab {}
final class WebKitExtensionWindowAdapter {}
final class WebKitExtensionPendingTab {}
@available(macOS 15.4, *)
extension WebKitExtensionHost: WKWebExtensionControllerDelegate {
  func closePopup() {}
  func cancelPendingTabs(contextId: String?) {}
}
extension NSImage { func pngDataURL(points: CGFloat, scale: CGFloat) -> String? { nil } }

@Suite(.serialized) @MainActor struct ExtensionRestoreTests {
  struct Installed {
    let root: URL
    let id: String
    let package: URL
    let settings: URL
  }

  func installedByEarlierRelease() throws -> Installed {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("ardia-extension-restore-" + UUID().uuidString)
    let source = root.appendingPathComponent("source")
    try FileManager.default.createDirectory(at: source.appendingPathComponent("static"), withIntermediateDirectories: true)
    try Data(#"{"manifest_version":3,"name":"Fixture","description":"Synthetic","version":"1.2","permissions":["storage","tabs"],"host_permissions":["https://example.com/*"]}"#.utf8)
      .write(to: source.appendingPathComponent("manifest.json"))
    try Data("synthetic".utf8).write(to: source.appendingPathComponent("static/가.json"))
    ArdiaHost.dataDirectory = root.appendingPathComponent("data").path
    WebKitStores.identifier = UUID()
    let directory = root.appendingPathComponent("data/WebKit Extensions/" + WebKitStores.identifier.uuidString)
    let id = UUID().uuidString.lowercased()
    let staging = directory.appendingPathComponent("staging")
    let fingerprint = try WebKitExtensionPackage.snapshot(source.path, into: staging).fingerprint
    let package = directory.appendingPathComponent(id).appendingPathComponent(fingerprint)
    try FileManager.default.createDirectory(at: package.deletingLastPathComponent(), withIntermediateDirectories: true)
    try FileManager.default.moveItem(at: staging, to: package)
    let settings = directory.appendingPathComponent("extensions.json")
    try Data("""
      {"version":1,"extensions":[{"id":"\(id)","path":"\(source.path)","fingerprint":"\(fingerprint)","name":"Fixture","version":"1.2","enabled":true,
      "requestedPermissions":["storage","tabs"],"requestedOrigins":["https://example.com/*"],"permissions":["storage","tabs"],"origins":["https://example.com/*"]}]}
      """.utf8).write(to: settings)
    try FileManager.default.removeItem(at: source)
    return Installed(root: root, id: id, package: package, settings: settings)
  }

  @available(macOS 15.4, *)
  func listed(_ host: WebKitExtensionHost, within seconds: TimeInterval = 30) async -> [[String: Any]] {
    await withCheckedContinuation { continuation in host.list(within: seconds) { continuation.resume(returning: $0) } }
  }

  @Test func `a later launch restores a saved approval with the same grants and no review`() async throws {
    guard #available(macOS 15.4, *) else { return }
    let installed = try installedByEarlierRelease()
    defer { try? FileManager.default.removeItem(at: installed.root) }
    let saved = try Data(contentsOf: installed.settings)
    for _ in 1...2 {
      let host = WebKitExtensionHost(profile: "fixture")
      host.restore()
      var answers: [[[String: Any]]] = []
      host.list { answers.append($0) }
      #expect(answers.isEmpty)
      let rows = await listed(host)
      #expect(answers.count == 1)
      let row = try #require(rows.first)
      #expect(rows.count == 1)
      #expect(row["id"] as? String == installed.id)
      #expect(row["loaded"] as? Bool == true)
      #expect(row["enabled"] as? Bool == true)
      #expect(row["errors"] as? [String] == [])
      #expect(row["grantedPermissions"] as? [String] == ["storage", "tabs"])
      #expect(row["grantedOrigins"] as? [String] == ["https://example.com/*"])
      let context = try #require(host.contexts[installed.id])
      #expect(context.isLoaded)
      #expect(Set(context.grantedPermissions.keys.map(\.rawValue)) == ["storage", "tabs"])
      #expect(context.grantedPermissionMatchPatterns.keys.map(\.string) == ["https://example.com/*"])
      #expect(context.uniqueIdentifier == installed.id)
      #expect(context.baseURL.absoluteString.hasPrefix("webkit-extension://" + installed.id))
      try host.controller.unload(context)
    }
    #expect(try Data(contentsOf: installed.settings) == saved)
  }

  @Test func `a listing that outlasts its deadline says the extension is still loading and answers once`() async throws {
    guard #available(macOS 15.4, *) else { return }
    let installed = try installedByEarlierRelease()
    defer { try? FileManager.default.removeItem(at: installed.root) }
    let held = DispatchSemaphore(value: 0)
    WebKitExtensionPackage.files.async { _ = held.wait(timeout: .now() + 20) }
    let host = WebKitExtensionHost(profile: "fixture")
    host.restore()
    var answers = 0
    let early: [[String: Any]] = await withCheckedContinuation { continuation in
      host.list(within: 0.2) { rows in
        answers += 1
        if answers == 1 { continuation.resume(returning: rows) }
      }
    }
    #expect(early.first?["loaded"] as? Bool == false)
    #expect(early.first?["errors"] as? [String] == ["Still loading. Open this page again in a moment."])
    held.signal()
    let rows = await listed(host)
    #expect(rows.first?["loaded"] as? Bool == true)
    #expect(rows.first?["errors"] as? [String] == [])
    #expect(answers == 1)
  }

  @Test func `a changed installed package is listed with its reason and keeps its saved approval`() async throws {
    guard #available(macOS 15.4, *) else { return }
    let installed = try installedByEarlierRelease()
    defer { try? FileManager.default.removeItem(at: installed.root) }
    try Data("changed".utf8).write(to: installed.package.appendingPathComponent("static/가.json"))
    let host = WebKitExtensionHost(profile: "fixture")
    host.restore()
    let rows = await listed(host)
    #expect(rows.first?["loaded"] as? Bool == false)
    #expect(rows.first?["enabled"] as? Bool == true)
    #expect(rows.first?["errors"] as? [String] == ["The installed extension changed. Inspect and load it again."])
    #expect(host.contexts.isEmpty)
  }
}
