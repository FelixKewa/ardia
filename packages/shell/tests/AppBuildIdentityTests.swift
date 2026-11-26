import XCTest
@testable import ArdiaUpdaterCore

final class AppBuildIdentityTests: XCTestCase {
  let personal: [String: Any] = ["ACPersonalBuild": true, "CFBundleVersion": "1003", "CFBundleShortVersionString": "0.2.49-nightly.1003", "ACReleaseNotesURL": "https://github.com/FelixKewa/ardia/releases/tag/personal-1003"]

  func testPersonalBuildIsNamedAndLinksToItsExactForkReleaseSource() {
    let identity = AppBuildIdentity(info: personal)
    XCTAssertEqual(identity.displayVersion("0.2.49-nightly.1003"), "0.2.49 Personal 1003")
    XCTAssertEqual(identity.links.map { $0.1 }, ["https://github.com/FelixKewa/ardia/tree/personal-1003", "https://github.com/FelixKewa/ardia/blob/personal-1003/LICENSE", "https://github.com/FelixKewa/ardia/blob/personal-1003/NOTICE"])
    XCTAssertEqual(identity.displayVersion("0.2.50"), "0.2.50 Personal")
  }

  func testOfficialStableAndNightlyKeepTheirNamesAndLinks() {
    for version in ["0.2.49", "0.2.49-nightly.2"] {
      let identity = AppBuildIdentity(info: ["CFBundleShortVersionString": version])
      XCTAssertEqual(identity.displayVersion(version), version == "0.2.49" ? version : "0.2.49 Nightly 2")
      XCTAssertEqual(identity.links.map { $0.1 }, ["https://github.com/ardia-browser/ardia/tree/v\(version)", "https://github.com/ardia-browser/ardia/blob/v\(version)/LICENSE", "https://github.com/ardia-browser/ardia/blob/v\(version)/NOTICE"])
    }
  }

  func testPersonalBuildCannotLinkToAnUnrelatedOrInvalidRelease() {
    for notes in ["https://github.com/ardia-browser/ardia/releases/tag/v0.2.49", "https://github.com/FelixKewa/ardia/releases/tag/personal-1002", "http://github.com/FelixKewa/ardia/releases/tag/personal-1003", "https://user@github.com/FelixKewa/ardia/releases/tag/personal-1003", ""] {
      var info = personal
      info["ACReleaseNotesURL"] = notes
      XCTAssertTrue(AppBuildIdentity(info: info).links.isEmpty, notes)
    }
  }
}
