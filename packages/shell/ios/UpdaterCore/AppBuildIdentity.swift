import Foundation

struct AppBuildIdentity {
  let info: [String: Any]

  var isPersonal: Bool { PersonalUpdatePolicy(info: info).isPersonal }

  func displayVersion(_ version: String) -> String {
    guard let range = version.range(of: #"-nightly\.(\d+)$"#, options: .regularExpression) else {
      return isPersonal ? "\(version) Personal" : version
    }
    let number = version[range].split(separator: ".").last.map(String.init) ?? ""
    return "\(version[..<range.lowerBound]) \(isPersonal ? "Personal" : "Nightly") \(number)"
  }

  var links: [(String, String)] {
    let version = info["CFBundleShortVersionString"] as? String ?? ""
    let repository: String
    let tag: String
    if isPersonal {
      guard let build = info["CFBundleVersion"] as? String, !build.isEmpty,
        build.allSatisfy({ $0.isASCII && $0.isNumber }),
        let notes = info["ACReleaseNotesURL"] as? String, let url = URLComponents(string: notes),
        url.scheme == "https", url.host == "github.com", url.user == nil, url.password == nil,
        url.port == nil, url.query == nil, url.fragment == nil
      else { return [] }
      let parts = url.path.split(separator: "/")
      guard parts.count == 5, parts[2] == "releases", parts[3] == "tag", parts[4] == "personal-\(build)" else { return [] }
      repository = "https://github.com/\(parts[0])/\(parts[1])"
      tag = "personal-\(build)"
    } else {
      repository = "https://github.com/ardia-browser/ardia"
      tag = "v\(version)"
    }
    return [("Source code", "\(repository)/tree/\(tag)"), ("License", "\(repository)/blob/\(tag)/LICENSE"), ("Credits", "\(repository)/blob/\(tag)/NOTICE")]
  }
}
