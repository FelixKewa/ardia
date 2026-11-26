import XCTest
@testable import ArdiaUpdaterCore

final class PersonalUpdatePolicyTests: XCTestCase {
  let feed = "https://github.com/FelixKewa/ardia/releases/latest/download/appcast.xml"

  var info: [String: Any] {
    ["ACPersonalBuild": true, "ACPersonalSigningCertificateSHA256": String(repeating: "a", count: 64),
     "CFBundleIdentifier": "com.ardia.browser", "SUPublicEDKey": "personal-public-key", "SUFeedURL": feed, "ACUpdateChannel": "nightly"]
  }

  func testNormalAndBackgroundPersonalLaunchesIgnoreInheritedAndEnvironmentFeeds() {
    let policy = PersonalUpdatePolicy(info: info)
    for background in [false, true] {
      XCTAssertEqual(policy.feed(isolated: false, instance: "https://example.com/instance", saved: "https://ardia.dev/appcast.xml", background: background), feed)
    }
    XCTAssertEqual(policy.channelDefaultsKey, "ACPersonalUpdateChannel")
  }

  func testIsolatedPersonalUpdateFixtureCanUseItsExplicitLocalFeed() {
    let policy = PersonalUpdatePolicy(info: info)
    XCTAssertEqual(policy.feed(isolated: true, instance: "http://127.0.0.1:1234/appcast.xml", saved: "https://ardia.dev/appcast.xml", background: true), "http://127.0.0.1:1234/appcast.xml")
    XCTAssertEqual(policy.feed(isolated: true, instance: nil, saved: "https://ardia.dev/appcast.xml", background: true), feed)
  }

  func testMissingOrInvalidSignedFeedCannotFallBackToSparkleUserDefaults() {
    for value in ["", "http://example.com/appcast.xml", "file:///tmp/appcast.xml", "https://user:secret@example.com/appcast.xml"] {
      var changed = info
      changed["SUFeedURL"] = value
      XCTAssertEqual(PersonalUpdatePolicy(info: changed).feed(isolated: false, instance: nil, saved: "https://ardia.dev/appcast.xml", background: false), "")
    }
    var changed = info
    changed.removeValue(forKey: "SUFeedURL")
    XCTAssertEqual(PersonalUpdatePolicy(info: changed).feed(isolated: false, instance: nil, saved: nil, background: true), "")
  }

  func testOrdinaryBuildsKeepTheirExistingPreferenceDomain() {
    let policy = PersonalUpdatePolicy(info: ["SUFeedURL": "https://example.com/default"])
    XCTAssertFalse(policy.isPersonal)
    XCTAssertEqual(policy.channelDefaultsKey, "ACUpdateChannel")
    XCTAssertEqual(policy.feed(isolated: false, instance: nil, saved: "https://example.com/saved", background: false), "https://example.com/saved")
    XCTAssertEqual(policy.feed(isolated: false, instance: nil, saved: nil, background: true), "https://github.com/ardia-browser/ardia/releases/latest/download/appcast.xml")
  }

  func testAnOfficialNightlyIsNotAnApprovedPersonalStagedUpdate() {
    let policy = PersonalUpdatePolicy(info: info)
    XCTAssertFalse(policy.acceptsStaged(["CFBundleIdentifier": "com.ardia.browser", "ACUpdateChannel": "nightly"], signatureValid: true))
    XCTAssertFalse(policy.acceptsStaged(info, signatureValid: false))
    for key in ["CFBundleIdentifier", "ACPersonalSigningCertificateSHA256", "SUPublicEDKey", "SUFeedURL"] {
      var changed = info
      changed[key] = "different"
      XCTAssertFalse(policy.acceptsStaged(changed, signatureValid: true), key)
    }
    XCTAssertTrue(policy.acceptsStaged(info, signatureValid: true))
  }
}
