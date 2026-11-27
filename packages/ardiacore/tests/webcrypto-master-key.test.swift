import Darwin
import Foundation
import Security
import Testing
import WebKit

final class LaunchConfig {
  nonisolated(unsafe) static var shared = LaunchConfig()
  var dataDirectory: String?
  var background = false
  var tests: [String: String] = [:]

  func testValue(_ key: String) -> String? { tests[key] }
}

final class FakeKeychain: AppKeychain {
  var secrets: [KeychainRead]
  var item: KeychainRead
  var held: DispatchSemaphore?
  var beforeItem: (() -> Void)?
  private(set) var secretReads = 0
  private(set) var itemReads = 0

  init(secret: KeychainRead, item: KeychainRead) {
    secrets = [secret]
    self.item = item
  }

  func safeStorageSecret() -> KeychainRead {
    secretReads += 1
    return secrets.count > 1 ? secrets.removeFirst() : secrets[0]
  }

  func webCryptoItem() -> KeychainRead {
    if let held { _ = held.wait(timeout: .now() + 20) }
    beforeItem?()
    itemReads += 1
    return item
  }
}

@Suite(.serialized) @MainActor struct WebCryptoMasterKeyTests {
  let secret = Data("synthetic safe storage secret".utf8)
  let original = Data((0..<16).map { UInt8($0 * 7 + 1) })
  let fresh = Data(repeating: 0x5A, count: 16)
  var stored: KeychainRead { .found(Data(original.base64EncodedString().utf8)) }

  final class Folder {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("ardia-webcrypto-" + UUID().uuidString)
    var file: URL { url.appendingPathComponent("WebCrypto Master Key") }

    init() throws { try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true) }
    deinit { try? FileManager.default.removeItem(at: url) }

