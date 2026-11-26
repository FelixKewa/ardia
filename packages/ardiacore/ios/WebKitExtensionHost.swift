import AppKit
import WebKit

@available(macOS 15.4, *)
final class WebKitExtensionHost: NSObject {
  let profile: String
  let controller: WKWebExtensionController
  let store: WKWebsiteDataStore
  let directory: URL
  var contexts: [String: WKWebExtensionContext] = [:]
  var records: [String: WebKitExtensionRecord] = [:]
  let catalog: WebKitExtensionCatalog
  var sharedRecords: [String: WebKitExtensionRecord]
  var effectiveRecords: [String: WebKitExtensionRecord] { records.merging(sharedRecords) { _, shared in shared } }
  var revision = UUID()
  var failures: [String: [String]] = [:]
  var tabs: [Int32: WebKitExtensionTabAdapter] = [:]
  var windows: [ObjectIdentifier: WebKitExtensionWindowAdapter] = [:]
  var pendingTabs: [ObjectIdentifier: WebKitExtensionPendingTab] = [:]
  var popup: WKWebExtension.Action?
  var popupReply: WebKitExtensions.Reply?
  var popupToken: UUID?
  var popupTab: WebKitExtensionTabAdapter?
  var popupContext: WKWebExtensionContext?
  var popupAction: WKWebExtension.Action?
  var focusObservers: [NSObjectProtocol] = []
  var valid = true
  var operations: [String: UUID] = [:]
  var restoring = true
  private var remainingRestores = 0
  private var ready: [() -> Void] = []
  private let icons = NSMapTable<WKWebExtension, NSString>.weakToStrongObjects()

  init(profile: String, catalog: WebKitExtensionCatalog) {
    self.catalog = catalog
    sharedRecords = [:]
    self.profile = profile
    store = WebKitHub.shared.stores.dataStore(for: profile)
    let identifier = WebKitStores.storeIdentifier(profile)
    directory = URL(fileURLWithPath: ArdiaHost.dataDirectory).appendingPathComponent("WebKit Extensions").appendingPathComponent(identifier.uuidString)
    let configuration = WKWebExtensionController.Configuration(identifier: identifier)
    configuration.defaultWebsiteDataStore = store
    let pages = WKWebViewConfiguration()
    pages.websiteDataStore = store
    configuration.webViewConfiguration = pages
    controller = WKWebExtensionController(configuration: configuration)
    super.init()
    controller.delegate = self
    if let data = try? Data(contentsOf: directory.appendingPathComponent("extensions.json")),
      let saved = try? JSONDecoder().decode(WebKitExtensionDocument.self, from: data) {
      for record in saved.extensions where UUID(uuidString: record.id) != nil && record.fingerprint.count == 64 && record.fingerprint.allSatisfy({ $0.isHexDigit }) {
        records[record.id] = record
      }
    }
    sharedRecords = sharedOverlay()
  }

  static func requestedPermissions(_ resource: WKWebExtension) -> [String] {
    let manifest = resource.manifest
    return Array(Set((manifest["permissions"] as? [String] ?? []) + (manifest["optional_permissions"] as? [String] ?? []))).filter { !$0.contains("://") && $0 != "<all_urls>" }.sorted()
  }

  static func requestedOrigins(_ resource: WKWebExtension) -> [String] {
    resource.allRequestedMatchPatterns.union(resource.optionalPermissionMatchPatterns).map(\.string).sorted()
  }

  static func description(_ resource: WKWebExtension) -> [String: Any] {
    let permissions = requestedPermissions(resource)
    var errors = resource.errors.map(\.localizedDescription)
    let unsupported = Set(permissions).subtracting(WebKitExtensionPackage.supportedPermissions)
    if !unsupported.isEmpty { errors.append("Unsupported permissions: " + unsupported.sorted().joined(separator: ", ")) }
    return ["name": resource.displayName ?? "Extension", "version": resource.version ?? "", "requestedPermissions": permissions,
            "requestedOrigins": requestedOrigins(resource), "errors": errors, "supportedPermissions": WebKitExtensionPackage.supportedPermissions.sorted()]
  }

  var rows: [[String: Any]] { effectiveRecords.keys.sorted().compactMap(row) }

  var sharedCatalogUnreadable: Bool { catalog.failure != nil }

