import CryptoKit
import Foundation
import Testing
import WebKit

struct ExtensionPolicyTests {
  func root() throws -> URL {
    let result = FileManager.default.temporaryDirectory.appendingPathComponent("ardia-extension-policy-" + UUID().uuidString)
    try FileManager.default.createDirectory(at: result, withIntermediateDirectories: true)
    return result
  }

  func record() -> WebKitExtensionRecord {
    WebKitExtensionRecord(id: UUID().uuidString.lowercased(), path: "/fixture/extension", fingerprint: String(repeating: "a", count: 64),
      name: "Fixture", version: "1", enabled: true, requestedPermissions: ["storage"], requestedOrigins: WebKitExtensionPreparation.websites,
      permissions: ["storage"], origins: WebKitExtensionPreparation.websites, allWebsites: true, canUseAllWebsites: true)
  }

  @Test @MainActor func `all websites only grants web schemes including ordinary nondefault ports`() throws {
    guard #available(macOS 15.4, *) else { return }
    let origins = WebKitExtensionPreparation.websites
    for value in ["http://example.com", "https://example.org", "https://sub.example.com:8443/path", "http://127.0.0.1:8080/"] {
      #expect(WebKitExtensionPolicy.allows(URL(string: value)!, origins: origins, allWebsites: true, allowLoopback: false))
    }
    for value in ["file:///tmp/private", "webkit-extension://fixture.invalid/page", "about:blank", "data:text/plain,secret", "ftp://example.com", "https://user:password@example.com/"] {
      #expect(!WebKitExtensionPolicy.allows(URL(string: value)!, origins: origins, allWebsites: true, allowLoopback: false))
    }
    #expect(!WebKitExtensionPolicy.allows(URL(string: "https://example.com:8443/")!, origins: ["https://example.com/*"], allWebsites: false, allowLoopback: false))
    #expect(!WebKitExtensionPolicy.allows(URL(string: "http://example.com/")!, origins: ["https://example.com/*"], allWebsites: false, allowLoopback: false))
  }

  @Test @MainActor func `match pattern direction never broadens paths or includes extension pages`() throws {
    guard #available(macOS 15.4, *) else { return }
    let all = try WKWebExtension.MatchPattern(string: "<all_urls>")
    let http = try WKWebExtension.MatchPattern(string: "http://*/*")
    let https = try WKWebExtension.MatchPattern(string: "https://*/*")
    let narrow = try WKWebExtension.MatchPattern(string: "https://example.com/safe/*")
    let origin = try WKWebExtension.MatchPattern(string: "https://example.com/*")
    #expect(all.matches(URL(string: "webkit-extension://fixture.invalid/")!))
    #expect(!http.matches(URL(string: "webkit-extension://fixture.invalid/")!))
    #expect(!https.matches(URL(string: "file:///tmp/private")!))
    #expect(all.matches(https))
    #expect(!https.matches(all))
    #expect(!narrow.matches(origin))
    #expect(WebKitExtensionPolicy.fullWebPattern("<all_urls>") == nil)
    #expect(WebKitExtensionPolicy.fullWebPattern("*://*/*") == nil)
    #expect(WebKitExtensionPolicy.fullWebPattern(narrow.string) == nil)
    #expect(!WebKitExtensionPolicy.covers(WebKitExtensionPreparation.websites, requested: all))
    #expect(WebKitExtensionPolicy.covers(WebKitExtensionPreparation.websites, requested: origin))
  }

  @Test @MainActor func `resource declarations bound all-site and exact-host approval`() async throws {
    guard #available(macOS 15.4, *) else { return }
    let root = try root()
    defer { try? FileManager.default.removeItem(at: root) }
    let file = root.appendingPathComponent("manifest.json")
    for (patterns, allSites, exact) in [(["<all_urls>"], true, true), (["https://*/*"], false, true),
      (["https://example.com/safe/*"], false, false), (["https://example.com/*"], false, true)] {
      let manifest: [String: Any] = ["manifest_version": 3, "name": "Fixture", "version": "1", "host_permissions": patterns]
      try JSONSerialization.data(withJSONObject: manifest).write(to: file)
      let resource = try await WKWebExtension(resourceBaseURL: root)
      #expect(WebKitExtensionPolicy.allWebsites(resource) == allSites)
      #expect(WebKitExtensionPolicy.permits("https://example.com/*", resource: resource, allWebsites: false, allowLoopback: false) == exact)
      #expect(!WebKitExtensionPolicy.permits("<all_urls>", resource: resource, allWebsites: true, allowLoopback: false))
      #expect(!WebKitExtensionPolicy.permits("file:///*", resource: resource, allWebsites: true, allowLoopback: false))
    }
  }

