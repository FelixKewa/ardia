import Foundation
import Security

enum KeychainRead: Equatable {
  case found(Data)
  case missing
  case failed(OSStatus)

  var outcome: String {
    switch self {
    case .found: "found"
    case .missing: "missing"
    case .failed(let status): "failed \(status)"
    }
  }
}

protocol AppKeychain {
  func safeStorageSecret() -> KeychainRead
  func webCryptoItem() -> KeychainRead
}

struct SystemKeychain: AppKeychain {
  static var webCryptoAccount: String {
    "com.apple.WebKit.WebCrypto.master+" + (Bundle.main.bundleIdentifier ?? ProcessInfo.processInfo.processName)
  }

  static var safeStorageQuery: [String: Any] {
    [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "Ardia Safe Storage",
     kSecAttrAccount as String: "Ardia", kSecReturnData as String: true]
  }

  static var webCryptoQuery: [String: Any] {
    [kSecClass as String: kSecClassGenericPassword, kSecAttrAccount as String: webCryptoAccount, kSecReturnData as String: true]
  }

  func safeStorageSecret() -> KeychainRead { find(Self.safeStorageQuery) }

  func webCryptoItem() -> KeychainRead { find(Self.webCryptoQuery) }

  private func find(_ query: [String: Any]) -> KeychainRead {
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return .missing }
    guard status == errSecSuccess else { return .failed(status) }
    guard let data = result as? Data, !data.isEmpty else { return .failed(errSecDecode) }
    return .found(data)
  }
}

struct KeychainPlan {
  let keychain: AppKeychain
  let keyFile: URL
  var seam: FileKeychain?

  init(folder: URL, hasDataDirectory: Bool, background: Bool, mock: Bool, test: (String) -> String?) {
    var name = "WebCrypto Master Key"
    if !hasDataDirectory && !mock && !background {
      keychain = SystemKeychain()
    } else if !hasDataDirectory || !mock {
      keychain = ClosedKeychain()
    } else if test("keychain") == "file" {
      let files = FileKeychain(directory: folder, failure: test("keychainFail").flatMap { FileKeychain.failures[$0] })
      keychain = files
      seam = files
    } else {
      keychain = MockKeychain()
      name = "Mock WebCrypto Master Key"
    }
    keyFile = folder.appendingPathComponent(name)
  }
}

struct ClosedKeychain: AppKeychain {
  func safeStorageSecret() -> KeychainRead { .failed(errSecInteractionNotAllowed) }
  func webCryptoItem() -> KeychainRead { .failed(errSecInteractionNotAllowed) }
}

struct MockKeychain: AppKeychain {
  func safeStorageSecret() -> KeychainRead { .found(Data("mock_password".utf8)) }
  func webCryptoItem() -> KeychainRead { .missing }
}

struct FileKeychain: AppKeychain {
  static let safeStorageName = "Test Safe Storage Key"
  static let webCryptoName = "Test WebCrypto Master Key"
  static let logName = "Test App Keychain Log"
  static let failures: [String: OSStatus] = [
    "decode": errSecDecode, "denied": errSecAuthFailed, "interaction": errSecInteractionRequired,
    "entitlement": errSecMissingEntitlement, "io": errSecIO,
  ]

  let directory: URL
  var failure: OSStatus?

  func safeStorageSecret() -> KeychainRead { find(Self.safeStorageName, as: "safe-storage") }

  func webCryptoItem() -> KeychainRead { find(Self.webCryptoName, as: "webcrypto") }

  func note(_ line: String) {
    let log = directory.appendingPathComponent(Self.logName)
    let data = Data((line + "\n").utf8)
    guard let handle = try? FileHandle(forWritingTo: log) else {
      try? data.write(to: log)
      return
    }
    defer { try? handle.close() }
    _ = try? handle.seekToEnd()
    try? handle.write(contentsOf: data)
  }

  private func find(_ name: String, as item: String) -> KeychainRead {
    let read: KeychainRead
    if let failure {
      read = .failed(failure)
    } else if let data = try? Data(contentsOf: directory.appendingPathComponent(name)) {
      read = data.isEmpty ? .failed(errSecDecode) : .found(data)
    } else {
      read = .missing
    }
    note("find \(item) \(read.outcome)")
    return read
  }
}
