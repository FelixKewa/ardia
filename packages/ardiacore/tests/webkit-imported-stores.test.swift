import Foundation
import Testing

final class LaunchConfig {
  static let shared = LaunchConfig()
  let dataDirectory: String? = "/tmp/fixture"
}

enum ArdiaHost { static let dataDirectory = "/tmp/fixture/Chromium" }

struct ImportedStoreTests {
  let scope = "/var/folders/yc/hhlx_7z502gf9rs3szbtrbsr0000gn/T/ardia-webkit-preview-profile"
  let destination = "/fixture/installed/Chromium"

  func document(scope: String? = nil, source: String = "", duplicate: Bool = false, version: Int = 1) throws -> (String, UUID, Data) {
    let scope = scope ?? self.scope
    let profile = WebKitImportedStores.importedProfile(scope: scope, profile: source)
    let id = WebKitImportedStores.identifier(scope: scope, profile: source)
    let entry = WebKitImportedStores.Entry(profile: profile, sourceScope: scope, sourceProfile: source, identifier: id)
    return (profile, id, try JSONEncoder().encode(WebKitImportedStores.Document(version: version, destination: destination, entries: duplicate ? [entry, entry] : [entry])))
  }

  @Test func `installed imported profile preserves exact preview identifier`() throws {
    let (profile, id, data) = try document()
    #expect(id.uuidString == "AF4FA80E-706A-5BD0-9BE1-AD8F105197FC")
    #expect(WebKitImportedStores.identifier(scope: "", profile: "").uuidString == "E759FBD0-715C-5C5C-BD62-F9C96B18996D")
    #expect(WebKitImportedStores.resolve(profile, scratch: nil, bundle: "com.ardia.browser", destination: destination, data: data) == id)
    #expect(WebKitImportedStores.resolve("", scratch: nil, bundle: "com.ardia.browser", destination: destination, data: data) == nil)
    #expect(WebKitImportedStores.identifier(scope: scope, profile: "") != WebKitImportedStores.identifier(scope: "/private" + scope, profile: ""))
  }

  @Test func `scratch and other bundles never adopt installed data`() throws {
    let (profile, _, data) = try document()
    for scratch in [scope, "/tmp/other", ""] {
      #expect(WebKitImportedStores.resolve(profile, scratch: scratch, bundle: "com.ardia.browser", destination: destination, data: data) == nil)
    }
    #expect(WebKitImportedStores.resolve(profile, scratch: nil, bundle: "com.ardia.preview", destination: destination, data: data) == nil)
    #expect(WebKitImportedStores.resolve(profile, scratch: nil, bundle: "com.ardia.browser", destination: "/other", data: data) == nil)
  }

  @Test func `invalid ownership documents never resolve`() throws {
    for (profile, _, data) in [try document(duplicate: true), try document(version: 2), try document(scope: "/tmp/../preview"), try document(scope: "/"), try document(source: "incognito:private"), try document(source: "../default")] {
      #expect(WebKitImportedStores.resolve(profile, scratch: nil, bundle: "com.ardia.browser", destination: destination, data: data) == nil)
    }
    let (profile, _, data) = try document()
    let changed = String(decoding: data, as: UTF8.self).replacingOccurrences(of: "AF4FA80E-706A-5BD0-9BE1-AD8F105197FC", with: UUID().uuidString)
    #expect(WebKitImportedStores.resolve(profile, scratch: nil, bundle: "com.ardia.browser", destination: destination, data: Data(changed.utf8)) == nil)
    #expect(WebKitImportedStores.resolve(profile, scratch: nil, bundle: "com.ardia.browser", destination: destination, data: Data("{}".utf8)) == nil)
  }
}