  @Test func `shared approvals are scoped to their catalog and survive restart without extension data`() throws {
    let root = try root()
    defer { try? FileManager.default.removeItem(at: root) }
    let catalog = WebKitExtensionCatalog(root: root.appendingPathComponent("one"))
    let approved = record()
    let token = try catalog.begin()
    try catalog.save([approved.id: approved], token: token)
    catalog.finish(token)
    #expect(WebKitExtensionCatalog(root: root.appendingPathComponent("one")).records[approved.id] == approved)
    #expect(WebKitExtensionCatalog(root: root.appendingPathComponent("two")).records.isEmpty)
    #expect(!FileManager.default.fileExists(atPath: catalog.package(approved).path))
    let next = try catalog.begin()
    var disabled = approved
    disabled.enabled = false
    try catalog.save([disabled.id: disabled], token: next)
    #expect(WebKitExtensionCatalog(root: root.appendingPathComponent("one")).records[approved.id]?.enabled == false)
  }

  @Test func `canceled approval cannot publish after a newer revocation`() throws {
    let root = try root()
    defer { try? FileManager.default.removeItem(at: root) }
    let catalog = WebKitExtensionCatalog(root: root)
    let old = try catalog.begin()
    #expect(throws: (any Error).self) { try catalog.begin() }
    catalog.cancel()
    let current = try catalog.begin()
    catalog.finish(old)
    #expect(catalog.active(current))
    let approved = record()
    #expect(throws: (any Error).self) { try catalog.save([approved.id: approved], token: old) }
    try catalog.save([:], token: current)
    #expect(catalog.records.isEmpty)
  }

  @Test func `sharing preserves every local identity and narrowing retains inherited identity for later reuse`() throws {
    let root = try root()
    defer { try? FileManager.default.removeItem(at: root) }
    let catalog = WebKitExtensionCatalog(root: root)
    var shared = record()
    shared.allProfiles = true
    let token = try catalog.begin()
    try catalog.save([shared.id: shared], token: token)
    var local = shared
    local.id = UUID().uuidString.lowercased()
    local.origins = ["https://example.com/*"]
    local.allWebsites = false
    local.allProfiles = false
    let baseline = [local.id: local]
    #expect(catalog.overlay(local: baseline)[local.id]?.id == local.id)
    #expect(catalog.overlay(local: baseline)[local.id]?.origins == WebKitExtensionPreparation.websites)
    #expect(baseline[local.id]?.origins == ["https://example.com/*"])
    #expect(catalog.overlay(local: [:])[shared.id]?.id == shared.id)
    shared.allProfiles = false
    try catalog.save([shared.id: shared], token: token)
    #expect(catalog.overlay(local: [:]).isEmpty)
    #expect(catalog.overlay(local: baseline).isEmpty)
    let restarted = WebKitExtensionCatalog(root: root)
    #expect(restarted.records.values.first { $0.path == shared.path }?.id == shared.id)
    shared.allProfiles = true
    shared.enabled = false
    try catalog.save([shared.id: shared], token: token)
    #expect(catalog.overlay(local: baseline)[local.id]?.enabled == false)
  }

