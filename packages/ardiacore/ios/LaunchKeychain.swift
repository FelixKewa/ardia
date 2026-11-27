import Foundation

@objc(ArdiaLaunchKeychain)
public final class LaunchKeychain: NSObject {
  @objc(prepareWithDirectory:mockKeychain:)
  public static func prepare(directory: String, mockKeychain: Bool) {
    guard #available(macOS 15.0, *), WebCryptoMasterKey.shared == nil else { return }
    let config = LaunchConfig.shared
    let plan = KeychainPlan(
      folder: URL(fileURLWithPath: directory, isDirectory: true), hasDataDirectory: config.dataDirectory != nil, background: config.background,
      mock: mockKeychain, test: { config.testValue($0) })
    let master = WebCryptoMasterKey(keychain: plan.keychain, file: plan.keyFile) { source in
      plan.seam?.note("resolved \(source.rawValue)")
      NSLog("[webcrypto] master key: %@", source.rawValue)
    }
    WebCryptoMasterKey.shared = master
    master.prepare()
  }
}