  func row(_ id: String) -> [String: Any]? {
    guard let record = effectiveRecords[id] else { return nil }
    var errors = failures[id] ?? []
    if let context = contexts[id] { errors += context.errors.map(\.localizedDescription) }
    var result: [String: Any] = ["id": id, "name": record.name, "version": record.version, "path": record.path, "fingerprint": record.fingerprint,
            "loaded": contexts[id]?.isLoaded == true, "enabled": record.enabled, "requestedPermissions": record.requestedPermissions,
            "requestedOrigins": record.requestedOrigins, "grantedPermissions": record.permissions, "grantedOrigins": record.origins,
            "errors": errors, "reloadRequired": false, "allWebsites": record.allWebsites == true,
            "allProfiles": sharedRecords[id] != nil, "canUseAllWebsites": record.canUseAllWebsites == true]
    if record.enabled, let context = contexts[id], let icon = icon(for: context) { result["icon"] = icon }
    if let local = records[id] {
      result["localGrantedOrigins"] = local.origins.filter { WebKitExtensionPackage.exactOrigin($0, allowLoopback: LaunchConfig.shared.testInstance) }
      result["localGrantedPermissions"] = local.permissions
    }
    return result
  }

  private func icon(for context: WKWebExtensionContext) -> String? {
    guard owns(context), context.isLoaded else { return nil }
    let resource = context.webExtension
    if let cached = icons.object(forKey: resource) { return cached.length == 0 ? nil : cached as String }
    let size = CGSize(width: 64, height: 64)
    let image = resource.actionIcon(for: size) ?? resource.icon(for: size)
    let result = image?.pngDataURL(points: 64, scale: 1)
    icons.setObject((result ?? "") as NSString, forKey: resource)
    return result
  }

  func package(_ record: WebKitExtensionRecord) -> URL {
    if sharedRecords[record.id] == record, let shared = catalog.records.values.first(where: { $0.path == record.path }) { return catalog.package(shared) }
    return localPackage(record)
  }

  func localPackage(_ record: WebKitExtensionRecord) -> URL {
    directory.appendingPathComponent(record.id).appendingPathComponent(record.fingerprint)
  }

  func save(_ updated: [String: WebKitExtensionRecord]) throws {
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let document = WebKitExtensionDocument(extensions: updated.values.sorted { $0.id < $1.id })
    try JSONEncoder().encode(document).write(to: directory.appendingPathComponent("extensions.json"), options: .atomic)
    records = updated
  }

  func sharedOverlay() -> [String: WebKitExtensionRecord] {
    catalog.overlay(local: records)
  }

  func disableCopies(path: String, unless keep: (WebKitExtensionRecord) -> Bool) {
    let previous = records
    records = records.mapValues { WebKitExtensionCatalog.disabled($0, path: path, unless: keep) }
    for id in records.keys where records[id] != previous[id] && sharedRecords[id] == nil {
      do { try deactivate(id) } catch { failures[id] = [error.localizedDescription] }
    }
  }

  func reconcile() {
    let before = effectiveRecords
    sharedRecords = sharedOverlay()
    let changed = Set(before.keys).union(effectiveRecords.keys).filter { before[$0] != effectiveRecords[$0] }
    for id in changed {
      do { try deactivate(id) } catch { failures[id] = [error.localizedDescription] }
    }
    restore()
  }

  func deactivate(_ id: String) throws {
    closePopup()
    cancelPendingTabs(contextId: id)
    guard let context = contexts[id] else { return }
    for tab in tabs.values { context.clearUserGesture(in: tab) }
    context.grantedPermissions = [:]
    context.grantedPermissionMatchPatterns = [:]
    defer { contexts.removeValue(forKey: id); icons.removeObject(forKey: context.webExtension) }
    try controller.unload(context)
  }

