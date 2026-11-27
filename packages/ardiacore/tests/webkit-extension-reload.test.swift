import AppKit
import Foundation
import Testing
import WebKit

@Suite(.serialized) @MainActor struct ExtensionReloadTests {
  func pause(_ seconds: Double = 1) async { try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000)) }

  func eventually(_ condition: () async -> Bool) async -> Bool {
    for _ in 0..<150 {
      if await condition() { return true }
      await pause(0.1)
    }
    return await condition()
  }

  func read(_ page: WKWebView, _ expression: String) async -> String {
    ((try? await page.evaluateJavaScript("String(\(expression) ?? '')")) as? String) ?? ""
  }

  func mark(_ page: WKWebView) async { _ = try? await page.evaluateJavaScript("window.keptSinceMarked = 'yes'") }
  func kept(_ page: WKWebView) async -> Bool { await read(page, "window.keptSinceMarked") == "yes" }
  func reply(_ page: WKWebView) async -> String { await read(page, "document.documentElement.dataset.reply") }

  @Test func `loading an extension again reloads the open pages it runs on so their scripts get replies`() async throws {
    guard #available(macOS 15.4, *) else { return }
    NSApplication.shared.setActivationPolicy(.prohibited)
    let server = try LoopbackPages()
    defer { server.stop() }
    #expect(await eventually { server.port != 0 })
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("ardia-extension-reload-" + UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let source = root.appendingPathComponent("source")
    try FileManager.default.createDirectory(at: source, withIntermediateDirectories: true)
    try Data(#"{"manifest_version":3,"name":"Reload fixture","version":"1","permissions":["storage"],"host_permissions":["http://127.0.0.1/*","http://localhost/*"],"background":{"scripts":["background.js"]},"content_scripts":[{"matches":["http://127.0.0.1/*"],"js":["content.js"]}]}"#.utf8)
      .write(to: source.appendingPathComponent("manifest.json"))
    try Data("const boot = Math.random().toString(36).slice(2); browser.runtime.onMessage.addListener(() => Promise.resolve({ boot }));".utf8)
      .write(to: source.appendingPathComponent("background.js"))
    try Data("browser.runtime.sendMessage({ ask: true }).then((answer) => { document.documentElement.dataset.reply = answer.boot; });".utf8)
      .write(to: source.appendingPathComponent("content.js"))
    ArdiaHost.dataDirectory = root.appendingPathComponent("data").path
    let host = WebKitExtensionHost(profile: "fixture")
    host.restore()
    let fingerprint = try WebKitExtensionPackage.snapshot(source.path, into: root.appendingPathComponent("inspected")).fingerprint
    let origins = ["http://127.0.0.1/*"]
    func load() async throws -> [String: Any] {
      try await withCheckedThrowingContinuation { continuation in
        host.load(path: source.path, fingerprint: fingerprint, permissions: ["storage"], origins: origins) { continuation.resume(with: $0) }
      }
    }

    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 800, height: 600), styleMask: [.titled], backing: .buffered, defer: true)
    window.isReleasedWhenClosed = false
    func open(_ address: String) -> (tab: WebKitTab, page: WebKitWebView) {
      let configuration = WKWebViewConfiguration()
      configuration.websiteDataStore = host.store
      configuration.webExtensionController = host.controller
      let tab = WebKitTab(frame: NSRect(x: 0, y: 0, width: 800, height: 600))
      let page = WebKitWebView(frame: tab.bounds, configuration: configuration)
      tab.webView = page
      tab.addSubview(page)
      window.contentView?.addSubview(tab)
      page.load(URLRequest(url: URL(string: address)!))
      return (tab, page)
    }
    let matching = open("http://127.0.0.1:\(server.port)/watch")
    let other = open("http://localhost:\(server.port)/other")
    #expect(await eventually { matching.page.title == "page" && !matching.page.isLoading })
    host.attach(matching.tab)
    host.attach(other.tab)

    await mark(matching.page)
    let first = try await load()
    let id = try #require(first["id"] as? String)
    await pause(1.5)
    #expect(await kept(matching.page), "a first approval does not reload pages")
    matching.page.reload()
    #expect(await eventually { await !self.reply(matching.page).isEmpty })
    var previous = await reply(matching.page)

    func recovers(_ step: String, _ change: () async throws -> Void) async throws {
      await mark(matching.page)
      await mark(other.page)
      try await change()
      let recovered = await eventually {
        let answer = await self.reply(matching.page)
        return !answer.isEmpty && answer != previous
      }
      #expect(recovered, "\(step): the open page gets a reply from the new background")
      #expect(await !kept(matching.page), "\(step): the page the extension runs on was reloaded")
      #expect(await kept(other.page), "\(step): a page the extension does not run on is left alone")
      previous = await reply(matching.page)
    }

    try await recovers("loading again") { _ = try await load() }
    try await recovers("changing grants") { _ = try host.grant(id: id, permissions: ["storage"], origins: origins) }
    await mark(matching.page)
    _ = try host.unload(id: id)
    await pause(1.5)
    #expect(await kept(matching.page), "disabling does not reload pages")
    try await recovers("enabling again") { _ = try await load() }

    try? host.controller.unload(try #require(host.contexts[id]))
    window.close()
  }
}
