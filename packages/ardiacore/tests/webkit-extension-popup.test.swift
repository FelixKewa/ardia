import AppKit
import Foundation
import Testing
import WebKit

@available(macOS 15.4, *)
final class PopupLoadCounter: NSObject, WKWebExtensionControllerDelegate {
  let host: WebKitExtensionHost
  var loads = 0

  init(host: WebKitExtensionHost) { self.host = host }

  override func responds(to selector: Selector!) -> Bool { super.responds(to: selector) || host.responds(to: selector) }
  override func forwardingTarget(for selector: Selector!) -> Any? { host }

  func webExtensionController(_ controller: WKWebExtensionController, openNewTabUsing configuration: WKWebExtension.TabConfiguration,
                             for context: WKWebExtensionContext, completionHandler: @escaping ((any WKWebExtensionTab)?, Error?) -> Void) {
    loads += 1
    completionHandler(nil, WebKitExtensionPackage.failure("The fixture counts popup loads and opens nothing."))
  }
}

@Suite(.serialized) @MainActor struct ExtensionPopupTests {
  enum Dismissal: CaseIterable { case clickOutside, escape, tabSwitch, closesItself, secondClick }

  func pause(_ seconds: Double = 1) async { try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000)) }

  func eventually(_ condition: () -> Bool) async -> Bool {
    for _ in 0..<100 {
      if condition() { return true }
      await pause(0.1)
    }
    return condition()
  }

  @available(macOS 15.4, *)
  func installed(at root: URL) async throws -> (host: WebKitExtensionHost, id: String) {
    let source = root.appendingPathComponent("source")
    try FileManager.default.createDirectory(at: source, withIntermediateDirectories: true)
    try Data(#"{"manifest_version":3,"name":"Popup fixture","version":"1","action":{"default_popup":"popup.html"},"host_permissions":["https://example.com/*"]}"#.utf8)
      .write(to: source.appendingPathComponent("manifest.json"))
    try Data("<!doctype html><body style='width:240px;height:120px'>popup<script src='popup.js'></script>".utf8).write(to: source.appendingPathComponent("popup.html"))
    try Data("browser.tabs.create({ url: 'https://counter.invalid/loaded' }).catch(() => {});".utf8).write(to: source.appendingPathComponent("popup.js"))
    ArdiaHost.dataDirectory = root.appendingPathComponent("data").path
    let host = WebKitExtensionHost(profile: "fixture")
    host.restore()
    let snapshot = try WebKitExtensionPackage.snapshot(source.path, into: root.appendingPathComponent("inspected"))
    let loaded: [String: Any] = try await withCheckedThrowingContinuation { continuation in
      host.load(path: source.path, fingerprint: snapshot.fingerprint, permissions: [], origins: ["https://example.com/*"]) { continuation.resume(with: $0) }
    }
    return (host, try #require(loaded["id"] as? String))
  }

  @available(macOS 15.4, *)
  func click(_ host: WebKitExtensionHost, _ id: String, _ tab: WebKitTab) async -> String {
    await withCheckedContinuation { continuation in
      do {
        try host.show(id: id, browserId: tab.browserId) { result in
          switch result {
          case .success(let value): continuation.resume(returning: value["shown"] as? Bool == true ? "shown" : "not shown")
          case .failure(let error): continuation.resume(returning: error.localizedDescription)
          }
        }
      } catch { continuation.resume(returning: error.localizedDescription) }
    }
  }

  @Test func `the popup opens on every click however the last one was dismissed, and nothing loads it in between`() async throws {
    guard #available(macOS 15.4, *) else { return }
    NSApplication.shared.setActivationPolicy(.prohibited)
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("ardia-extension-popup-" + UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let (host, id) = try await installed(at: root)
    let counter = PopupLoadCounter(host: host)
    host.controller.delegate = counter
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = host.store
    configuration.webExtensionController = host.controller
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 800, height: 600), styleMask: [.titled], backing: .buffered, defer: true)
    window.isReleasedWhenClosed = false
    let tab = WebKitTab(frame: NSRect(x: 0, y: 0, width: 800, height: 600))
    let page = WebKitWebView(frame: tab.bounds, configuration: configuration)
    tab.webView = page
    tab.addSubview(page)
    window.contentView?.addSubview(tab)
    page.loadSimulatedRequest(URLRequest(url: URL(string: "https://example.com/")!), responseHTML: "<!doctype html><title>page</title>")
    #expect(await eventually { page.backForwardList.currentItem != nil && !page.isLoading })
    host.attach(tab)
    let adapter = try #require(host.tabs[tab.browserId])
    let context = try #require(host.contexts[id])

    var clicks = 0
    for dismissal in Dismissal.allCases + [.clickOutside, .escape] {
      clicks += 1
      let outcome = await click(host, id, tab)
      #expect(outcome == "shown", "click \(clicks), before \(dismissal)")
      guard outcome == "shown" else { break }
      #expect(await eventually { counter.loads == clicks }, "click \(clicks) loads the popup once")
      let action = try #require(context.action(for: adapter))
      switch dismissal {
      case .clickOutside, .escape:
        let popover = try #require(action.popupPopover)
        NotificationCenter.default.post(name: NSPopover.willCloseNotification, object: popover)
        NotificationCenter.default.post(name: NSPopover.didCloseNotification, object: popover)
      case .tabSwitch:
        tab.selected = false
        host.changed(tab)
        await pause(0.3)
        tab.selected = true
        host.changed(tab)
      case .closesItself:
        _ = try? await action.popupWebView?.evaluateJavaScript("window.close()")
      case .secondClick:
        break
      }
      await pause()
      #expect(counter.loads == clicks, "dismissing by \(dismissal) must not load a hidden popup")
    }
    #expect(clicks == Dismissal.allCases.count + 2)
    host.closePopup()
    try? host.controller.unload(context)
    window.close()
  }
}