  func install(_ resource: WKWebExtension, record: WebKitExtensionRecord, allProfiles: Bool, commit: () throws -> Void) throws {
    let previousRecords = records
    let previousShared = sharedRecords
    var selected = record
    if allProfiles, let local = records.values.first(where: { $0.path == record.path }) { selected.id = local.id }
    let prior = contexts[selected.id]
    closePopup()
    cancelPendingTabs(contextId: selected.id)
    if let prior {
      for tab in tabs.values { prior.clearUserGesture(in: tab) }
      try controller.unload(prior)
      contexts.removeValue(forKey: selected.id)
    }
    if allProfiles { sharedRecords[selected.id] = selected }
    else { records[selected.id] = selected; sharedRecords.removeValue(forKey: selected.id) }
    do {
      try activate(resource, record: selected)
      try commit()
      if let prior { icons.removeObject(forKey: prior.webExtension) }
      failures.removeValue(forKey: selected.id)
    } catch {
      if let replacement = contexts.removeValue(forKey: selected.id) { try? controller.unload(replacement) }
      records = previousRecords
      sharedRecords = previousShared
      if let prior {
        contexts[selected.id] = prior
        do { try controller.load(prior) } catch { contexts.removeValue(forKey: selected.id) }
      }
      throw error
    }
  }

  func restore() {
    revision = UUID()
    let expected = revision
    let saved = Array(effectiveRecords.values.filter { $0.enabled && contexts[$0.id] == nil })
    restoring = true
    guard !saved.isEmpty else { return finishRestore() }
    remainingRestores = saved.count
    for record in saved {
      let source = package(record)
      let check = FileManager.default.temporaryDirectory.appendingPathComponent("ardia-extension-verify-" + UUID().uuidString)
      WebKitExtensionPackage.files.async { [weak self] in
        let checked = Result { try WebKitExtensionPackage.snapshot(source.path, into: check) }
        try? FileManager.default.removeItem(at: check)
        DispatchQueue.main.async { [weak self] in
          Task { @MainActor [weak self] in
            guard let self, self.valid, self.revision == expected else { return }
            defer {
              if self.revision == expected {
                self.remainingRestores -= 1
                if self.remainingRestores == 0 { self.finishRestore() }
              }
            }
            guard self.effectiveRecords[record.id] == record else { return }
            do {
              guard try checked.get().matches(record.fingerprint) else { throw WebKitExtensionPackage.failure("The installed extension changed. Inspect and load it again.") }
              let resource = try await WKWebExtension(resourceBaseURL: source)
              guard self.valid, self.revision == expected, self.effectiveRecords[record.id] == record else { return }
              try self.activate(resource, record: record)
              self.failures.removeValue(forKey: record.id)
            } catch {
              if self.valid, self.revision == expected, self.effectiveRecords[record.id] == record { self.failures[record.id] = [error.localizedDescription] }
            }
          }
        }
      }
    }
  }

  private func finishRestore() {
    restoring = false
    let callbacks = ready
    ready = []
    callbacks.forEach { $0() }
  }

  func whenReady(_ callback: @escaping () -> Void) {
    if restoring { ready.append(callback) } else { callback() }
  }

  func activate(_ resource: WKWebExtension, record: WebKitExtensionRecord) throws {
    try Self.validateGrants(permissions: record.permissions, origins: record.origins, resource: resource, allWebsites: record.allWebsites == true)
    let context = WKWebExtensionContext(for: resource)
    context.uniqueIdentifier = record.id
    context.baseURL = URL(string: "webkit-extension://" + record.id + "/")!
    context.hasAccessToPrivateData = false
    context.isInspectable = LaunchConfig.shared.testInstance
    applyGrants(record, to: context)
    contexts[record.id] = context
    do { try controller.load(context) } catch { contexts.removeValue(forKey: record.id); throw error }
  }

  static func permits(_ origin: String, resource: WKWebExtension, allWebsites: Bool = false) -> Bool {
    WebKitExtensionPolicy.permits(origin, resource: resource, allWebsites: allWebsites, allowLoopback: LaunchConfig.shared.testInstance)
  }

  static func validateGrants(permissions: [String], origins: [String], resource: WKWebExtension, allWebsites: Bool = false) throws {
    guard Set(permissions).isSubset(of: WebKitExtensionPackage.supportedPermissions),
      Set(permissions).isSubset(of: Set(requestedPermissions(resource))),
      !allWebsites || WebKitExtensionPolicy.allWebsites(resource),
      origins.allSatisfy({ permits($0, resource: resource, allWebsites: allWebsites) }) else {
      throw WebKitExtensionPackage.failure("Only declared APIs and explicitly approved website access are supported.")
    }
  }

