import AppKit
import WebKit

final class WebKitExtensions {
  typealias Reply = (Result<[String: Any], Error>) -> Void
  static let shared = WebKitExtensions()
  private var hosts: [String: AnyObject] = [:]
  private var forgotten = Set<String>()
  private var forgetting: [String: [(Bool) -> Void]] = [:]

  private func counted(_ name: String, failure: String? = nil, completion: @escaping Reply) -> Reply {
    let stamp = ArdiaConsentStamp.begin()
    return { result in
      switch result {
      case .success: ArdiaEvents.emit("webKit.counted", data: stamp.onto(["name": name]))
      case .failure: if let failure { ArdiaEvents.emit("webKit.counted", data: stamp.onto(["name": failure])) }
      }
      completion(result)
    }
  }

  var available: Bool {
    if #available(macOS 15.4, *) { return true }
    return false
  }

  private func check(_ profile: String) throws {
    guard available else { throw WebKitExtensionPackage.failure("WebKit extensions require macOS 15.4 or later.") }
    guard !WebKitStores.isPrivate(profile), !forgotten.contains(profile) else {
      throw WebKitExtensionPackage.failure("WebKit extensions are available only in an existing regular profile.")
    }
  }

  @available(macOS 15.4, *)
  private func host(_ profile: String) throws -> WebKitExtensionHost {
    try check(profile)
    if let host = hosts[profile] as? WebKitExtensionHost { return host }
    let host = WebKitExtensionHost(profile: profile)
    hosts[profile] = host
    host.restore()
    return host
  }

  func configure(_ configuration: WKWebViewConfiguration, profile: String) {
    guard #available(macOS 15.4, *), let host = try? host(profile) else { return }
    configuration.webExtensionController = host.controller
  }

  func whenReady(profile: String, completion: @escaping () -> Void) {
    guard #available(macOS 15.4, *), let host = try? host(profile) else { return completion() }
    host.whenReady(completion)
  }

  func inspect(path: String, completion: @escaping Reply) {
    guard #available(macOS 15.4, *) else { return completion(.failure(WebKitExtensionPackage.failure("WebKit extensions require macOS 15.4 or later."))) }
    let temporary = FileManager.default.temporaryDirectory.appendingPathComponent("ardia-extension-inspect-" + UUID().uuidString)
    WebKitExtensionPackage.files.async {
      let snapshot = Result { try WebKitExtensionPackage.snapshot(path, into: temporary) }
      DispatchQueue.main.async {
        switch snapshot {
        case .failure(let error): completion(.failure(error))
        case .success(let snapshot):
          Task { @MainActor in
            defer { WebKitExtensionPackage.files.async { try? FileManager.default.removeItem(at: temporary) } }
            do {
              let resource = try await WKWebExtension(resourceBaseURL: temporary)
              var row = WebKitExtensionHost.description(resource)
              row["path"] = snapshot.source.path
              row["fingerprint"] = snapshot.fingerprint
              completion(.success(row))
            } catch { completion(.failure(error)) }
          }
        }
      }
    }
  }

  func load(profile: String, path: String, fingerprint: String, permissions: [String], origins: [String], completion: @escaping Reply) {
    let reply = counted("extensionLoad", failure: "extensionLoadFailure", completion: completion)
    do {
      try check(profile)
      if #available(macOS 15.4, *) { try host(profile).load(path: path, fingerprint: fingerprint, permissions: permissions, origins: origins, completion: reply) }
    } catch { reply(.failure(error)) }
  }

  func list(profile: String, completion: @escaping ([[String: Any]]) -> Void) {
    guard #available(macOS 15.4, *), let host = try? host(profile) else { return completion([]) }
    host.list(completion: completion)
  }

  func grant(profile: String, id: String, permissions: [String], origins: [String], completion: @escaping Reply) {
    let reply = counted("extensionGrant", completion: completion)
    do {
      try check(profile)
      if #available(macOS 15.4, *) { reply(.success(try host(profile).grant(id: id, permissions: permissions, origins: origins))) }
    } catch { reply(.failure(error)) }
  }

  func show(profile: String, id: String, tabId: String, completion: @escaping Reply) {
    let reply = counted("extensionAction", failure: "extensionActionFailure", completion: completion)
    do {
      try check(profile)
      guard let tab = WebKitHub.shared.transfers.liveTab(tabId), tab.profile == profile, tab.transferKey == tabId, !tab.closed else {
        throw WebKitExtensionPackage.failure("The selected tab is not a live WebKit tab in this profile.")
      }
      if #available(macOS 15.4, *) { try host(profile).show(id: id, browserId: tab.browserId, completion: reply) }
    } catch { reply(.failure(error)) }
  }

  func unload(profile: String, id: String, completion: @escaping Reply) {
    let reply = counted("extensionUnload", completion: completion)
    do {
      try check(profile)
      if #available(macOS 15.4, *) { reply(.success(try host(profile).unload(id: id))) }
    } catch { reply(.failure(error)) }
  }

  func attach(_ tab: WebKitTab) {
    guard #available(macOS 15.4, *), let host = try? host(tab.profile) else { return }
    host.attach(tab)
  }

  func changed(_ tab: WebKitTab) {
    guard #available(macOS 15.4, *), let host = hosts[tab.profile] as? WebKitExtensionHost else { return }
    host.changed(tab)
  }

  func detach(_ tab: WebKitTab) {
    guard #available(macOS 15.4, *), let host = hosts[tab.profile] as? WebKitExtensionHost else { return }
    host.detach(tab)
  }

  func closed(_ view: WKWebView) {
    guard #available(macOS 15.4, *) else { return }
    for case let host as WebKitExtensionHost in hosts.values { host.closed(view) }
  }

  func accepts(_ view: WKWebView, profile: String) -> Bool {
    let store = WebKitHub.shared.stores.dataStore(for: profile)
    guard view.configuration.websiteDataStore === store else { return false }
    guard #available(macOS 15.4, *) else { return true }
    if WebKitStores.isPrivate(profile) { return view.configuration.webExtensionController == nil }
    guard let host = try? host(profile) else { return false }
    return view.configuration.webExtensionController === host.controller
  }

  func forget(profile: String, completion: @escaping (Bool) -> Void) {
    guard #available(macOS 15.4, *), !WebKitStores.isPrivate(profile) else { return completion(true) }
    if forgetting[profile] != nil { forgetting[profile]?.append(completion); return }
    forgetting[profile] = [completion]
    let host = (hosts[profile] as? WebKitExtensionHost) ?? WebKitExtensionHost(profile: profile)
    forgotten.insert(profile)
    hosts.removeValue(forKey: profile)
    host.forget { [weak self] removed in
      let callbacks = self?.forgetting.removeValue(forKey: profile) ?? []
      callbacks.forEach { $0(removed) }
    }
  }
}
