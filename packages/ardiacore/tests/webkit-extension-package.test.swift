import Darwin
import Foundation
import Testing

struct ExtensionPackageTests {
  @Test func `saved extension settings use an explicit supported version`() throws {
    let record = WebKitExtensionRecord(id: UUID().uuidString, path: "/tmp/fixture", fingerprint: String(repeating: "a", count: 64), name: "Fixture", version: "1", enabled: true,
      requestedPermissions: ["storage"], requestedOrigins: ["https://example.com/*"], permissions: ["storage"], origins: ["https://example.com/*"])
    let data = try JSONEncoder().encode(WebKitExtensionDocument(extensions: [record]))
    let document = try JSONDecoder().decode(WebKitExtensionDocument.self, from: data)
    #expect(document.version == 1)
    #expect(document.extensions.count == 1)
    #expect(document.extensions.first?.id == record.id)
    #expect(document.extensions.first?.origins == record.origins)
  }

  @Test(arguments: [#"[]"#, #"{}"#, #"{"version":0,"extensions":[]}"#, #"{"version":2,"extensions":[]}"#, #"{"version":-1,"extensions":[]}"#,
    #"{"version":true,"extensions":[]}"#, #"{"version":"1","extensions":[]}"#, #"{"version":1.5,"extensions":[]}"#,
    #"{"version":1,"extensions":[{}]}"#, #"{"version":1,"extensions":null}"#, #"{"version":1}"#, #"{"version":1"#])
  func `unknown unversioned or corrupt saved settings never load`(source: String) {
    #expect(throws: (any Error).self) { try JSONDecoder().decode(WebKitExtensionDocument.self, from: Data(source.utf8)) }
  }

  func temporary() throws -> URL {
    let path = FileManager.default.temporaryDirectory.appendingPathComponent("ardia-extension-test-" + UUID().uuidString)
    try FileManager.default.createDirectory(at: path, withIntermediateDirectories: true)
    return path
  }

  func source(_ root: URL) throws -> URL {
    let path = root.appendingPathComponent("source")
    try FileManager.default.createDirectory(at: path, withIntermediateDirectories: true)
    try Data(#"{"manifest_version":3,"name":"Fixture","version":"1"}"#.utf8).write(to: path.appendingPathComponent("manifest.json"))
    return path
  }

  @Test func `fingerprints cover resource paths and contents and snapshots survive source changes`() throws {
    let root = try temporary()
    defer { try? FileManager.default.removeItem(at: root) }
    let folder = try source(root)
    let resource = folder.appendingPathComponent("resource.txt")
    try Data("first".utf8).write(to: resource)
    let first = try WebKitExtensionPackage.snapshot(folder.path, into: root.appendingPathComponent("first"))
    let same = try WebKitExtensionPackage.snapshot(folder.path, into: root.appendingPathComponent("same"))
    #expect(first.fingerprint == same.fingerprint)
    try Data("second".utf8).write(to: resource)
    let changed = try WebKitExtensionPackage.snapshot(folder.path, into: root.appendingPathComponent("changed"))
    #expect(first.fingerprint != changed.fingerprint)
    #expect(try String(contentsOf: first.directory.appendingPathComponent("resource.txt"), encoding: .utf8) == "first")
    try FileManager.default.moveItem(at: resource, to: folder.appendingPathComponent("renamed.txt"))
    let renamed = try WebKitExtensionPackage.snapshot(folder.path, into: root.appendingPathComponent("renamed"))
    #expect(changed.fingerprint != renamed.fingerprint)
  }

  @Test func `a package cannot follow a resource or directory symlink outside the chosen folder`() throws {
    let root = try temporary()
    defer { try? FileManager.default.removeItem(at: root) }
    let folder = try source(root)
    let outside = root.appendingPathComponent("outside")
    try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
    try Data("private".utf8).write(to: outside.appendingPathComponent("secret"))
    let link = folder.appendingPathComponent("escape")
    try FileManager.default.createSymbolicLink(at: link, withDestinationURL: outside.appendingPathComponent("secret"))
    #expect(throws: (any Error).self) { try WebKitExtensionPackage.snapshot(folder.path, into: root.appendingPathComponent("file-link")) }
    try FileManager.default.removeItem(at: link)
    try FileManager.default.createSymbolicLink(at: link, withDestinationURL: outside)
    #expect(throws: (any Error).self) { try WebKitExtensionPackage.snapshot(folder.path, into: root.appendingPathComponent("directory-link")) }
  }

  @Test func `Korean filenames retain their fingerprint through filesystem normalization and repeated snapshots`() throws {
    let root = try temporary()
    defer { try? FileManager.default.removeItem(at: root) }
    let composed = try source(root)
    let decomposedRoot = root.appendingPathComponent("decomposed-root")
    try FileManager.default.createDirectory(at: decomposedRoot, withIntermediateDirectories: true)
    let decomposed = try source(decomposedRoot)
    let name = "가.0.json.gz"
    let data = Data("synthetic dictionary entry".utf8)
    for (folder, filename) in [(composed, name), (decomposed, name.decomposedStringWithCanonicalMapping)] {
      let descriptor = open(folder.path + "/" + filename, O_WRONLY | O_CREAT | O_EXCL, 0o600)
      try #require(descriptor >= 0)
      defer { close(descriptor) }
      let written = data.withUnsafeBytes { (bytes: UnsafeRawBufferPointer) in Darwin.write(descriptor, bytes.baseAddress, bytes.count) }
      #expect(written == data.count)
      let names = try FileManager.default.contentsOfDirectory(atPath: folder.path)
      #expect(names.contains { $0.utf8.elementsEqual(filename.utf8) })
    }
    let first = try WebKitExtensionPackage.snapshot(composed.path, into: root.appendingPathComponent("first"))
    let equivalent = try WebKitExtensionPackage.snapshot(decomposed.path, into: root.appendingPathComponent("equivalent"))
    let repeated = try WebKitExtensionPackage.snapshot(first.directory.path, into: root.appendingPathComponent("repeated"))
    #expect(first.fingerprint == equivalent.fingerprint)
    #expect(first.fingerprint == repeated.fingerprint)
    #expect(first.legacyFingerprint != equivalent.legacyFingerprint)
    #expect(equivalent.matches(equivalent.legacyFingerprint))
    #expect(!equivalent.matches(String(repeating: "0", count: 64)))
    #expect(try Data(contentsOf: repeated.directory.appendingPathComponent(name)) == data)
  }

  @Test func `special files and oversized manifests fail without opening unbounded streams`() throws {
    let root = try temporary()
    defer { try? FileManager.default.removeItem(at: root) }
    let folder = try source(root)
    let pipe = folder.appendingPathComponent("pipe")
    #expect(mkfifo(pipe.path, 0o600) == 0)
    #expect(throws: (any Error).self) { try WebKitExtensionPackage.snapshot(folder.path, into: root.appendingPathComponent("fifo")) }
    try FileManager.default.removeItem(at: pipe)
    let manifest = try FileHandle(forWritingTo: folder.appendingPathComponent("manifest.json"))
    try manifest.truncate(atOffset: 1024 * 1024 + 1)
    try manifest.close()
    #expect(throws: (any Error).self) { try WebKitExtensionPackage.snapshot(folder.path, into: root.appendingPathComponent("oversize")) }
    #expect(!FileManager.default.fileExists(atPath: root.appendingPathComponent("oversize").path))
  }

  @Test(arguments: ["<all_urls>", "https://*/*", "https://*.example.com/*", "*://example.com/*", "file://example.com/*", "https://user@example.com/*", "https://example.com:443/*", "https://example.com/private/*", "https://example.com/*?x=1", "http://example.com/*"])
  func `grants never widen to wildcard schemes hosts credentials or paths`(pattern: String) {
    #expect(!WebKitExtensionPackage.exactOrigin(pattern))
  }

  @Test func `exact HTTPS grants do not cover subdomains lookalikes or another scheme`() throws {
    let granted = ["https://example.com/*"]
    #expect(WebKitExtensionPackage.exactOrigin(granted[0]))
    #expect(WebKitExtensionPackage.allows(try #require(URL(string: "https://example.com/page?q=1")), origins: granted))
    for url in ["https://child.example.com/", "https://example.com.evil.test/", "http://example.com/", "https://user@example.com/", "https://example.com:8443/"] {
      #expect(!WebKitExtensionPackage.allows(try #require(URL(string: url)), origins: granted))
    }
  }

  @Test func `HTTP loopback is only permitted by the explicit test option`() throws {
    let pattern = "http://localhost/*"
    let url = try #require(URL(string: "http://localhost:43219/page"))
    #expect(!WebKitExtensionPackage.exactOrigin(pattern))
    #expect(WebKitExtensionPackage.exactOrigin(pattern, allowLoopback: true))
    #expect(!WebKitExtensionPackage.allows(url, origins: [pattern]))
    #expect(WebKitExtensionPackage.allows(url, origins: [pattern], allowLoopback: true))
    #expect(!WebKitExtensionPackage.exactOrigin("http://outside.test/*", allowLoopback: true))
  }
}
