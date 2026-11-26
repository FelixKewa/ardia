import Foundation
import WebKit

@available(macOS 15.4, *)
enum WebKitExtensionPolicy {
  static func fullWebPattern(_ value: String) -> WKWebExtension.MatchPattern? {
    guard value.hasPrefix("http://") || value.hasPrefix("https://"), value.hasSuffix("/*"),
      let pattern = try? WKWebExtension.MatchPattern(string: value), pattern.path == "/*" else { return nil }
    return pattern
  }

  static func covers(_ allowed: [String], requested: WKWebExtension.MatchPattern) -> Bool {
    guard fullWebPattern(requested.string) != nil else { return false }
    return allowed.compactMap(fullWebPattern).contains { $0.matches(requested) }
  }

  static func allWebsites(_ resource: WKWebExtension) -> Bool {
    let declared = resource.allRequestedMatchPatterns.union(resource.optionalPermissionMatchPatterns)
    return WebKitExtensionPreparation.websites.allSatisfy { value in
      guard let pattern = fullWebPattern(value) else { return false }
      return declared.contains { $0.matches(pattern) }
    }
  }

  static func requireAllWebsites(_ requested: Bool, resource: WKWebExtension) throws {
    guard !requested || allWebsites(resource) else {
      throw WebKitExtensionPackage.failure("This extension does not request all websites. Load a package that declares HTTP and HTTPS website access.")
    }
  }

  static func permits(_ origin: String, resource: WKWebExtension, allWebsites: Bool, allowLoopback: Bool) -> Bool {
    guard let pattern = fullWebPattern(origin),
      allWebsites ? WebKitExtensionPreparation.websites.contains(origin) : WebKitExtensionPackage.exactOrigin(origin, allowLoopback: allowLoopback) else { return false }
    return resource.allRequestedMatchPatterns.union(resource.optionalPermissionMatchPatterns).contains { $0.matches(pattern) }
  }

  static func allows(_ url: URL, origins: [String], allWebsites: Bool, allowLoopback: Bool) -> Bool {
    guard allWebsites else { return WebKitExtensionPackage.allows(url, origins: origins, allowLoopback: allowLoopback) }
    guard url.user == nil, url.password == nil, ["http", "https"].contains(url.scheme?.lowercased() ?? ""), url.host != nil else { return false }
    return origins.compactMap(fullWebPattern).contains { $0.matches(url) }
  }
}