  @Test func `unknown catalogs and duplicate grants fail closed without overwriting bytes`() throws {
    let root = try root()
    defer { try? FileManager.default.removeItem(at: root) }
    let directory = root.appendingPathComponent("Shared Approvals")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let file = directory.appendingPathComponent("extensions.json")
    let original = Data(#"{"version":99,"extensions":[]}"#.utf8)
    try original.write(to: file)
    let invalid = WebKitExtensionCatalog(root: root)
    #expect(invalid.records.isEmpty)
    #expect(throws: (any Error).self) { try invalid.begin() }
    #expect(try Data(contentsOf: file) == original)
    var duplicate = record()
    duplicate.permissions.append("storage")
    #expect(!WebKitExtensionCatalog.valid(duplicate))
    duplicate = record()
    duplicate.origins.append(duplicate.origins[0])
    #expect(!WebKitExtensionCatalog.valid(duplicate))
    duplicate = record()
    duplicate.origins = ["<all_urls>"]
    #expect(!WebKitExtensionCatalog.valid(duplicate))
  }

  @Test func `existing records decode with neither broad option enabled`() throws {
    let source = #"{"id":"a","path":"/fixture","fingerprint":"b","name":"Fixture","version":"1","enabled":true,"requestedPermissions":[],"requestedOrigins":[],"permissions":[],"origins":[]}"#
    let existing = try JSONDecoder().decode(WebKitExtensionRecord.self, from: Data(source.utf8))
    #expect(existing.allWebsites != true)
    #expect(existing.canUseAllWebsites != true)
  }

  @Test func `unknown Kimchi bytes cannot acquire prepared all-site declarations`() throws {
    let manifest = Data(#"{"manifest_version":3,"name":"Kimchi Reader","version":"0.21.7","content_scripts":[{"matches":["https://example.com/*"],"js":["contentScripts/index.global.js"]}]}"#.utf8)
    for allWebsites in [false, true] {
      let existing = try WebKitExtensionPreparation.manifest(manifest, allWebsites: allWebsites) { _ in Data("synthetic code".utf8) }
      #expect(existing.data == manifest)
      #expect(!existing.supported)
    }
    let broad = Data(#"{"manifest_version":3,"name":"Fixture","version":"1","optional_host_permissions":["http://*/*","https://*/*"]}"#.utf8)
    let result = try WebKitExtensionPreparation.manifest(broad, allWebsites: true) { _ in Issue.record("No code read is needed for declared access"); return Data() }
    #expect(result.data == broad)
    #expect(result.supported)
  }

  let script = "contentScripts/index.global.js"
  let code = Data("synthetic reviewed content script".utf8)
  var codeHash: String { SHA256.hash(data: code).map { String(format: "%02x", $0) }.joined() }
  let kimchi = Data(#"{"manifest_version":3,"name":"Kimchi Reader","version":"0.21.7","permissions":["storage"],"host_permissions":["https://example.com/*"],"optional_host_permissions":["https://example.org/*"],"content_scripts":[{"matches":["https://example.com/*"],"js":["contentScripts/index.global.js"]}]}"#.utf8)

  func kimchiFolder(_ root: URL, script contents: Data?) throws -> URL {
    let folder = root.appendingPathComponent("source-" + UUID().uuidString)
    try FileManager.default.createDirectory(at: folder.appendingPathComponent("contentScripts"), withIntermediateDirectories: true)
    try kimchi.write(to: folder.appendingPathComponent("manifest.json"))
    if let contents { try contents.write(to: folder.appendingPathComponent(script)) }
    return folder
  }

  func fields(_ data: Data) throws -> NSMutableDictionary {
    let value = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    return NSMutableDictionary(dictionary: value)
  }

  @Test func `known reviewed bytes gain only optional web host declarations deterministically`() throws {
    let first = try WebKitExtensionPreparation.manifest(kimchi, allWebsites: true, knownHashes: [codeHash]) { _ in code }
    let again = try WebKitExtensionPreparation.manifest(kimchi, allWebsites: true, knownHashes: [codeHash]) { _ in code }
    #expect(first.supported)
    #expect(first.data == again.data)
    #expect(first.data != kimchi)
    let before = try fields(kimchi)
    let after = try fields(first.data)
    #expect(after["optional_host_permissions"] as? [String] == ["http://*/*", "https://*/*", "https://example.org/*"])
    before.removeObject(forKey: "optional_host_permissions")
    after.removeObject(forKey: "optional_host_permissions")
    #expect(before.isEqual(to: after as! [AnyHashable: Any]))
    let untouched = try WebKitExtensionPreparation.manifest(kimchi, allWebsites: false, knownHashes: [codeHash]) { _ in code }
    #expect(untouched.supported)
    #expect(untouched.data == kimchi)
  }

  @Test @MainActor func `the fingerprint covers the prepared manifest bytes`() async throws {
    guard #available(macOS 15.4, *) else { return }
    let root = try root()
    defer { try? FileManager.default.removeItem(at: root) }
    let folder = try kimchiFolder(root, script: code)
    let plain = try WebKitExtensionPackage.snapshot(folder.path, into: root.appendingPathComponent("plain"), knownHashes: [codeHash])
    let prepared = try WebKitExtensionPackage.snapshot(folder.path, into: root.appendingPathComponent("prepared"), allWebsites: true, knownHashes: [codeHash])
    let expected = try WebKitExtensionPreparation.manifest(kimchi, allWebsites: true, knownHashes: [codeHash]) { _ in code }
    #expect(prepared.canPrepareAllWebsites && prepared.preparedForAllWebsites)
    #expect(plain.canPrepareAllWebsites && !plain.preparedForAllWebsites)
    #expect(prepared.fingerprint != plain.fingerprint)
    #expect(try Data(contentsOf: prepared.directory.appendingPathComponent("manifest.json")) == expected.data)
    #expect(try Data(contentsOf: folder.appendingPathComponent("manifest.json")) == kimchi)
    let installed = try WebKitExtensionPackage.snapshot(prepared.directory.path, into: root.appendingPathComponent("installed"))
    #expect(installed.fingerprint == prepared.fingerprint)
    let resource = try await WKWebExtension(resourceBaseURL: prepared.directory)
    try WebKitExtensionPolicy.requireAllWebsites(true, resource: resource)
  }

  @Test @MainActor func `an unpreparable package inspects without all websites and refuses to load with them`() async throws {
    guard #available(macOS 15.4, *) else { return }
    let root = try root()
    defer { try? FileManager.default.removeItem(at: root) }
    for (index, contents) in [Data("changed content script".utf8), nil, Data(count: 8 * 1024 * 1024 + 1)].enumerated() {
      let folder = try kimchiFolder(root, script: contents)
      let inspected = try WebKitExtensionPackage.snapshot(folder.path, into: root.appendingPathComponent("inspect-\(index)"), allWebsites: true, knownHashes: [codeHash])
      #expect(!inspected.canPrepareAllWebsites)
      #expect(!inspected.preparedForAllWebsites)
      #expect(try Data(contentsOf: inspected.directory.appendingPathComponent("manifest.json")) == kimchi)
      let resource = try await WKWebExtension(resourceBaseURL: inspected.directory)
      #expect(!WebKitExtensionPolicy.allWebsites(resource))
      #expect(throws: (any Error).self) { try WebKitExtensionPolicy.requireAllWebsites(true, resource: resource) }
      try WebKitExtensionPolicy.requireAllWebsites(false, resource: resource)
    }
  }

  func exact(_ origins: [String], fingerprint: String = String(repeating: "a", count: 64), permissions: [String] = ["storage"], path: String = "/fixture/extension") -> WebKitExtensionRecord {
    var result = record()
    result.path = path
    result.fingerprint = fingerprint
    result.requestedPermissions = ["storage", "tabs"]
    result.permissions = permissions
    result.origins = origins
    result.allWebsites = false
    return result
  }

  @Test func `a profile copy stays on only within the shared package and grants it replaces`() {
    let site = "https://example.com/*"
    let other = "https://example.org/*"
    let shared = record()
    #expect(exact([site]).staysWithin(shared))
    #expect(record().staysWithin(shared))
    #expect(!exact([site], fingerprint: String(repeating: "b", count: 64)).staysWithin(shared))
    #expect(!exact([site], permissions: ["storage", "tabs"]).staysWithin(shared))
    #expect(exact([site]).staysWithin(exact([site, other])))
    #expect(!exact([site, other]).staysWithin(exact([site])))
    #expect(!record().staysWithin(exact([site])))
    var revoked = shared
    revoked.enabled = false
    #expect(!exact([site]).staysWithin(revoked))
  }

  func write(_ records: [WebKitExtensionRecord], profile: URL) throws {
    try FileManager.default.createDirectory(at: profile, withIntermediateDirectories: true)
    try JSONEncoder().encode(WebKitExtensionDocument(extensions: records)).write(to: profile.appendingPathComponent("extensions.json"))
  }

  func enabled(_ profile: URL) throws -> [String: Bool] {
    let data = try Data(contentsOf: profile.appendingPathComponent("extensions.json"))
    let document = try JSONDecoder().decode(WebKitExtensionDocument.self, from: data)
    return Dictionary(uniqueKeysWithValues: document.extensions.map { ($0.id, $0.enabled) })
  }

  @Test func `a global disable lasts in every saved profile even when the shared document is lost`() throws {
    let root = try root()
    defer { try? FileManager.default.removeItem(at: root) }
    let catalog = WebKitExtensionCatalog(root: root)
    let token = try catalog.begin()
    let shared = record()
    try catalog.save([shared.id: shared], token: token)
    let first = root.appendingPathComponent(UUID().uuidString)
    let second = root.appendingPathComponent(UUID().uuidString)
    let excluded = root.appendingPathComponent(UUID().uuidString)
    let corrupt = root.appendingPathComponent(UUID().uuidString)
    let copy = exact(["https://example.com/*"])
    let unrelated = exact(["https://example.com/*"], path: "/fixture/other")
    for profile in [first, second, excluded] { try write([copy, unrelated], profile: profile) }
    try FileManager.default.createDirectory(at: corrupt, withIntermediateDirectories: true)
    let bytes = Data("not a document".utf8)
    try bytes.write(to: corrupt.appendingPathComponent("extensions.json"))
    try FileManager.default.createDirectory(at: root.appendingPathComponent(UUID().uuidString), withIntermediateDirectories: true)
    try catalog.disableProfileCopies(path: shared.path, except: [excluded.lastPathComponent])
    for profile in [first, second] { #expect(try enabled(profile) == [copy.id: false, unrelated.id: true]) }
    #expect(try enabled(excluded) == [copy.id: true, unrelated.id: true])
    #expect(try Data(contentsOf: corrupt.appendingPathComponent("extensions.json")) == bytes)
    #expect(WebKitExtensionCatalog(root: root).records[shared.id] == shared)
    try Data("lost".utf8).write(to: catalog.directory.appendingPathComponent("extensions.json"))
    let unreadable = WebKitExtensionCatalog(root: root)
    #expect(unreadable.failure != nil)
    #expect(unreadable.overlay(local: [copy.id: copy]).isEmpty)
    #expect(try enabled(first)[copy.id] == false)
  }

  @Test func `ending sharing leaves other profiles on only for the same package and narrower grants`() throws {
    let root = try root()
    defer { try? FileManager.default.removeItem(at: root) }
    let catalog = WebKitExtensionCatalog(root: root)
    let shared = record()
    let same = exact(["https://example.com/*"])
    let stale = exact(["https://example.com/*"], fingerprint: String(repeating: "b", count: 64))
    let broader = exact(["https://example.com/*"], permissions: ["storage", "tabs"])
    let profiles = [same, stale, broader].map { ($0, root.appendingPathComponent(UUID().uuidString)) }
    for (copy, profile) in profiles { try write([copy], profile: profile) }
    try catalog.disableProfileCopies(path: shared.path) { $0.staysWithin(shared) }
    #expect(try enabled(profiles[0].1) == [same.id: true])
    #expect(try enabled(profiles[1].1) == [stale.id: false])
    #expect(try enabled(profiles[2].1) == [broader.id: false])
  }

  @Test func `an all-profiles reduction turns off broader profile copies without trimming them`() throws {
    let root = try root()
    defer { try? FileManager.default.removeItem(at: root) }
    let catalog = WebKitExtensionCatalog(root: root)
    let site = "https://example.com/*"
    let other = "https://example.org/*"
    let reduced = exact([site])
    let equal = exact([site])
    let narrower = exact([], fingerprint: String(repeating: "b", count: 64), permissions: [])
    let morePermissions = exact([site], permissions: ["storage", "tabs"])
    let moreSites = exact([site, other])
    var everySite = record()
    everySite.requestedPermissions = ["storage", "tabs"]
    let copies = [equal, narrower, morePermissions, moreSites, everySite]
    let profiles = copies.map { ($0, root.appendingPathComponent(UUID().uuidString)) }
    for (copy, profile) in profiles { try write([copy], profile: profile) }
    try catalog.disableProfileCopies(path: reduced.path) { $0.grantsWithin(reduced) }
    #expect(try profiles.map { try enabled($0.1)[$0.0.id] } == [true, true, false, false, false])
    for (copy, profile) in profiles {
      let saved = try JSONDecoder().decode(WebKitExtensionDocument.self, from: Data(contentsOf: profile.appendingPathComponent("extensions.json")))
      #expect(saved.extensions.first?.permissions == copy.permissions)
      #expect(saved.extensions.first?.origins == copy.origins)
      #expect(saved.extensions.first?.allWebsites == copy.allWebsites)
    }
    #expect(everySite.grantsWithin(record()))
    var revoked = reduced
    revoked.enabled = false
    #expect(equal.grantsWithin(revoked))
    #expect(!equal.staysWithin(revoked))
  }

  @Test func `broader profile copies are turned off only after the shared approval is saved`() throws {
    let root = try root()
    defer { try? FileManager.default.removeItem(at: root) }
    let catalog = WebKitExtensionCatalog(root: root)
    let profile = root.appendingPathComponent(UUID().uuidString)
    let broader = exact(["https://example.com/*", "https://example.org/*"])
    let reduced = exact(["https://example.com/*"])
    try write([broader], profile: profile)
    let token = try catalog.begin()
    var asked = 0
    func share(activating: Bool = true) throws -> Result<Void, Error> {
      try catalog.share(reduced, token: token, installing: { commit in
        guard activating else { throw WebKitExtensionPackage.failure("synthetic activation failure") }
        try commit()
      }, turningOff: { keep in
        asked += 1
        #expect(catalog.records[reduced.id] == reduced)
        #expect(WebKitExtensionCatalog(root: root).records[reduced.id] == reduced)
        try catalog.disableProfileCopies(path: reduced.path, unless: keep)
      })
    }
    try Data("blocks the shared folder".utf8).write(to: catalog.directory)
    #expect(throws: (any Error).self) { _ = try share() }
    #expect(catalog.records.isEmpty)
    try FileManager.default.removeItem(at: catalog.directory)
    #expect(throws: (any Error).self) { _ = try share(activating: false) }
    #expect(asked == 0)
    #expect(try enabled(profile) == [broader.id: true])
    #expect(!FileManager.default.fileExists(atPath: catalog.directory.appendingPathComponent("extensions.json").path))
    try share().get()
    #expect(asked == 1)
    #expect(try enabled(profile) == [broader.id: false])
    try write([broader], profile: profile)
    try FileManager.default.setAttributes([.posixPermissions: 0o500], ofItemAtPath: profile.path)
    defer { try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: profile.path) }
    let reported = try share()
    #expect(throws: (any Error).self) { try reported.get() }
    #expect(WebKitExtensionCatalog(root: root).records[reduced.id] == reduced)
    #expect(try enabled(profile) == [broader.id: true])
    #expect(!broader.staysWithin(reduced))
  }

  @Test func `a profile document that cannot be updated is reported after the others are saved`() throws {
    let root = try root()
    let locked = root.appendingPathComponent("00000000-0000-0000-0000-000000000000")
    defer {
      try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: locked.path)
      try? FileManager.default.removeItem(at: root)
    }
    let open = root.appendingPathComponent("FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF")
    let copy = exact(["https://example.com/*"])
    for profile in [locked, open] { try write([copy], profile: profile) }
    try FileManager.default.setAttributes([.posixPermissions: 0o500], ofItemAtPath: locked.path)
    let catalog = WebKitExtensionCatalog(root: root)
    #expect(throws: (any Error).self) { try catalog.disableProfileCopies(path: copy.path) }
    #expect(try enabled(open) == [copy.id: false])
    #expect(try enabled(locked) == [copy.id: true])
    try WebKitExtensionCatalog(root: root.appendingPathComponent("absent")).disableProfileCopies(path: copy.path)
  }
}
