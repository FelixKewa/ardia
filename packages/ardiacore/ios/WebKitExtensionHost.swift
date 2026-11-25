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
  private var operations: [String: UUID] = [:]
  private var restoring = true
  private var remainingRestores = 0
  private var ready: [() -> Void] = []

  init(profile: String) {
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

  var rows: [[String: Any]] { records.keys.sorted().compactMap(row) }

  func row(_ id: String) -> [String: Any]? {
    guard let record = records[id] else { return nil }
    var errors = failures[id] ?? []
    if let context = contexts[id] { errors += context.errors.map(\.localizedDescription) }
    return ["id": id, "name": record.name, "version": record.version, "path": record.path, "fingerprint": record.fingerprint,
            "loaded": contexts[id]?.isLoaded == true, "enabled": record.enabled, "requestedPermissions": record.requestedPermissions,
            "requestedOrigins": record.requestedOrigins, "grantedPermissions": record.permissions, "grantedOrigins": record.origins,
            "errors": errors, "reloadRequired": false]
  }

  func package(_ record: WebKitExtensionRecord) -> URL {
    directory.appendingPathComponent(record.id).appendingPathComponent(record.fingerprint)
  }

  func save(_ updated: [String: WebKitExtensionRecord]) throws {
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let document = WebKitExtensionDocument(extensions: updated.values.sorted { $0.id < $1.id })
    try JSONEncoder().encode(document).write(to: directory.appendingPathComponent("extensions.json"), options: .atomic)
    records = updated
  }

  func restore() {
    let saved = Array(records.values.filter(\.enabled))
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
            guard let self else { return }
            defer { self.remainingRestores -= 1; if self.remainingRestores == 0 { self.finishRestore() } }
            guard self.valid, self.records[record.id]?.enabled == true else { return }
            do {
              guard try checked.get().fingerprint == record.fingerprint else { throw WebKitExtensionPackage.failure("The installed extension changed. Inspect and load it again.") }
              let resource = try await WKWebExtension(resourceBaseURL: source)
              guard self.valid, self.records[record.id]?.enabled == true else { return }
              try self.activate(resource, record: record)
            } catch { self.failures[record.id] = [error.localizedDescription] }
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

  func load(path: String, fingerprint: String, permissions: [String], origins: [String], completion: @escaping WebKitExtensions.Reply) {
    guard fingerprint.count == 64, fingerprint.allSatisfy({ $0.isHexDigit }) else {
      return completion(.failure(WebKitExtensionPackage.failure("Inspect and approve the extension before loading it.")))
    }
    let canonical: URL
    do { canonical = try WebKitExtensionPackage.source(path) } catch { return completion(.failure(error)) }
    let existing = records.values.first { $0.path == canonical.path }
    let id = existing?.id ?? UUID().uuidString.lowercased()
    guard !restoring, operations[canonical.path] == nil else { return completion(.failure(WebKitExtensionPackage.failure("Extensions are still loading. Try again shortly."))) }
    let token = UUID()
    operations[canonical.path] = token
    let staging = directory.appendingPathComponent("staging-" + token.uuidString)
    let destination = directory.appendingPathComponent(id).appendingPathComponent(fingerprint)
    let previousPackage = existing.map(package)
    WebKitExtensionPackage.files.async { [weak self] in
      let snapshot = Result {
        let copied = try WebKitExtensionPackage.snapshot(canonical.path, into: staging)
        guard copied.fingerprint == fingerprint else { throw WebKitExtensionPackage.failure("The extension changed after inspection. Inspect it again before loading.") }
        var checks: [(URL, String)] = []
        if let previousPackage, let existing { checks.append((previousPackage, existing.fingerprint)) }
        if FileManager.default.fileExists(atPath: destination.path), previousPackage != destination { checks.append((destination, fingerprint)) }
        for (package, expected) in checks {
          let check = FileManager.default.temporaryDirectory.appendingPathComponent("ardia-extension-verify-" + UUID().uuidString)
          defer { try? FileManager.default.removeItem(at: check) }
          guard try WebKitExtensionPackage.snapshot(package.path, into: check).fingerprint == expected else {
            throw WebKitExtensionPackage.failure("The installed extension package changed. Restore its reviewed package before updating.")
          }
        }
        return copied
      }
      DispatchQueue.main.async { [weak self] in
        Task { @MainActor [weak self] in
          defer { WebKitExtensionPackage.files.async { try? FileManager.default.removeItem(at: staging) } }
          guard let self, self.valid, self.operations[canonical.path] == token else { return completion(.failure(WebKitExtensionPackage.failure("The profile or extension was closed while loading."))) }
          defer { if self.operations[canonical.path] == token { self.operations.removeValue(forKey: canonical.path) } }
          do {
            _ = try snapshot.get()
            let resource = try await WKWebExtension(resourceBaseURL: staging)
            guard self.valid, self.operations[canonical.path] == token else { throw WebKitExtensionPackage.failure("The profile or extension was closed while loading.") }
            try Self.validateGrants(permissions: permissions, origins: origins, resource: resource)
            let info = Self.description(resource)
            var record = WebKitExtensionRecord(id: id, path: canonical.path, fingerprint: fingerprint, name: resource.displayName ?? "Extension",
              version: resource.version ?? "", enabled: true, requestedPermissions: Self.requestedPermissions(resource), requestedOrigins: Self.requestedOrigins(resource),
              permissions: Array(Set(permissions)).sorted(), origins: Array(Set(origins)).sorted())
            record.permissions = record.permissions.filter { record.requestedPermissions.contains($0) && WebKitExtensionPackage.supportedPermissions.contains($0) }
            record.origins = record.origins.filter { Self.permits($0, resource: resource) }
            if !FileManager.default.fileExists(atPath: destination.path) {
              try FileManager.default.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
              try FileManager.default.moveItem(at: staging, to: destination)
            }
            let installed = try await WKWebExtension(resourceBaseURL: destination)
            guard self.valid, self.operations[canonical.path] == token else { throw WebKitExtensionPackage.failure("The profile or extension was closed while loading.") }
            let prior = self.contexts[id]
            if let prior { self.closePopup(); try self.controller.unload(prior) }
            self.cancelPendingTabs(contextId: id)
            do {
              try self.activate(installed, record: record)
              var updated = self.records
              updated[id] = record
              try self.save(updated)
            } catch {
              if let replacement = self.contexts.removeValue(forKey: id) { try? self.controller.unload(replacement) }
              if let prior {
                self.contexts[id] = prior
                do { try self.controller.load(prior) } catch { self.contexts.removeValue(forKey: id) }
              }
              throw error
            }
            self.failures[id] = info["errors"] as? [String] ?? []
            var result = self.row(id) ?? [:]
            result["reloadRequired"] = !self.tabs.isEmpty
            completion(.success(result))
          } catch { completion(.failure(error)) }
        }
      }
    }
  }

  func activate(_ resource: WKWebExtension, record: WebKitExtensionRecord) throws {
    let context = WKWebExtensionContext(for: resource)
    context.uniqueIdentifier = record.id
    context.baseURL = URL(string: "webkit-extension://" + record.id + "/")!
    context.hasAccessToPrivateData = false
    context.isInspectable = LaunchConfig.shared.testInstance
    applyGrants(record, to: context)
    contexts[record.id] = context
    do { try controller.load(context) } catch { contexts.removeValue(forKey: record.id); throw error }
  }

  static func permits(_ origin: String, resource: WKWebExtension) -> Bool {
    guard WebKitExtensionPackage.exactOrigin(origin, allowLoopback: LaunchConfig.shared.testInstance),
      let pattern = try? WKWebExtension.MatchPattern(string: origin) else { return false }
    return resource.allRequestedMatchPatterns.union(resource.optionalPermissionMatchPatterns).contains { $0.matches(pattern) }
  }

  static func validateGrants(permissions: [String], origins: [String], resource: WKWebExtension) throws {
    guard Set(permissions).isSubset(of: WebKitExtensionPackage.supportedPermissions),
      Set(permissions).isSubset(of: Set(requestedPermissions(resource))),
      origins.allSatisfy({ permits($0, resource: resource) }) else {
      throw WebKitExtensionPackage.failure("Only declared APIs and explicitly approved exact HTTPS hosts are supported.")
    }
  }

  func applyGrants(_ record: WebKitExtensionRecord, to context: WKWebExtensionContext) {
    context.grantedPermissions = Dictionary(uniqueKeysWithValues: record.permissions.filter {
      WebKitExtensionPackage.supportedPermissions.contains($0) && Self.requestedPermissions(context.webExtension).contains($0)
    }.map { (WKWebExtension.Permission(rawValue: $0), Date.distantFuture) })
    context.grantedPermissionMatchPatterns = Dictionary(uniqueKeysWithValues: record.origins.filter {
      Self.permits($0, resource: context.webExtension)
    }.compactMap { try? WKWebExtension.MatchPattern(string: $0) }.map { ($0, Date.distantFuture) })
  }

  func grant(id: String, permissions: [String], origins: [String]) throws -> [String: Any] {
    guard valid, let context = contexts[id], var record = records[id] else { throw WebKitExtensionPackage.failure("Load the extension before changing its permissions.") }
    guard !restoring, operations[record.path] == nil else { throw WebKitExtensionPackage.failure("Wait for the extension to finish loading before changing its permissions.") }
    try Self.validateGrants(permissions: permissions, origins: origins, resource: context.webExtension)
    record.permissions = Array(Set(permissions)).sorted()
    record.origins = Array(Set(origins)).sorted()
    var updated = records
    updated[id] = record
    closePopup()
    cancelPendingTabs(contextId: id)
    for tab in tabs.values { context.clearUserGesture(in: tab) }
    try controller.unload(context)
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
    guard var record = records[id] else { throw WebKitExtensionPackage.failure("The extension is not installed in this profile.") }
    operations.removeValue(forKey: record.path)
    record.enabled = false
    var updated = records
    updated[id] = record
    closePopup()
    if let context = contexts[id] { try controller.unload(context); contexts.removeValue(forKey: id) }
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