  func applyGrants(_ record: WebKitExtensionRecord, to context: WKWebExtensionContext) {
    context.grantedPermissions = Dictionary(uniqueKeysWithValues: Set(record.permissions).filter {
      WebKitExtensionPackage.supportedPermissions.contains($0) && Self.requestedPermissions(context.webExtension).contains($0)
    }.map { (WKWebExtension.Permission(rawValue: $0), Date.distantFuture) })
    context.grantedPermissionMatchPatterns = Dictionary(uniqueKeysWithValues: Set(record.origins).filter {
      Self.permits($0, resource: context.webExtension, allWebsites: record.allWebsites == true)
    }.compactMap { try? WKWebExtension.MatchPattern(string: $0) }.map { ($0, Date.distantFuture) })
  }

  func allows(_ url: URL, context: WKWebExtensionContext) -> Bool {
    guard owns(context), let record = effectiveRecords[context.uniqueIdentifier] else { return false }
    return WebKitExtensionPolicy.allows(url, origins: record.origins, allWebsites: record.allWebsites == true, allowLoopback: LaunchConfig.shared.testInstance)
  }

  func grant(id: String, permissions: [String], origins: [String]) throws -> [String: Any] {
    guard valid, let context = contexts[id], var record = records[id], sharedRecords[id] == nil else { throw WebKitExtensionPackage.failure("Load the extension before changing its permissions.") }
    guard !restoring, operations[record.path] == nil else { throw WebKitExtensionPackage.failure("Wait for the extension to finish loading before changing its permissions.") }
    try Self.validateGrants(permissions: permissions, origins: origins, resource: context.webExtension)
    record.allWebsites = false
    record.permissions = Array(Set(permissions)).sorted()
    record.origins = Array(Set(origins)).sorted()
    var updated = records
    updated[id] = record
    closePopup()
    cancelPendingTabs(contextId: id)
    for tab in tabs.values { context.clearUserGesture(in: tab) }
    try controller.unload(context)
    icons.removeObject(forKey: context.webExtension)
    contexts.removeValue(forKey: id)
    do {
      try activate(context.webExtension, record: record)
      try save(updated)
    } catch {
      if let replacement = contexts.removeValue(forKey: id) { try? controller.unload(replacement) }
      contexts[id] = context
      do { try controller.load(context) } catch { contexts.removeValue(forKey: id) }
      throw error
    }
    var result = row(id) ?? [:]
    result["reloadRequired"] = !tabs.isEmpty
    return result
  }

  func unload(id: String) throws -> [String: Any] {
    guard var record = records[id], sharedRecords[id] == nil else { throw WebKitExtensionPackage.failure("The extension is not installed in this profile.") }
    if let token = operations.removeValue(forKey: record.path) { catalog.finish(token) }
    record.enabled = false
    var updated = records
    updated[id] = record
    closePopup()
    if let context = contexts[id] { try controller.unload(context); contexts.removeValue(forKey: id); icons.removeObject(forKey: context.webExtension) }
    do { try save(updated) } catch {
      failures[id] = ["The extension stopped, but its disabled state could not be saved."]
      records[id] = record
      throw error
    }
    cancelPendingTabs(contextId: id)
    return row(id) ?? [:]
  }

  func owns(_ context: WKWebExtensionContext) -> Bool { valid && contexts[context.uniqueIdentifier] === context && context.webExtensionController === controller }

  func forget(completion: @escaping (Bool) -> Void) {
    valid = false
    operations = [:]
    closePopup()
    cancelPendingTabs(contextId: nil)
    for context in contexts.values { try? controller.unload(context) }
    contexts = [:]
    icons.removeAllObjects()
    tabs = [:]
    windows = [:]
    focusObservers.forEach(NotificationCenter.default.removeObserver)
    focusObservers = []
    controller.delegate = nil
    restoring = false
    ready = []
    controller.fetchDataRecords(ofTypes: WKWebExtensionController.allExtensionDataTypes) { [self] records in
      controller.removeData(ofTypes: WKWebExtensionController.allExtensionDataTypes, from: records) {
        WebKitExtensionPackage.files.async {
          let removed: Bool
          do {
            if FileManager.default.fileExists(atPath: self.directory.path) { try FileManager.default.removeItem(at: self.directory) }
            removed = true
          } catch { removed = false }
          DispatchQueue.main.async { completion(removed && records.allSatisfy { $0.errors.isEmpty }) }
        }
      }
    }
  }
}
