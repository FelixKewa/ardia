import Foundation
import WebKit

@available(macOS 15.4, *)
extension WebKitExtensionHost {
  func load(path: String, fingerprint: String, permissions: [String], origins: [String], allWebsites: Bool, allProfiles: Bool,
            token: UUID, publish: @escaping (WebKitExtensionRecord, WKWebExtension) throws -> Void, completion: @escaping WebKitExtensions.Reply) {
    guard fingerprint.count == 64, fingerprint.allSatisfy({ $0.isHexDigit }) else {
      return completion(.failure(WebKitExtensionPackage.failure("Inspect and approve the extension before loading it.")))
    }
    let canonical: URL
    do { canonical = try WebKitExtensionPackage.source(path) } catch { return completion(.failure(error)) }
    let existing = effectiveRecords.values.first { $0.path == canonical.path }
    let shared = catalog.records.values.first { $0.path == canonical.path }
    let id = (allProfiles ? shared?.id ?? existing?.id : existing?.id ?? shared?.id) ?? UUID().uuidString.lowercased()
    guard !restoring, operations[canonical.path] == nil else { return completion(.failure(WebKitExtensionPackage.failure("Extensions are still loading. Try again shortly."))) }
    operations[canonical.path] = token
    let staging = directory.appendingPathComponent("staging-" + token.uuidString)
    let destination = (allProfiles ? catalog.directory : directory).appendingPathComponent(id).appendingPathComponent(fingerprint)
    let previousPackage = existing.map(package)
    WebKitExtensionPackage.files.async { [weak self] in
      let snapshot = Result {
        let copied = try WebKitExtensionPackage.snapshot(canonical.path, into: staging, allWebsites: allWebsites)
        guard copied.fingerprint == fingerprint else { throw WebKitExtensionPackage.failure("The extension changed after inspection. Inspect it again before loading.") }
        var checks: [(URL, String)] = []
        if let previousPackage, let existing { checks.append((previousPackage, existing.fingerprint)) }
        if FileManager.default.fileExists(atPath: destination.path), previousPackage != destination { checks.append((destination, fingerprint)) }
        for (package, expected) in checks {
          let check = FileManager.default.temporaryDirectory.appendingPathComponent("ardia-extension-verify-" + UUID().uuidString)
          defer { try? FileManager.default.removeItem(at: check) }
          guard try WebKitExtensionPackage.snapshot(package.path, into: check).matches(expected) else {
            throw WebKitExtensionPackage.failure("The installed extension package changed. Restore its reviewed package before updating.")
          }
        }
        return copied
      }
      DispatchQueue.main.async { [weak self] in
        Task { @MainActor [weak self] in
          defer { WebKitExtensionPackage.files.async { try? FileManager.default.removeItem(at: staging) } }
          guard let self else { return completion(.failure(WebKitExtensionPackage.failure("The profile was closed while loading."))) }
          defer { if self.operations[canonical.path] == token { self.operations.removeValue(forKey: canonical.path) } }
          do {
            let copied = try snapshot.get()
            try self.checkApproval(token, path: canonical.path)
            let resource = try await WKWebExtension(resourceBaseURL: staging)
            try self.checkApproval(token, path: canonical.path)
            try WebKitExtensionPolicy.requireAllWebsites(allWebsites, resource: resource)
            let approvedOrigins = allWebsites ? WebKitExtensionPreparation.websites : origins
            try Self.validateGrants(permissions: permissions, origins: approvedOrigins, resource: resource, allWebsites: allWebsites)
            let record = WebKitExtensionRecord(id: id, path: canonical.path, fingerprint: fingerprint, name: resource.displayName ?? "Extension",
              version: resource.version ?? "", enabled: true, requestedPermissions: Self.requestedPermissions(resource), requestedOrigins: Self.requestedOrigins(resource),
              permissions: Array(Set(permissions)).sorted(), origins: Array(Set(approvedOrigins)).sorted(), allWebsites: allWebsites,
              canUseAllWebsites: copied.canPrepareAllWebsites || WebKitExtensionPolicy.allWebsites(resource), allProfiles: allProfiles)
            if !FileManager.default.fileExists(atPath: destination.path) {
              try FileManager.default.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
              try FileManager.default.moveItem(at: staging, to: destination)
            }
            let installed = try await WKWebExtension(resourceBaseURL: destination)
            try self.checkApproval(token, path: canonical.path)
            try publish(record, installed)
            guard let current = self.effectiveRecords.values.first(where: { $0.path == canonical.path }),
              current.fingerprint == record.fingerprint, current.enabled, self.contexts[current.id]?.isLoaded == true else {
              throw WebKitExtensionPackage.failure("The approved extension could not be activated in this profile.")
            }
            var result = self.row(current.id) ?? [:]
            result["reloadRequired"] = !self.tabs.isEmpty
            completion(.success(result))
          } catch { completion(.failure(error)) }
        }
      }
    }
  }

  private func checkApproval(_ token: UUID, path: String) throws {
    guard valid, catalog.active(token), operations[path] == token else {
      throw WebKitExtensionPackage.failure("The profile or extension approval changed while loading.")
    }
  }
}