    var names: [String] { ((try? FileManager.default.contentsOfDirectory(atPath: url.path)) ?? []).sorted() }
    var contents: Data? { try? Data(contentsOf: file) }
    var mode: mode_t {
      var info = stat()
      return lstat(file.path, &info) == 0 ? info.st_mode & 0o7777 : 0
    }
  }

  final class Outcomes { var sources: [WebCryptoMasterKey.Source] = [] }

  func launch(_ keychain: FakeKeychain, _ folder: Folder, _ outcomes: Outcomes = Outcomes(), random: (() -> Data?)? = nil) -> WebCryptoMasterKey {
    let made = fresh
    let master = WebCryptoMasterKey(keychain: keychain, file: folder.file, random: random ?? { made }) { outcomes.sources.append($0) }
    master.prepare()
    return master
  }

  func answer(_ master: WebCryptoMasterKey) async -> Data {
    await withCheckedContinuation { continuation in master.answer { continuation.resume(returning: $0) } }
  }

  func sealed(_ key: Data, _ secret: Data) throws -> Data { try #require(WebCryptoKeyFile.seal(key, secret: secret)) }

  @Test func `the key file opens only with the secret that sealed it and refuses any altered byte`() throws {
    let contents = try sealed(original, secret)
    #expect(contents.count == 53)
    #expect(contents.prefix(9) == Data("ArdiaWCK".utf8) + Data([1]))
    #expect(contents.range(of: original) == nil)
    #expect(WebCryptoKeyFile.open(contents, secret: secret) == original)
    #expect(try sealed(original, secret) != contents)
    #expect(WebCryptoKeyFile.open(contents, secret: Data("another secret".utf8)) == nil)
    #expect(WebCryptoKeyFile.open(contents, secret: Data()) == nil)
    for index in 0..<contents.count {
      var altered = contents
      altered[index] ^= 1
      #expect(WebCryptoKeyFile.open(altered, secret: secret) == nil)
    }
    for length in [0, 1, 8, 9, 21, 52] { #expect(WebCryptoKeyFile.open(Data(contents.prefix(length)), secret: secret) == nil) }
    #expect(WebCryptoKeyFile.open(contents + Data([0]), secret: secret) == nil)
    #expect(WebCryptoKeyFile.open(Data(contents + contents).dropFirst(53), secret: secret) == original)
    #expect(WebCryptoKeyFile.seal(Data(repeating: 1, count: 32), secret: secret) == nil)
    #expect(WebCryptoKeyFile.seal(Data(), secret: secret) == nil)
    #expect(WebCryptoKeyFile.seal(original, secret: Data()) == nil)
  }

  @Test func `a new key file is private and complete and never replaces an existing one`() throws {
    let folder = try Folder()
    let mask = umask(0o277)
    let created = WebCryptoKeyFile.create(Data("first".utf8), at: folder.file)
    umask(mask)
    #expect(created)
    #expect(folder.mode == 0o600)
    #expect(!WebCryptoKeyFile.create(Data("second".utf8), at: folder.file))
    #expect(folder.contents == Data("first".utf8))
    #expect(folder.names == ["WebCrypto Master Key"])
    #expect(!WebCryptoKeyFile.create(Data("x".utf8), at: folder.url.appendingPathComponent("absent/key")))
  }

  @Test func `an existing profile migrates its own key once and never reads the old item again`() async throws {
    let folder = try Folder()
    let outcomes = Outcomes()
    let first = FakeKeychain(secret: .found(secret), item: stored)
    let migrating = launch(first, folder, outcomes)
    #expect(first.secretReads == 1)
    #expect(first.itemReads == 1)
    #expect(await answer(migrating) == original)
    #expect(await answer(migrating) == original)
    #expect(first.secretReads == 1)
    #expect(first.itemReads == 1)
    #expect(folder.mode == 0o600)
    #expect(folder.names == ["WebCrypto Master Key"])
    let written = try #require(folder.contents)
    for _ in 1...2 {
      let later = FakeKeychain(secret: .found(secret), item: .failed(errSecAuthFailed))
      #expect(await answer(launch(later, folder, outcomes)) == original)
      #expect(later.secretReads == 1)
      #expect(later.itemReads == 0)
    }
    #expect(folder.contents == written)
    #expect(outcomes.sources == [.migrated, .file, .file])
  }

  @Test func `a fresh profile makes its own key without touching the keychain item twice`() async throws {
    let folder = try Folder()
    let outcomes = Outcomes()
    let first = FakeKeychain(secret: .found(secret), item: .missing)
    #expect(await answer(launch(first, folder, outcomes)) == fresh)
    let later = FakeKeychain(secret: .found(secret), item: .missing)
    #expect(await answer(launch(later, folder, outcomes, random: { Data(repeating: 1, count: 16) })) == fresh)
    #expect(first.itemReads == 1)
    #expect(later.itemReads == 0)
    #expect(folder.mode == 0o600)
    #expect(outcomes.sources == [.generated, .file])
  }

  @Test func `system randomness gives distinct sixteen byte keys`() throws {
    let first = try #require(WebCryptoMasterKey.systemRandom())
    let second = try #require(WebCryptoMasterKey.systemRandom())
    #expect(first.count == 16)
    #expect(first != second)
  }

  @Test(arguments: [true, false])
  func `a secret the engine creates after launch is read once at the first request`(hasItem: Bool) async throws {
    let folder = try Folder()
    let keychain = FakeKeychain(secret: .missing, item: hasItem ? stored : .missing)
    keychain.secrets = [.missing, .found(secret)]
    let master = launch(keychain, folder)
    #expect(keychain.secretReads == 1)
    #expect(keychain.itemReads == 0)
    #expect(folder.names == [])
    #expect(await answer(master) == (hasItem ? original : fresh))
    #expect(await answer(master) == (hasItem ? original : fresh))
    #expect(keychain.secretReads == 2)
    #expect(keychain.itemReads == 1)
    #expect(try WebCryptoKeyFile.open(#require(folder.contents), secret: secret) == (hasItem ? original : fresh))
  }

  @Test func `while the secret is only missing nothing is cached or created until it appears`() async throws {
    let folder = try Folder()
    let outcomes = Outcomes()
    let keychain = FakeKeychain(secret: .missing, item: .missing)
    let master = launch(keychain, folder, outcomes)
    #expect(await answer(master) == Data())
    #expect(await answer(master) == Data())
    #expect(keychain.secretReads == 3)
    #expect(folder.names == [])
    keychain.secrets = [.found(secret)]
    #expect(await answer(master) == fresh)
    #expect(await answer(master) == fresh)
    #expect(keychain.secretReads == 4)
    #expect(outcomes.sources == [.unavailable, .unavailable, .generated])
  }

  @Test func `a refused secret is asked for once more at the first request and then never again`() async throws {
    let folder = try Folder()
    let outcomes = Outcomes()
    let keychain = FakeKeychain(secret: .failed(errSecUserCanceled), item: .missing)
    let master = launch(keychain, folder, outcomes)
    #expect(keychain.itemReads == 0)
    #expect(await answer(master) == Data())
    #expect(await answer(master) == Data())
    #expect(keychain.secretReads == 2)
    #expect(keychain.itemReads == 1)
    #expect(folder.names == [])
    #expect(outcomes.sources == [.unavailable])
  }

  @Test func `a secret allowed after launch opens the key file without reading the old item`() async throws {
    let folder = try Folder()
    #expect(WebCryptoKeyFile.create(try sealed(original, secret), at: folder.file))
    let outcomes = Outcomes()
    let keychain = FakeKeychain(secret: .failed(errSecAuthFailed), item: .found(Data(fresh.base64EncodedString().utf8)))
    keychain.secrets = [.failed(errSecAuthFailed), .found(secret)]
    #expect(await answer(launch(keychain, folder, outcomes)) == original)
    #expect(keychain.secretReads == 2)
    #expect(keychain.itemReads == 0)
    #expect(outcomes.sources == [.file])
  }

  @Test func `a secret refused twice without a key file still serves the old item and writes nothing`() async throws {
    let folder = try Folder()
    let outcomes = Outcomes()
    let keychain = FakeKeychain(secret: .failed(errSecUserCanceled), item: stored)
    let master = launch(keychain, folder, outcomes)
    #expect(keychain.itemReads == 0)
    #expect(await answer(master) == original)
    #expect(await answer(master) == original)
    #expect(keychain.secretReads == 2)
    #expect(keychain.itemReads == 1)
    #expect(folder.names == [])
    #expect(outcomes.sources == [.legacy])
  }

  @Test(arguments: [KeychainRead.missing, .failed(errSecAuthFailed)])
  func `with a key file and no secret the old item is never read`(read: KeychainRead) async throws {
    let folder = try Folder()
    let contents = try sealed(fresh, secret)
    #expect(WebCryptoKeyFile.create(contents, at: folder.file))
    let keychain = FakeKeychain(secret: read, item: stored)
    let master = launch(keychain, folder)
    #expect(await answer(master) == Data())
    #expect(keychain.itemReads == 0)
    #expect(folder.contents == contents)
    keychain.secrets = [.found(secret)]
    #expect(await answer(master) == (read == .missing ? fresh : Data()))
    #expect(keychain.itemReads == 0)
  }

  @Test func `a closed keychain reads and writes nothing`() async throws {
    let folder = try Folder()
    let contents = try sealed(original, secret)
    #expect(WebCryptoKeyFile.create(contents, at: folder.file))
    for url in [folder.file, folder.url.appendingPathComponent("absent")] {
      let master = WebCryptoMasterKey(keychain: ClosedKeychain(), file: url) { _ in }
      master.prepare()
      #expect(await answer(master) == Data())
    }
    #expect(folder.contents == contents)
    #expect(folder.names == ["WebCrypto Master Key"])
  }

  @Test func `a key file from another version is left alone`() async throws {
    let folder = try Folder()
    var newer = try sealed(fresh, secret)
    newer[8] = 2
    newer += Data(repeating: 7, count: 40)
    try newer.write(to: folder.file)
    #expect(WebCryptoKeyFile.read(folder.file) == .unreadable)
    #expect(await answer(launch(FakeKeychain(secret: .found(secret), item: stored), folder)) == original)
    #expect(folder.contents == newer)
    #expect(folder.names == ["WebCrypto Master Key"])
  }

  @Test(arguments: [true, false])
  func `a good file written by another instance during migration or repair is used and kept`(damaged: Bool) async throws {
    let folder = try Folder()
    if damaged { #expect(WebCryptoKeyFile.create(try sealed(fresh, Data("a lost secret".utf8)), at: folder.file)) }
    let other = Data(repeating: 3, count: 16)
    let winner = try sealed(other, secret)
    let file = folder.file
    let outcomes = Outcomes()
    let keychain = FakeKeychain(secret: .found(secret), item: stored)
    keychain.beforeItem = {
      try? FileManager.default.removeItem(at: file)
      _ = WebCryptoKeyFile.create(winner, at: file)
    }
    #expect(await answer(launch(keychain, folder, outcomes)) == other)
    #expect(folder.contents == winner)
    #expect(folder.names == ["WebCrypto Master Key"])
    #expect(outcomes.sources == [.file])
  }

  @Test(arguments: [
    KeychainRead.failed(errSecAuthFailed), .failed(errSecUserCanceled), .failed(errSecInteractionNotAllowed), .failed(errSecIO),
    .found(Data("not base64!".utf8)), .found(Data(Data(repeating: 1, count: 32).base64EncodedString().utf8)),
    .found(Data(Data(repeating: 1, count: 15).base64EncodedString().utf8)),
  ])
  func `an old item that cannot be read or used is never replaced`(item: KeychainRead) async throws {
    let folder = try Folder()
    let keychain = FakeKeychain(secret: .found(secret), item: item)
    let master = launch(keychain, folder)
    #expect(await answer(master) == Data())
    #expect(await answer(master) == Data())
    #expect(keychain.itemReads == 1)
    #expect(folder.names == [])
  }

  @Test func `a key file that does not open is kept aside and rebuilt only from the old item`() async throws {
    let folder = try Folder()
    let damaged = try sealed(fresh, Data("a lost secret".utf8))
    #expect(WebCryptoKeyFile.create(damaged, at: folder.file))
    let outcomes = Outcomes()
    #expect(await answer(launch(FakeKeychain(secret: .found(secret), item: stored), folder, outcomes)) == original)
    let kept = folder.names.filter { $0.hasPrefix("WebCrypto Master Key.unreadable-") }
    #expect(kept.count == 1)
    #expect(folder.names.count == 2)
    #expect(try Data(contentsOf: folder.url.appendingPathComponent(#require(kept.first))) == damaged)
    #expect(try WebCryptoKeyFile.open(#require(folder.contents), secret: secret) == original)
    #expect(outcomes.sources == [.rewrapped])
  }

  @Test(arguments: [KeychainRead.missing, .failed(errSecAuthFailed)])
  func `a key file that does not open stays untouched without the old item`(item: KeychainRead) async throws {
    let folder = try Folder()
    let damaged = try sealed(original, Data("a lost secret".utf8))
    #expect(WebCryptoKeyFile.create(damaged, at: folder.file))
    #expect(await answer(launch(FakeKeychain(secret: .found(secret), item: item), folder)) == Data())
    #expect(folder.contents == damaged)
    #expect(folder.names == ["WebCrypto Master Key"])
  }

  @Test(arguments: ["directory", "link", "pipe", "locked"])
  func `something unreadable at the key path is left alone`(kind: String) async throws {
    let folder = try Folder()
    let target = folder.url.appendingPathComponent("target")
    let elsewhere = try sealed(fresh, secret)
    try elsewhere.write(to: target)
    switch kind {
    case "directory": try FileManager.default.createDirectory(at: folder.file, withIntermediateDirectories: false)
    case "link": try FileManager.default.createSymbolicLink(at: folder.file, withDestinationURL: target)
    case "pipe": #expect(mkfifo(folder.file.path, 0o600) == 0)
    default:
      try elsewhere.write(to: folder.file)
      #expect(chmod(folder.file.path, 0) == 0)
    }
    let before = folder.names
    #expect(WebCryptoKeyFile.read(folder.file) == .unreadable)
    #expect(await answer(launch(FakeKeychain(secret: .found(secret), item: stored), folder)) == original)
    #expect(await answer(launch(FakeKeychain(secret: .found(secret), item: .missing), folder)) == Data())
    #expect(folder.names == before)
    #expect(try Data(contentsOf: target) == elsewhere)
  }

  @Test func `a key written by another instance during creation wins`() async throws {
    let folder = try Folder()
    let other = Data(repeating: 9, count: 16)
    let winner = try sealed(other, secret)
    let file = folder.file
    let outcomes = Outcomes()
    let made = fresh
    let master = launch(FakeKeychain(secret: .found(secret), item: .missing), folder, outcomes, random: {
      _ = WebCryptoKeyFile.create(winner, at: file)
      return made
    })
    #expect(await answer(master) == other)
    #expect(folder.contents == winner)
    #expect(outcomes.sources == [.file])
  }

  @Test func `a failed random source creates nothing`() async throws {
    let folder = try Folder()
    #expect(await answer(launch(FakeKeychain(secret: .found(secret), item: .missing), folder, random: { nil })) == Data())
    #expect(folder.names == [])
  }

  @Test func `requests that arrive during the first resolution share one read and one answer each`() async throws {
    let folder = try Folder()
    let keychain = FakeKeychain(secret: .missing, item: stored)
    keychain.secrets = [.missing, .found(secret)]
    keychain.held = DispatchSemaphore(value: 0)
    let master = launch(keychain, folder)
    var answers: [Data] = []
    for _ in 1...20 { master.answer { answers.append($0) } }
    #expect(answers.isEmpty)
    keychain.held?.signal()
    for _ in 0..<200 where answers.count < 20 { try await Task.sleep(nanoseconds: 10_000_000) }
    #expect(answers == Array(repeating: original, count: 20))
    #expect(keychain.secretReads == 2)
    #expect(keychain.itemReads == 1)
    var late: Data?
    master.answer { late = $0 }
    #expect(late == original)
  }

  @Test func `no hostile key file is ever accepted`() async throws {
    let hostile = try #require(ProcessInfo.processInfo.environment["ARDIA_HOSTILE_DIR"])
    let names = try FileManager.default.contentsOfDirectory(atPath: hostile)
    #expect(names.count > 100)
    for name in names {
      let contents = try Data(contentsOf: URL(fileURLWithPath: hostile).appendingPathComponent(name))
      #expect(WebCryptoKeyFile.open(contents, secret: secret) == nil)
      let folder = try Folder()
      try contents.write(to: folder.file)
      #expect(await answer(launch(FakeKeychain(secret: .found(secret), item: .missing), folder)) == Data())
      #expect(folder.contents == contents)
      #expect(folder.names == ["WebCrypto Master Key"])
    }
  }

  @Test func `the system queries name exactly the engine's item and WebKit's item`() {
    let safe = SystemKeychain.safeStorageQuery
    #expect(safe[kSecAttrService as String] as? String == "Ardia Safe Storage")
    #expect(safe[kSecAttrAccount as String] as? String == "Ardia")
    #expect(safe.count == 4)
    let web = SystemKeychain.webCryptoQuery
    #expect(web[kSecAttrAccount as String] as? String == "com.apple.WebKit.WebCrypto.master+" + ProcessInfo.processInfo.processName)
    #expect(web.count == 3)
    for query in [safe, web] {
      #expect(query[kSecClass as String] as? String == kSecClassGenericPassword as String)
      #expect(query[kSecReturnData as String] as? Bool == true)
    }
  }

  @Test(arguments: [true, false], [true, false])
  func `the system keychain serves only an installed foreground launch`(hasDataDirectory: Bool, background: Bool) throws {
    let folder = try Folder()
    for mock in [true, false] {
      for seam in [true, false] {
        let plan = KeychainPlan(folder: folder.url, hasDataDirectory: hasDataDirectory, background: background, mock: mock) { key in
          seam && key == "keychain" ? "file" : nil
        }
        let installed = !hasDataDirectory && !background && !mock
        let testing = hasDataDirectory && mock
        #expect((plan.keychain is SystemKeychain) == installed)
        #expect((plan.keychain is FileKeychain) == (testing && seam))
        #expect((plan.keychain is MockKeychain) == (testing && !seam))
        #expect((plan.keychain is ClosedKeychain) == (!installed && !testing))
        #expect((plan.seam != nil) == (testing && seam))
        #expect(plan.keyFile.lastPathComponent == (testing && !seam ? "Mock WebCrypto Master Key" : "WebCrypto Master Key"))
        #expect(plan.keyFile.deletingLastPathComponent().path == folder.url.path)
      }
    }
  }

  @Test(arguments: ["seam", "denied", "mock", "closed"])
  func `the launch reads its keychain once and hands the key to later requests`(mode: String) async throws {
    let folder = try Folder()
    let config = LaunchConfig()
    config.dataDirectory = mode == "closed" ? nil : folder.url.path
    if mode == "seam" || mode == "denied" { config.tests["keychain"] = "file" }
    if mode == "denied" { config.tests["keychainFail"] = "denied" }
    LaunchConfig.shared = config
    try secret.write(to: folder.url.appendingPathComponent("Test Safe Storage Key"))
    try Data(original.base64EncodedString().utf8).write(to: folder.url.appendingPathComponent("Test WebCrypto Master Key"))
    WebCryptoMasterKey.shared = nil
    defer { WebCryptoMasterKey.shared = nil }
    LaunchKeychain.prepare(directory: folder.url.path, mockKeychain: true)
    let master = try #require(WebCryptoMasterKey.shared)
    let atLaunch = (try? String(contentsOf: folder.url.appendingPathComponent("Test App Keychain Log"), encoding: .utf8)) ?? ""
    let made = folder.names.filter { $0.hasSuffix("WebCrypto Master Key") && !$0.hasPrefix("Test") }
    LaunchKeychain.prepare(directory: folder.url.path, mockKeychain: true)
    #expect(WebCryptoMasterKey.shared === master)
    let key = await answer(master)
    switch mode {
    case "seam":
      #expect(atLaunch == "find safe-storage found\nfind webcrypto found\nresolved migrated\n")
      #expect(made == ["WebCrypto Master Key"])
      #expect(key == original)
    case "denied":
      #expect(atLaunch == "find safe-storage failed \(errSecAuthFailed)\n")
      #expect(made == [])
      #expect(key == Data())
    case "mock":
      #expect(atLaunch == "")
      #expect(made == ["Mock WebCrypto Master Key"])
      #expect(key.count == 16 && key != original)
    default:
      #expect(atLaunch == "")
      #expect(made == [])
      #expect(key == Data())
    }
  }

  @Test(arguments: ["fresh", "migration", "repair"])
  func `a key that cannot be saved is used only if WebKit already holds it`(path: String) async throws {
    let folder = try Folder()
    let file = folder.url.appendingPathComponent(String(repeating: "k", count: 220))
    let damaged = try sealed(fresh, Data("a lost secret".utf8))
    if path == "repair" { try damaged.write(to: file) }
    let outcomes = Outcomes()
    let made = fresh
    let master = WebCryptoMasterKey(keychain: FakeKeychain(secret: .found(secret), item: path == "fresh" ? .missing : stored), file: file, random: { made }) {
      outcomes.sources.append($0)
    }
    master.prepare()
    #expect(await answer(master) == (path == "fresh" ? Data() : original))
    #expect(outcomes.sources == [path == "fresh" ? .unavailable : .legacy])
    #expect(folder.names.count == (path == "repair" ? 1 : 0))
    if path == "repair" {
      #expect(try Data(contentsOf: folder.url.appendingPathComponent(#require(folder.names.first))) == damaged)
    }
  }

  @Test func `a damaged key file that cannot be moved aside stays where it is`() async throws {
    let folder = try Folder()
    let damaged = try sealed(fresh, Data("a lost secret".utf8))
    try damaged.write(to: folder.file)
    #expect(chmod(folder.url.path, 0o500) == 0)
    defer { _ = chmod(folder.url.path, 0o700) }
    let outcomes = Outcomes()
    #expect(await answer(launch(FakeKeychain(secret: .found(secret), item: stored), folder, outcomes)) == original)
    #expect(outcomes.sources == [.legacy])
    #expect(folder.contents == damaged)
    #expect(folder.names == ["WebCrypto Master Key"])
  }

  @Test func `the mock keychain never offers an old item`() {
    #expect(MockKeychain().safeStorageSecret() == .found(Data("mock_password".utf8)))
    #expect(MockKeychain().webCryptoItem() == .missing)
  }

  @Test func `the test seam reads its own files and records every read`() throws {
    let folder = try Folder()
    var keychain = FileKeychain(directory: folder.url)
    #expect(keychain.safeStorageSecret() == .missing)
    #expect(keychain.webCryptoItem() == .missing)
    try secret.write(to: folder.url.appendingPathComponent("Test Safe Storage Key"))
    try Data().write(to: folder.url.appendingPathComponent("Test WebCrypto Master Key"))
    #expect(keychain.safeStorageSecret() == .found(secret))
    #expect(keychain.webCryptoItem() == .failed(errSecDecode))
    keychain.failure = FileKeychain.failures["denied"]
    #expect(keychain.safeStorageSecret() == .failed(errSecAuthFailed))
    let log = try String(contentsOf: folder.url.appendingPathComponent("Test App Keychain Log"), encoding: .utf8)
    #expect(log.split(separator: "\n").map(String.init) == [
      "find safe-storage missing", "find webcrypto missing", "find safe-storage found", "find webcrypto failed \(errSecDecode)",
      "find safe-storage failed \(errSecAuthFailed)",
    ])
  }

  @Test func `a covered store keeps its hook alive and answers with the resolved key`() async throws {
    let folder = try Folder()
    let store = WKWebsiteDataStore.nonPersistent()
    WebCryptoMasterKey.shared = nil
    let unprepared = WebCryptoStoreKeys()
    #expect(unprepared.responds(to: NSSelectorFromString("webCryptoMasterKey:")))
    let closed: Data = await withCheckedContinuation { continuation in unprepared.webCryptoMasterKey { continuation.resume(returning: $0) } }
    #expect(closed == Data())
    WebCryptoMasterKey.shared = launch(FakeKeychain(secret: .found(secret), item: stored), folder)
    defer { WebCryptoMasterKey.shared = nil }
    autoreleasepool { WebCryptoStoreKeys.cover(store) }
    let held = try #require(store.perform(NSSelectorFromString("_delegate"))?.takeUnretainedValue() as? WebCryptoStoreKeys)
    #expect(held.responds(to: NSSelectorFromString("webCryptoMasterKey:")))
    let key: Data = await withCheckedContinuation { continuation in held.webCryptoMasterKey { continuation.resume(returning: $0) } }
    #expect(key == original)
  }
}
