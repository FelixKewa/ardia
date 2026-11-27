import AppKit
import Foundation
import Testing
import WebKit

@Suite(.serialized) @MainActor struct ExtensionKeepAliveTests {
  func pause(_ seconds: Double = 0.3) async { try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000)) }

  func eventually(_ seconds: Double = 15, _ condition: () async -> Bool) async -> Bool {
    for _ in 0..<Int(seconds * 10) {
      if await condition() { return true }
      await pause(0.1)
    }
    return await condition()
  }

  func read(_ page: WKWebView, _ expression: String) async -> String {
    ((try? await page.evaluateJavaScript("String(\(expression) ?? '')")) as? String) ?? ""
  }

  @Test func `a background stays awake only while a live page runs the extension, so a slow request is answered`() async throws {
    guard #available(macOS 15.4, *) else { return }
    NSApplication.shared.setActivationPolicy(.prohibited)
    let server = try LoopbackPages()
    defer { server.stop() }
    #expect(await eventually { server.port != 0 })
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("ardia-extension-keepalive-" + UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let source = root.appendingPathComponent("source")
    try FileManager.default.createDirectory(at: source, withIntermediateDirectories: true)
    try Data(#"{"manifest_version":3,"name":"Keepalive fixture","version":"1","permissions":["storage"],"host_permissions":["http://127.0.0.1/*","http://localhost/*"],"background":{"scripts":["background.js"]},"content_scripts":[{"matches":["http://127.0.0.1/*"],"js":["content.js"]}]}"#.utf8)
      .write(to: source.appendingPathComponent("manifest.json"))
    try Data("chrome.runtime.onMessage.addListener((message, sender, respond) => { setTimeout(() => respond({ answered: true }), message.seconds * 1000); return true; });".utf8)
      .write(to: source.appendingPathComponent("background.js"))
    try Data("window.addEventListener('message', (event) => { chrome.runtime.sendMessage({ seconds: event.data }, (answer) => { document.documentElement.dataset.answer = answer && answer.answered ? 'answered' : 'lost'; }); });".utf8)
      .write(to: source.appendingPathComponent("content.js"))
    ArdiaHost.dataDirectory = root.appendingPathComponent("data").path
    let host = WebKitExtensionHost(profile: "fixture")
    var starts = 0
    host.keepAlive.started = { starts += 1 }
    host.restore()
    let fingerprint = try WebKitExtensionPackage.snapshot(source.path, into: root.appendingPathComponent("inspected")).fingerprint
    let origins = ["http://127.0.0.1/*"]
    func load() async throws -> String {
      let row: [String: Any] = try await withCheckedThrowingContinuation { continuation in
        host.load(path: source.path, fingerprint: fingerprint, permissions: ["storage"], origins: origins) { continuation.resume(with: $0) }
      }
      return try #require(row["id"] as? String)
    }
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 800, height: 600), styleMask: [.titled], backing: .buffered, defer: true)
    window.isReleasedWhenClosed = false
    func open(_ address: String) async -> WebKitTab {
      let configuration = WKWebViewConfiguration()
      configuration.websiteDataStore = host.store
      configuration.webExtensionController = host.controller
      let tab = WebKitTab(frame: NSRect(x: 0, y: 0, width: 800, height: 600))
      let page = WebKitWebView(frame: tab.bounds, configuration: configuration)
      tab.webView = page
      tab.addSubview(page)
      window.contentView?.addSubview(tab)
      page.load(URLRequest(url: URL(string: address)!))
      #expect(await eventually { page.title == "page" && !page.isLoading })
      return tab
    }
    func awake(_ count: Int, _ step: String) async {
      await pause()
      #expect(host.keepAlive.running.count == count, "\(step)")
    }

    let id = try await load()
    let unrelated = await open("http://localhost:\(server.port)/unrelated")
    host.attach(unrelated)
    await awake(0, "a page the extension does not run on keeps nothing awake")
    #expect(starts == 0)

    let first = await open("http://127.0.0.1:\(server.port)/first")
    host.attach(first)
    await awake(1, "a page running the extension keeps its background awake")
    let timer = try #require(host.keepAlive.running[id]).timer
    let second = await open("http://127.0.0.1:\(server.port)/second")
    host.attach(second)
    host.changed(second)
    await awake(1, "more pages share one timer")
    #expect(host.keepAlive.running[id]?.timer === timer)
    #expect(starts == 1)

    let page = try #require(first.webView)
    page.reload()
    #expect(await eventually { await self.read(page, "document.readyState") == "complete" && !page.isLoading })
    await pause(1)
    _ = try? await page.evaluateJavaScript("window.postMessage(40); true")
    let answered = await eventually(55) { await !self.read(page, "document.documentElement.dataset.answer").isEmpty }
    #expect(answered)
    #expect(await read(page, "document.documentElement.dataset.answer") == "answered", "a 40 second request keeps its reply")

    host.detach(first)
    await awake(1, "one page is left")
    host.detach(second)
    #expect(await eventually { host.keepAlive.running.isEmpty })
    #expect(!timer.isValid)

    host.attach(first)
    await awake(1, "a page again")
    let beforeGrant = try #require(host.keepAlive.running[id]).timer
    _ = try host.grant(id: id, permissions: ["storage"], origins: origins)
    #expect(!beforeGrant.isValid, "changing grants tears the timer down")
    await awake(1, "and starts one for the new context")

    NSWorkspace.shared.notificationCenter.post(name: NSWorkspace.willSleepNotification, object: nil)
    host.changed(first)
    await awake(0, "nothing wakes it while the Mac sleeps")
    NSWorkspace.shared.notificationCenter.post(name: NSWorkspace.didWakeNotification, object: nil)
    await awake(1, "awake again after sleep")

    NotificationCenter.default.post(name: ArdiaQuit.changed, object: true)
    host.changed(first)
    await awake(0, "nothing wakes it while quitting")
    NotificationCenter.default.post(name: ArdiaQuit.changed, object: false)
    await awake(1, "a cancelled quit resumes it")

    _ = try host.unload(id: id)
    await awake(0, "disabling stops it")
    _ = try await load()
    await awake(1, "enabling starts it again")
    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in host.forget { _ in continuation.resume() } }
    await awake(0, "forgetting the profile stops it")
    window.close()
  }
}
