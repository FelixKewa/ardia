import CryptoKit
import Darwin
import Foundation

enum WebCryptoKeyFile {
  enum Stored: Equatable {
    case absent
    case contents(Data)
    case unreadable
  }

  enum SetAside: Equatable {
    case moved
    case opened(Data)
    case failed
  }

  static let keyLength = 16
  static let magic = Data("ArdiaWCK".utf8)
  static let header = magic + Data([1])
  static let length = header.count + 12 + keyLength + 16
  private static let purpose = Data("ardia.webcrypto.master-key.v1".utf8)

  private static func sealingKey(_ secret: Data) -> SymmetricKey {
    HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: secret), info: purpose, outputByteCount: 32)
  }

  static func seal(_ key: Data, secret: Data) -> Data? {
    guard key.count == keyLength, !secret.isEmpty,
      let box = try? AES.GCM.seal(key, using: sealingKey(secret), authenticating: header).combined
    else { return nil }
    return header + box
  }

  static func isSealed(_ contents: Data) -> Bool {
    contents.count == length && contents.starts(with: header)
  }

  static func open(_ contents: Data, secret: Data) -> Data? {
    guard !secret.isEmpty, isSealed(contents),
      let box = try? AES.GCM.SealedBox(combined: Data(contents.dropFirst(header.count))),
      let key = try? AES.GCM.open(box, using: sealingKey(secret), authenticating: header), key.count == keyLength
    else { return nil }
    return key
  }

  static func read(_ file: URL) -> Stored {
    let descriptor = Darwin.open(file.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
    guard descriptor >= 0 else { return errno == ENOENT ? .absent : .unreadable }
    defer { close(descriptor) }
    var info = stat()
    guard fstat(descriptor, &info) == 0, info.st_mode & S_IFMT == S_IFREG else { return .unreadable }
    var buffer = [UInt8](repeating: 0, count: length + 1)
    var filled = 0
    while filled < buffer.count {
      let count = buffer.withUnsafeMutableBytes { Darwin.read(descriptor, $0.baseAddress! + filled, $0.count - filled) }
      if count == 0 { break }
      if count < 0 {
        if errno == EINTR { continue }
        return .unreadable
      }
      filled += count
    }
    let contents = Data(buffer.prefix(filled))
    let fromAnotherVersion = contents.count > magic.count && contents.starts(with: magic) && !contents.starts(with: header)
    return fromAnotherVersion ? .unreadable : .contents(contents)
  }

  static func create(_ contents: Data, at file: URL) -> Bool {
    let staged = file.path + ".new-" + UUID().uuidString
    let descriptor = Darwin.open(staged, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
    guard descriptor >= 0 else { return false }
    var written = fchmod(descriptor, 0o600) == 0
      && contents.withUnsafeBytes { write(descriptor, $0.baseAddress, $0.count) } == contents.count
      && flush(descriptor)
    written = close(descriptor) == 0 && written
    if written && renamex_np(staged, file.path, UInt32(RENAME_EXCL)) == 0 {
      flushFolder(of: file)
      return true
    }
    unlink(staged)
    return false
  }

  private static func flush(_ descriptor: Int32) -> Bool {
    fcntl(descriptor, F_FULLFSYNC) == 0 || fsync(descriptor) == 0
  }

  private static func flushFolder(of file: URL) {
    let folder = Darwin.open(file.deletingLastPathComponent().path, O_RDONLY | O_CLOEXEC)
    guard folder >= 0 else { return }
    _ = flush(folder)
    close(folder)
  }

  static func setAside(_ file: URL, unlessOpenedBy secret: Data, at date: Date = Date()) -> SetAside {
    let kept = file.path + ".unreadable-\(Int(date.timeIntervalSince1970 * 1000))"
    guard renamex_np(file.path, kept, UInt32(RENAME_EXCL)) == 0 else { return .failed }
    guard case .contents(let contents) = read(URL(fileURLWithPath: kept)), let key = open(contents, secret: secret) else { return .moved }
    _ = renamex_np(kept, file.path, UInt32(RENAME_EXCL))
    return .opened(key)
  }
}
