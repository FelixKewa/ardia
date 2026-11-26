import AppKit
import WebKit

final class WebKitExtensions {
  typealias Reply = (Result<[String: Any], Error>) -> Void
  static let shared = WebKitExtensions()
  private var hosts: [String: AnyObject] = [:]
  private var forgotten = Set<String>()
  private var forgetting: [String: [(Bool) -> Void]] = [:]
  private lazy var catalog = WebKitExtensionCatalog(root: URL(fileURLWithPath: ArdiaHost.dataDirectory).appendingPathComponent("WebKit Extensions"))

  private func counted(_ name: String, also: [String] = [], failure: String? = nil, completion: @escaping Reply) -> Reply {
    let stamp = ArdiaConsentStamp.begin()
    return { result in
      switch result {
      case .success: for counted in [name] + also { ArdiaEvents.emit("webKit.counted", data: stamp.onto(["name": counted])) }
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
    let host = WebKitExtensionHost(profile: profile, catalog: catalog)
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

  func inspect(path: String, allWebsites: Bool = false, completion: @escaping Reply) {
    guard #available(macOS 15.4, *) else { return completion(.failure(WebKitExtensionPackage.failure("WebKit extensions require macOS 15.4 or later."))) }
    let temporary = FileManager.default.temporaryDirectory.appendingPathComponent("ardia-extension-inspect-" + UUID().uuidString)
    WebKitExtensionPackage.files.async {
      let snapshot = Result { try WebKitExtensionPackage.snapshot(path, into: temporary, allWebsites: allWebsites) }
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
              let usable = snapshot.canPrepareAllWebsites || WebKitExtensionPolicy.allWebsites(resource)
              row["allWebsites"] = allWebsites && usable
              row["canUseAllWebsites"] = usable
              row["preparedForAllWebsites"] = snapshot.preparedForAllWebsites
              completion(.success(row))
            } catch { completion(.failure(error)) }
          }
        }
      }
    }
  }

  func load(profile: String, path: String, fingerprint: String, permissions: [String], origins: [String], allWebsites: Bool = false, allProfiles: Bool = false, completion: @escaping Reply) {
    let scopes = (allProfiles ? ["extensionSharedApproval"] : []) + (allWebsites ? ["extensionAllWebsitesLoad"] : [])
    let reply = counted("extensionLoad", also: scopes, failure: "extensionLoadFailure", completion: completion)
    do {
      try check(profile)
      if #available(macOS 15.4, *) {
        let target = try host(profile)
        let token = try catalog.begin()
        target.load(path: path, fingerprint: fingerprint, permissions: permissions, origins: origins, allWebsites: allWebsites, allProfiles: allProfiles, token: token,
          publish: { [weak self, weak target] record, resource in
            guard let self, let target, target.valid else { throw WebKitExtensionPackage.failure("The profile was closed while loading.") }
            try self.publish(record, resource: resource, allProfiles: allProfiles, target: target, token: token)
          }, completion: { [weak self] result in
            self?.catalog.finish(token)
            reply(result)
          })
      }
    } catch { reply(.failure(error)) }
  }

  @available(macOS 15.4, *)
  private func publish(_ record: WebKitExtensionRecord, resource: WKWebExtension, allProfiles: Bool, target: WebKitExtensionHost, token: UUID) throws {
    guard !allProfiles else { return try share(record, resource: resource, from: target, token: token) }
    var shared = catalog.records
    let previous = target.records
    var updated = previous
    updated[record.id] = record
    try target.install(resource, record: record, allProfiles: false) {
      try target.save(updated)
      do {
        if let retiring = shared.values.first(where: { $0.path == record.path && $0.allProfiles != false }) {
          try disableProfileCopies(path: record.path, except: target) { $0.staysWithin(retiring) }
        }
        for (id, value) in shared where value.path == record.path { shared[id]?.allProfiles = false }
        if shared != catalog.records { try catalog.save(shared, token: token) }
      } catch {
        try target.save(previous)
        throw error
      }
    }
    refreshHosts()
  }

  @available(macOS 15.4, *)
  private func share(_ record: WebKitExtensionRecord, resource: WKWebExtension, from target: WebKitExtensionHost, token: UUID) throws {
    let copies = try catalog.share(record, token: token,
      installing: { commit in try target.install(resource, record: record, allProfiles: true, commit: commit) },
      turningOff: { keep in try disableProfileCopies(path: record.path, unless: keep) })
    refreshHosts()
    try copies.get()
  }

  @available(macOS 15.4, *)
  private func disableProfileCopies(path: String, except target: WebKitExtensionHost? = nil, unless keep: (WebKitExtensionRecord) -> Bool = { _ in false }) throws {
    var excluded = Set(forgotten.map { WebKitStores.storeIdentifier($0).uuidString })
    if let target { excluded.insert(target.directory.lastPathComponent) }
    let saved = Result { try catalog.disableProfileCopies(path: path, except: excluded, unless: keep) }
    for case let host as WebKitExtensionHost in hosts.values where host.valid && host !== target {
      host.disableCopies(path: path, unless: keep)
    }
    try saved.get()
  }

  @available(macOS 15.4, *)
  private func refreshHosts() {
    for case let host as WebKitExtensionHost in hosts.values where host.valid {
      host.reconcile()
    }
  }

  func list(profile: String) -> [[String: Any]] {
    guard #available(macOS 15.4, *), let host = try? host(profile) else { return [] }
    return host.rows
  }

  func sharedCatalogUnreadable(profile: String) -> Bool {
    guard #available(macOS 15.4, *), let host = try? host(profile) else { return false }
    return host.sharedCatalogUnreadable
  }

  func grant(profile: String, id: String, permissions: [String], origins: [String], allProfiles: Bool = false, completion: @escaping Reply) {
    let reply = counted("extensionGrant", completion: completion)
    do {
      try check(profile)
      if #available(macOS 15.4, *) {
        let target = try host(profile)
        let token = try catalog.begin()
        defer { catalog.finish(token) }
        if let effective = target.sharedRecords[id], var record = catalog.records.values.first(where: { $0.path == effective.path }), let context = target.contexts[id] {
          guard allProfiles else { throw WebKitExtensionPackage.failure("Confirm that this access change applies to all regular profiles.") }
          let approved = counted("extensionSharedApproval", completion: reply)
          try WebKitExtensionHost.validateGrants(permissions: permissions, origins: origins, resource: context.webExtension)
          record.permissions = Array(Set(permissions)).sorted()
          record.origins = Array(Set(origins)).sorted()
          record.allWebsites = false
          try share(record, resource: context.webExtension, from: target, token: token)
          approved(.success(target.row(id) ?? [:]))
        } else { reply(.success(try target.grant(id: id, permissions: permissions, origins: origins))) }
      }
    } catch { reply(.failure(error)) }
  }

  func show(profile: String, id: String, tabId: String, completion: @escaping Reply) {
    let reply = counted("extensionAction", completion: completion)
    do {
      try check(profile)
      guard let tab = WebKitHub.shared.transfers.liveTab(tabId), tab.profile == profile, tab.transferKey == tabId, !tab.closed else {
        throw WebKitExtensionPackage.failure("The selected tab is not a live WebKit tab in this profile.")
      }
      if #available(macOS 15.4, *) { try host(profile).show(id: id, browserId: tab.browserId, completion: reply) }
    } catch { reply(.failure(error)) }
  }

  func unload(profile: String, id: String, allProfiles: Bool = false, completion: @escaping Reply) {
    let reply = counted("extensionUnload", completion: completion)
    do {
      try check(profile)
      if #available(macOS 15.4, *) {
        let target = try host(profile)
        if let effective = target.sharedRecords[id], var record = catalog.records.values.first(where: { $0.path == effective.path }) {
          guard allProfiles else { throw WebKitExtensionPackage.failure("Confirm that disabling this extension applies to all regular profiles.") }
          catalog.cancel()
          let token = try catalog.begin()
          defer { catalog.finish(token) }
          record.enabled = false
          var shared = catalog.records
          shared[record.id] = record
          let copies = Result { try disableProfileCopies(path: record.path) }
          try catalog.save(shared, token: token)
          refreshHosts()
          try copies.get()
          reply(.success(target.row(id) ?? [:]))
        } else { reply(.success(try target.unload(id: id))) }
      }
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
    let host = (hosts[profile] as? WebKitExtensionHost) ?? WebKitExtensionHost(profile: profile, catalog: catalog)
    forgotten.insert(profile)
    hosts.removeValue(forKey: profile)
    host.forget { [weak self] removed in
      let callbacks = self?.forgetting.removeValue(forKey: profile) ?? []
      callbacks.forEach { $0(removed) }
    }
  }
}
