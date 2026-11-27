import Foundation
import Security

final class WebCryptoMasterKey {
  enum Source: String {
    case file, migrated, generated, rewrapped, legacy, unavailable
  }

  struct Resolution: Equatable {
    let key: Data
    let source: Source

    static let unavailable = Resolution(key: Data(), source: .unavailable)
  }

  private struct Attempt {
    let outcome: Resolution
    var mayChange = false
  }

  private enum SafeStorage {
    case unread
    case held(Data)
    case absent
    case refused
  }

  private enum OldKey {
    case usable(Data)
    case missing
    case unusable
  }

  static var shared: WebCryptoMasterKey?

  let file: URL
  private let keychain: AppKeychain
  private let random: () -> Data?
  private let report: (Source) -> Void
  private let work = DispatchQueue(label: "ardia.webcrypto.master-key", qos: .userInitiated)
  private let lock = NSLock()
  private var safeStorage = SafeStorage.unread
  private var resolution: Resolution?
  private var waiting: [(Data) -> Void] = []

  init(keychain: AppKeychain, file: URL, random: @escaping () -> Data? = WebCryptoMasterKey.systemRandom, report: @escaping (Source) -> Void) {
    self.keychain = keychain
    self.file = file
    self.random = random
    self.report = report
  }

  static func systemRandom() -> Data? {
    var bytes = [UInt8](repeating: 0, count: WebCryptoKeyFile.keyLength)
    return SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess ? Data(bytes) : nil
  }

  func prepare() {
    work.sync {
      readSafeStorage()
      if case .held = safeStorage { settle(resolve()) }
    }
  }

  func answer(_ completion: @escaping (Data) -> Void) {
    lock.lock()
    if let resolution {
      lock.unlock()
      return completion(resolution.key)
    }
    waiting.append(completion)
    let first = waiting.count == 1
    lock.unlock()
    guard first else { return }
    work.async { [self] in
      if case .held = safeStorage {} else { readSafeStorage() }
      settle(resolve())
    }
  }

  private func settle(_ attempt: Attempt) {
    report(attempt.outcome.source)
    lock.lock()
    resolution = attempt.mayChange ? nil : attempt.outcome
    let replies = waiting
    waiting = []
    lock.unlock()
    if !replies.isEmpty { DispatchQueue.main.async { replies.forEach { $0(attempt.outcome.key) } } }
  }

  private func readSafeStorage() {
    switch keychain.safeStorageSecret() {
    case .found(let secret): safeStorage = .held(secret)
    case .missing: safeStorage = .absent
    case .failed: safeStorage = .refused
    }
  }

  private func resolve() -> Attempt {
    let stored = WebCryptoKeyFile.read(file)
    guard case .held(let secret) = safeStorage else { return withoutSecret(stored) }
    if let key = open(stored, secret) { return Attempt(outcome: Resolution(key: key, source: .file)) }
    switch oldKey() {
    case .usable(let key):
      let unsaved = Resolution(key: key, source: .legacy)
      switch stored {
      case .absent: return Attempt(outcome: save(key, secret, as: .migrated) ?? unsaved)
      case .contents:
        if let winner = current(secret) { return Attempt(outcome: winner) }
        guard WebCryptoKeyFile.setAside(file) else { return Attempt(outcome: unsaved) }
        return Attempt(outcome: save(key, secret, as: .rewrapped) ?? unsaved)
      case .unreadable: return Attempt(outcome: unsaved)
      }
    case .missing:
      guard stored == .absent, let fresh = random(), fresh.count == WebCryptoKeyFile.keyLength else { return Attempt(outcome: .unavailable) }
      return Attempt(outcome: save(fresh, secret, as: .generated) ?? .unavailable)
    case .unusable:
      return Attempt(outcome: .unavailable)
    }
  }

  private func withoutSecret(_ stored: WebCryptoKeyFile.Stored) -> Attempt {
    var secretMayAppear = false
    if case .absent = safeStorage { secretMayAppear = true }
    guard stored == .absent else { return Attempt(outcome: .unavailable, mayChange: secretMayAppear) }
    switch oldKey() {
    case .usable(let key): return Attempt(outcome: Resolution(key: key, source: .legacy))
    case .missing: return Attempt(outcome: .unavailable, mayChange: secretMayAppear)
    case .unusable: return Attempt(outcome: .unavailable)
    }
  }

  private func oldKey() -> OldKey {
    switch keychain.webCryptoItem() {
    case .found(let value):
      guard let key = Data(base64Encoded: value), key.count == WebCryptoKeyFile.keyLength else { return .unusable }
      return .usable(key)
    case .missing: return .missing
    case .failed: return .unusable
    }
  }

  private func open(_ stored: WebCryptoKeyFile.Stored, _ secret: Data) -> Data? {
    guard case .contents(let contents) = stored else { return nil }
    return WebCryptoKeyFile.open(contents, secret: secret)
  }

  private func current(_ secret: Data) -> Resolution? {
    open(WebCryptoKeyFile.read(file), secret).map { Resolution(key: $0, source: .file) }
  }

  private func save(_ key: Data, _ secret: Data, as source: Source) -> Resolution? {
    if let sealed = WebCryptoKeyFile.seal(key, secret: secret), WebCryptoKeyFile.create(sealed, at: file) {
      return Resolution(key: key, source: source)
    }
    return current(secret)
  }
}
