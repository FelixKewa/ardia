import Foundation

struct PersonalUpdatePolicy {
  let info: [String: Any]

  var isPersonal: Bool { info["ACPersonalBuild"] != nil || info["ACPersonalSigningCertificateSHA256"] != nil }

  var channelDefaultsKey: String { isPersonal ? "ACPersonalUpdateChannel" : "ACUpdateChannel" }

  func feed(isolated: Bool, instance: String?, saved: String?, background: Bool) -> String? {
    if isolated, let instance { return instance }
    if isPersonal {
      guard let feed = info["SUFeedURL"] as? String, let url = URLComponents(string: feed),
        url.scheme == "https", let host = url.host, !host.isEmpty, url.user == nil, url.password == nil
      else { return "" }
      return feed
    }
    return instance ?? saved ?? (background ? "https://github.com/ardia-browser/ardia/releases/latest/download/appcast.xml" : nil)
  }

  func acceptsStaged(_ staged: [String: Any], signatureValid: Bool) -> Bool {
    guard isPersonal else { return true }
    guard signatureValid, staged["ACPersonalBuild"] as? Bool == true,
      staged["CFBundleIdentifier"] as? String == "com.ardia.browser"
    else { return false }
    for key in ["ACPersonalSigningCertificateSHA256", "SUPublicEDKey", "SUFeedURL"] {
      guard let expected = info[key] as? String, !expected.isEmpty, staged[key] as? String == expected else { return false }
    }
    return true
  }
}
