import AppKit
import Network
import WebKit

enum ArdiaHost { nonisolated(unsafe) static var dataDirectory = "" }
final class LaunchConfig {
  nonisolated(unsafe) static let shared = LaunchConfig()
  let testInstance = true
  let background = false
}
final class WebKitStores {
  static func storeIdentifier(_ profile: String) -> UUID { UUID() }
  func dataStore(for profile: String) -> WKWebsiteDataStore { .nonPersistent() }
}
final class WebKitTransfers {
  func offer(_ view: WKWebView) -> String { "webkit:1" }
  func claimOffered(_ id: String) -> WKWebView? { nil }
}
final class WebKitHub {
  nonisolated(unsafe) static let shared = WebKitHub()
  let stores = WebKitStores()
  let transfers = WebKitTransfers()
  func configuration(profile: String) -> WKWebViewConfiguration { WKWebViewConfiguration() }
  static func close(_ view: WKWebView) {}
}
final class WebKitWebView: WKWebView {}
enum WebKitHeldPopup { static func hold(_ view: WKWebView, offer: String, opener: WebKitTab) {} }
final class WebKitTab: NSView {
  var profile = "fixture"
  var closed = false
  var webView: WebKitWebView?
  var visible = true
  var selected = true
  nonisolated(unsafe) static var lastBrowserId: Int32 = 0
  let browserId: Int32 = { WebKitTab.lastBrowserId += 1; return WebKitTab.lastBrowserId }()
  func emit(_ name: String, _ payload: [String: Any] = [:]) {}
  func reload() { webView?.reload() }
}
enum WebKitExtensions { typealias Reply = (Result<[String: Any], Error>) -> Void }
extension NSImage { func pngDataURL(points: CGFloat, scale: CGFloat) -> String? { nil } }

final class LoopbackPages: @unchecked Sendable {
  private let listener: NWListener

  var port: UInt16 { listener.port?.rawValue ?? 0 }

  init() throws {
    let parameters = NWParameters.tcp
    parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
    listener = try NWListener(using: parameters)
    listener.newConnectionHandler = { connection in
      connection.start(queue: .global())
      connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { _, _, _, _ in
        let body = "<!doctype html><title>page</title>"
        let response = "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nCache-Control: no-store\r\nContent-Length: \(body.utf8.count)\r\nConnection: close\r\n\r\n" + body
        connection.send(content: Data(response.utf8), completion: .contentProcessed { _ in connection.cancel() })
      }
    }
    listener.start(queue: .global())
  }

  func stop() { listener.cancel() }
}
