import AppKit
import ExpoModulesCore
import WebKit

public class WebKitModule: Module {
  public func definition() -> ModuleDefinition {
    Name(Self.calls.moduleName)
    Events(Self.calls.domain)
    Self.calls.forwardEvents(to: self)

    Self.calls.function

    PageViewDefinition.of(WebKitTabView.self)
  }
  static let calls = webKitCallTable(
    extensionInspect: { args, reply in
      WebKitExtensions.shared.inspect(path: try args.text("path")) { extensionReply($0, reply) }
    },
    extensionList: { args, reply in
      let profile = try extensionProfile(args)
      reply.ok(["available": WebKitExtensions.shared.available, "extensions": WebKitExtensions.shared.list(profile: profile)])
    },
    extensionLoad: { args, reply in
      WebKitExtensions.shared.load(profile: try extensionProfile(args), path: try args.text("path"), fingerprint: try args.text("fingerprint"), permissions: try args.strings("permissions"), origins: try args.strings("origins")) { extensionReply($0, reply) }
    },
    extensionGrant: { args, reply in
      WebKitExtensions.shared.grant(profile: try extensionProfile(args), id: try args.text("id"), permissions: try args.strings("permissions"), origins: try args.strings("origins")) { extensionReply($0, reply) }
    },
    extensionShow: { args, reply in
      WebKitExtensions.shared.show(profile: try extensionProfile(args), id: try args.text("id"), tabId: try args.text("tabId")) { extensionReply($0, reply) }
    },
    extensionUnload: { args, reply in
      WebKitExtensions.shared.unload(profile: try extensionProfile(args), id: try args.text("id")) { extensionReply($0, reply) }
    },
    removeDownloadStaging: { args, reply in
      reply.ok(WebKitDownloads.removeStaging(try args.text("path")))
    },
    endPrivateSession: { args, reply in
      WebKitHub.endPrivateSessionIfStarted(try args.text("session"))
      reply.ok()
    },
    cookieStoreKey: { args, reply in reply.ok(WebKitHub.shared.stores.id(of: args.profile).wireKey) },
    importCookies: { args, reply in
      let cookies = try args.dicts("cookies")
      WebKitHub.shared.importCookies(cookies, profile: args.profile, storeKey: try args.text("storeKey")) { reply.ok($0) }
    },
    exportCookies: { args, reply in
      let urls = try args.strings("urls").compactMap(URL.init(string:))
      let keys = args.values["keys"] == nil ? nil : Set(try args.strings("keys"))
      WebKitHub.shared.exportCookies(profile: args.profile, urls: urls, keys: keys) { reply.ok($0) }
    },
    writeCopiedAddress: { args, reply in
      let request = try args.int("request")
      let address = try args.text("url")
      DispatchQueue.main.async { reply.ok(WebKitCopiedAddresses.write(request, address)) }
    },
    setFraudWarnings: { args, reply in
      WebKitFraudWarnings.set(try args.bool("enabled"))
      reply.ok()
    },
    watchSiteData: { args, reply in
      WebKitSiteData.shared.setWatching(try args.bool("enabled"))
      reply.ok()
    },
    siteDataReady: { args, reply in
      WebKitSiteData.shared.release(try args.text("id"))
      reply.ok()
    },
    readSiteData: { args, reply in
      let origins = try args.strings("origins").compactMap(URL.init(string:)).filter { WebKitSiteData.origin(of: $0) != nil }
      WebKitSiteData.shared.read(profile: args.profile, domains: try args.strings("domains"), origins: Array(origins.prefix(16))) { reply.ok($0) }
    },
    writeSiteData: { args, reply in
      let storage = (try args.dict("storage")).compactMapValues { $0 as? [String: Any] }
      WebKitSiteData.shared.write(profile: args.profile, set: try args.dicts("set"), remove: try args.dicts("remove"), storage: storage) { reply.ok($0) }
    },
    setZoom: { args, reply in
      WebKitHub.shared.setZoom(try args.double("zoom"), profile: args.profile, host: try args.text("host").lowercased())
      reply.ok()
    },
    notificationAction: { args, reply in
      let action = try args.text("action")
      if WebKitHub.started, action == "click" || action == "close" { WebKitHub.shared.notifications.act(try args.text("id"), action: action) }
      reply.ok()
    },
    passkeyAccess: { _, reply in reply.ok(WebKitPasskeys.access()) },
    requestPasskeyAccess: { _, reply in WebKitPasskeys.requestAccess { reply.ok($0) } },
    devStoreExists: { args, reply in WebKitHub.shared.storeExists(args.profile) { reply.ok($0) } },
    devHoldStore: { args, reply in
      WebKitHub.shared.stores.holdForTest(args.profile)
      reply.ok()
    },
    devTouchStore: { args, reply in WebKitHub.shared.touchStore(args.profile) { reply.ok($0) } },
    devParkedTransfers: { _, reply in reply.ok(WebKitHub.shared.transfers.parkedKeys) },
    devContentBlocker: { _, reply in reply.ok(WebKitContentBlocker.shared.state) }
  ).dropping(LaunchConfig.shared.testInstance ? [] : testInstanceCalls)

  private static func extensionProfile(_ args: CallArgs) throws -> String {
    guard !WebKitStores.isPrivate(args.profile) else { throw BadCallArgs(message: "WebKit extensions are unavailable in private profiles") }
    return args.profile
  }

  private static func extensionReply(_ result: Result<[String: Any], Error>, _ reply: CallReply) {
    switch result {
    case .success(let value): reply.ok(value)
    case .failure(let error): reply.fail("ERR_WEBKIT_EXTENSION", error.localizedDescription)
    }
  }

  private static let testInstanceCalls: Set<String> = ["devStoreExists", "devHoldStore", "devTouchStore", "devParkedTransfers", "devContentBlocker"]
}
