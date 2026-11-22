import CryptoKit
import Foundation
import IOKit

final class VaultStore {
  static let shared = VaultStore()

  struct AlwaysGrant: Codable, Equatable {
    let profile: String
    let origin: String
    let teamId: String
    let identifier: String
    let program: String
    let added: Double
  }

  private struct Contents: Codable {
    var version = 1
    var codes: [String: VerificationCode] = [:]
    var always: [AlwaysGrant] = []
  }

  private struct KeyFile: Codable {
    var version = 1
    var kind: String
    var wrapped: Data
    var peer: Data
    var salt: Data
    var machine: Data
    var check: Data
  }

  private static let machine: Data = {
    let service = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOPlatformExpertDevice"))
    defer { IOObjectRelease(service) }
    let uuid = (IORegistryEntryCreateCFProperty(service, "IOPlatformUUID" as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue() as? String) ?? ""
    return Data(SHA256.hash(data: Data("ardia-vault-machine\n\(uuid)".utf8)))
  }()

  private static func checksum(_ wrapped: Data) -> Data { Data(SHA256.hash(data: wrapped)) }

  let queue = DispatchQueue(label: "ardia.vault", qos: .userInitiated)
  private var loaded = false
  private var key: SymmetricKey?
  private var contents = Contents()
  private(set) var problem: String?
  private(set) var unlockMs: Double = 0

  private var folder: URL { URL(fileURLWithPath: ArdiaHost.dataDirectory).appendingPathComponent("Ardia Vault", isDirectory: true) }
  private var keyURL: URL { folder.appendingPathComponent("vault-key.json") }
  private var sealedURL: URL { folder.appendingPathComponent("vault.sealed") }
  var activityURL: URL { folder.appendingPathComponent("activity.jsonl") }

  static func codeKey(_ profile: String, _ origin: String, _ username: String) -> String { "\(profile)\n\(origin)\n\(username)" }

  private var software: Bool { LaunchConfig.shared.testValue("vaultKey") == "software" }

  func ensureFolder() {
    try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
  }

  private func loadIfNeeded() {
    if loaded { return }
    loaded = true
    let started = DispatchTime.now().uptimeNanoseconds
    defer { unlockMs = Double(DispatchTime.now().uptimeNanoseconds - started) / 1_000_000 }
    guard let data = try? Data(contentsOf: keyURL) else { return }
    guard let file = try? JSONDecoder().decode(KeyFile.self, from: data), let restored = restoreKey(file) else {
      problem = "unrecoverable"
      setAside()
      return
    }
    key = restored
    guard let sealed = try? Data(contentsOf: sealedURL) else { return }
    guard let box = try? AES.GCM.SealedBox(combined: sealed), let plain = try? AES.GCM.open(box, using: restored), let read = try? JSONDecoder().decode(Contents.self, from: plain), read.version == 1 else {
      problem = "unreadable"
      return
    }
    contents = read
  }

  private func setAside() {
    let stamp = Int(Date().timeIntervalSince1970)
    for url in [keyURL, sealedURL] where FileManager.default.fileExists(atPath: url.path) {
      try? FileManager.default.moveItem(at: url, to: url.appendingPathExtension("unreadable-\(stamp)"))
    }
  }

  private func restoreKey(_ file: KeyFile) -> SymmetricKey? {
    switch file.kind {
    case "software" where software:
      return file.wrapped.count == 32 ? SymmetricKey(data: file.wrapped) : nil
    case "secureEnclave":
      guard file.machine == Self.machine, file.check == Self.checksum(file.wrapped), SecureEnclave.isAvailable, let own = try? SecureEnclave.P256.KeyAgreement.PrivateKey(dataRepresentation: file.wrapped),
        let peer = try? P256.KeyAgreement.PublicKey(rawRepresentation: file.peer), let shared = try? own.sharedSecretFromKeyAgreement(with: peer)
      else { return nil }
      return shared.hkdfDerivedSymmetricKey(using: SHA256.self, salt: file.salt, sharedInfo: Data("ardia-vault-1".utf8), outputByteCount: 32)
    default:
      return nil
    }
  }

  private func makeKey() -> SymmetricKey? {
    ensureFolder()
    let file: KeyFile
    let made: SymmetricKey
    if software {
      made = SymmetricKey(size: .bits256)
      let wrapped = made.withUnsafeBytes { Data($0) }
      file = KeyFile(kind: "software", wrapped: wrapped, peer: Data(), salt: Data(), machine: Self.machine, check: Self.checksum(wrapped))
    } else {
      guard SecureEnclave.isAvailable, let own = try? SecureEnclave.P256.KeyAgreement.PrivateKey() else {
        problem = "unavailable"
        return nil
      }
      let peer = P256.KeyAgreement.PrivateKey()
      var salt = Data(count: 32)
      _ = salt.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!) }
      guard let shared = try? own.sharedSecretFromKeyAgreement(with: peer.publicKey) else { return nil }
      made = shared.hkdfDerivedSymmetricKey(using: SHA256.self, salt: salt, sharedInfo: Data("ardia-vault-1".utf8), outputByteCount: 32)
      file = KeyFile(kind: "secureEnclave", wrapped: own.dataRepresentation, peer: peer.publicKey.rawRepresentation, salt: salt, machine: Self.machine, check: Self.checksum(own.dataRepresentation))
    }
    guard let data = try? JSONEncoder().encode(file), (try? data.write(to: keyURL, options: [.atomic])) != nil else { return nil }
    try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: keyURL.path)
    problem = nil
    return made
  }

  private func save() -> Bool {
    if key == nil { key = makeKey() }
    guard let key, let plain = try? JSONEncoder().encode(contents), let sealed = try? AES.GCM.seal(plain, using: key).combined else { return false }
    ensureFolder()
    guard (try? sealed.write(to: sealedURL, options: [.atomic])) != nil else { return false }
    try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: sealedURL.path)
    return true
  }

  func state() -> [String: Any] {
    loadIfNeeded()
    return ["problem": problem as Any? ?? NSNull(), "unlockMs": unlockMs, "secureEnclave": SecureEnclave.isAvailable, "kind": software ? "software" : "secureEnclave"]
  }

  func saveCode(_ code: VerificationCode, profile: String, origin: String, username: String) -> Bool {
    loadIfNeeded()
    contents.codes[Self.codeKey(profile, origin, username)] = code
    return save()
  }

  func removeCode(profile: String, origin: String, username: String) -> Bool {
    loadIfNeeded()
    guard contents.codes.removeValue(forKey: Self.codeKey(profile, origin, username)) != nil else { return true }
    return save()
  }

  func code(profile: String, origin: String, username: String) -> VerificationCode? {
    loadIfNeeded()
    return contents.codes[Self.codeKey(profile, origin, username)]
  }

  func codes(profile: String) -> [[String: String]] {
    loadIfNeeded()
    return contents.codes.keys.compactMap { key in
      let parts = key.components(separatedBy: "\n")
      guard parts.count == 3, parts[0] == profile else { return nil }
      return ["origin": parts[1], "username": parts[2]]
    }
  }

  func always() -> [AlwaysGrant] {
    loadIfNeeded()
    return contents.always
  }

  func setAlways(_ grant: AlwaysGrant, on: Bool) -> Bool {
    loadIfNeeded()
    let same = { (g: AlwaysGrant) in g.profile == grant.profile && g.origin == grant.origin && g.teamId == grant.teamId && g.identifier == grant.identifier }
    contents.always.removeAll(where: same)
    if on { contents.always.append(grant) }
    return save()
  }
}
