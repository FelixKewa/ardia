import AppKit
import WebKit

@available(macOS 15.4, *)
final class WebKitExtensionTabAdapter: NSObject, WKWebExtensionTab {
  weak var host: WebKitExtensionHost?
  weak var tab: WebKitTab?
  weak var view: WKWebView?
  weak var hostWindow: WebKitExtensionWindowAdapter?
  var reportedURL: String?

  init(host: WebKitExtensionHost, tab: WebKitTab, window: WebKitExtensionWindowAdapter) {
    self.host = host
    self.tab = tab
    view = tab.webView
    reportedURL = tab.webView?.url?.absoluteString
    hostWindow = window
  }

  var live: Bool {
    guard let host, host.valid, let tab, !tab.closed, tab.profile == host.profile, let view, view === tab.webView,
      view.configuration.websiteDataStore === host.store, view.configuration.webExtensionController === host.controller,
      let window = hostWindow?.native, window === tab.window else { return false }
    return host.tabs[tab.browserId] === self
  }

  var active: Bool { live && tab?.visible == true && tab?.selected == true && tab?.isHiddenOrHasHiddenAncestor == false }

  func accepts(_ context: WKWebExtensionContext) -> Bool { live && host?.owns(context) == true }

  func webView(for context: WKWebExtensionContext) -> WKWebView? { accepts(context) ? view : nil }
  func window(for context: WKWebExtensionContext) -> (any WKWebExtensionWindow)? { accepts(context) ? hostWindow : nil }
  func url(for context: WKWebExtensionContext) -> URL? { accepts(context) ? view?.backForwardList.currentItem?.url : nil }
  func title(for context: WKWebExtensionContext) -> String? { accepts(context) ? view?.title : nil }
  func isLoadingComplete(for context: WKWebExtensionContext) -> Bool { accepts(context) && view?.isLoading == false }
  func isSelected(for context: WKWebExtensionContext) -> Bool { accepts(context) && active }
  func size(for context: WKWebExtensionContext) -> CGSize { accepts(context) ? view?.bounds.size ?? .zero : .zero }
  func indexInWindow(for context: WKWebExtensionContext) -> Int { hostWindow?.orderedTabs.firstIndex(where: { $0 === self }) ?? 0 }
  func shouldBypassPermissions(for context: WKWebExtensionContext) -> Bool { false }
  func shouldGrantPermissionsOnUserGesture(for context: WKWebExtensionContext) -> Bool {
    guard accepts(context), active, let url = view?.backForwardList.currentItem?.url, url == view?.url,
      let origins = host?.records[context.uniqueIdentifier]?.origins else { return false }
    return WebKitExtensionPackage.allows(url, origins: origins, allowLoopback: LaunchConfig.shared.testInstance)
  }

}

@available(macOS 15.4, *)
final class WebKitExtensionWindowAdapter: NSObject, WKWebExtensionWindow {
  weak var host: WebKitExtensionHost?
  weak var native: NSWindow?
  weak var lastActive: WebKitExtensionTabAdapter?

  init(host: WebKitExtensionHost, window: NSWindow) {
    self.host = host
    native = window
  }

  var orderedTabs: [WebKitExtensionTabAdapter] {
    guard let host else { return [] }
    return host.tabs.values.filter { $0.hostWindow === self && $0.live }.sorted { ($0.tab?.browserId ?? 0) > ($1.tab?.browserId ?? 0) }
  }

  func activeTab(for context: WKWebExtensionContext) -> (any WKWebExtensionTab)? {
    guard host?.owns(context) == true else { return nil }
    if host?.popupContext === context, let target = host?.popupTab, target.hostWindow === self, target.active { return target }
    let open = orderedTabs
    return open.first(where: \.active) ?? open.first { $0 === lastActive } ?? open.first
  }

  func tabs(for context: WKWebExtensionContext) -> [any WKWebExtensionTab] { host?.owns(context) == true ? orderedTabs : [] }
  func isPrivate(for context: WKWebExtensionContext) -> Bool { false }
  func windowType(for context: WKWebExtensionContext) -> WKWebExtension.WindowType { .normal }
}

@available(macOS 15.4, *)
final class WebKitExtensionPendingTab {
  let context: WKWebExtensionContext
  let offer: String
  let view: WKWebView
  let completion: ((any WKWebExtensionTab)?, Error?) -> Void

  init(context: WKWebExtensionContext, offer: String, view: WKWebView, completion: @escaping ((any WKWebExtensionTab)?, Error?) -> Void) {
    self.context = context
    self.offer = offer
    self.view = view
    self.completion = completion
  }
}

@available(macOS 15.4, *)
extension WebKitExtensionHost {
  func attach(_ tab: WebKitTab) {
    guard valid, !tab.closed, tab.profile == profile, let view = tab.webView, let window = tab.window,
      view.configuration.websiteDataStore === store, view.configuration.webExtensionController === controller else { return }
    if let existing = tabs[tab.browserId], existing.view === view, existing.hostWindow?.native === window { return }
    detach(tab)
    let key = ObjectIdentifier(window)
    let windowAdapter: WebKitExtensionWindowAdapter
    if let existing = windows[key] { windowAdapter = existing } else {
      windowAdapter = WebKitExtensionWindowAdapter(host: self, window: window)
      windows[key] = windowAdapter
      controller.didOpenWindow(windowAdapter)
    }
    let adapter = WebKitExtensionTabAdapter(host: self, tab: tab, window: windowAdapter)
    tabs[tab.browserId] = adapter
    controller.didOpenTab(adapter)
    if adapter.active { reportActive(adapter) }
    if focusObservers.isEmpty {
      for name in [NSWindow.didBecomeKeyNotification, NSWindow.didResignKeyNotification] {
        focusObservers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in self?.focusChanged() })
      }
    }
    if let pending = pendingTabs.removeValue(forKey: ObjectIdentifier(view)) {
      if owns(pending.context) { pending.completion(adapter, nil) }
      else { pending.completion(nil, WebKitExtensionPackage.failure("The extension closed before its new tab was ready.")) }
    }
    scheduleKeepAliveRefresh()
  }

  func changed(_ tab: WebKitTab) {
    if tab.closed || tab.window == nil || tab.webView == nil { return detach(tab) }
    attach(tab)
    scheduleKeepAliveRefresh()
    guard let adapter = tabs[tab.browserId], adapter.live else { return }
    if adapter.reportedURL != adapter.view?.url?.absoluteString, popupTab === adapter { closePopup() }
    adapter.reportedURL = adapter.view?.url?.absoluteString
    controller.didChangeTabProperties([.URL, .title, .loading], for: adapter)
    if adapter.active {
      reportActive(adapter)
      controller.didSelectTabs([adapter])
    } else {
      controller.didDeselectTabs([adapter])
      if popupTab === adapter { closePopup() }
    }
  }

  private func reportActive(_ adapter: WebKitExtensionTabAdapter) {
    adapter.hostWindow?.lastActive = adapter
    controller.didActivateTab(adapter, previousActiveTab: nil)
  }

  func detach(_ tab: WebKitTab) {
    guard let adapter = tabs[tab.browserId] else { return }
    if popupTab === adapter { closePopup() }
    for context in contexts.values { context.clearUserGesture(in: adapter) }
    controller.didCloseTab(adapter, windowIsClosing: false)
    tabs.removeValue(forKey: tab.browserId)
    scheduleKeepAliveRefresh()
    if let oldWindow = adapter.hostWindow, !tabs.values.contains(where: { $0.hostWindow === oldWindow }) {
      controller.didCloseWindow(oldWindow)
      if let native = oldWindow.native { windows.removeValue(forKey: ObjectIdentifier(native)) }
    }
  }

  func closed(_ view: WKWebView) {
    for adapter in Array(tabs.values) where adapter.view === view { if let tab = adapter.tab { detach(tab) } }
    if let pending = pendingTabs.removeValue(forKey: ObjectIdentifier(view)) {
      pending.completion(nil, WebKitExtensionPackage.failure("The new tab was closed before it was ready."))
    }
  }

  func focusChanged() {
    guard valid else { return }
    let activeWindow = NSApp.keyWindow.flatMap { windows[ObjectIdentifier($0)] }
    controller.didFocusWindow(activeWindow)
    if let popupTab, !popupTab.active { closePopup() }
  }

  func cancelPendingTabs(contextId: String?) {
    for (key, pending) in Array(pendingTabs) where contextId == nil || pending.context.uniqueIdentifier == contextId {
      pendingTabs.removeValue(forKey: key)
      if WebKitHub.shared.transfers.claimOffered(pending.offer) === pending.view { WebKitHub.close(pending.view) }
      pending.completion(nil, WebKitExtensionPackage.failure("The extension closed before its new tab was ready."))
    }
  }

  func reloadPages(running id: String, origins: [String]) -> Int {
    guard let context = contexts[id] else { return 0 }
    let stale = tabs.values.filter { runsContentScripts(context, in: $0, origins: origins) }.compactMap(\.tab)
    stale.forEach { $0.reload() }
    return stale.count
  }

  func runsContentScripts(_ context: WKWebExtensionContext, in adapter: WebKitExtensionTabAdapter, origins: [String]) -> Bool {
    guard adapter.live, let url = adapter.view?.url, context.hasInjectedContent(for: url) else { return false }
    return WebKitExtensionPackage.allows(url, origins: origins, allowLoopback: LaunchConfig.shared.testInstance)
  }

  func scheduleKeepAliveRefresh() {
    guard !keepAliveRefreshScheduled else { return }
    keepAliveRefreshScheduled = true
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.keepAliveRefreshScheduled = false
      self.keepAlive.keep(self.valid ? self.contexts.values.filter { self.needsBackgroundAwake($0) } : [])
    }
  }

  private func needsBackgroundAwake(_ context: WKWebExtensionContext) -> Bool {
    let resource = context.webExtension
    guard resource.hasBackgroundContent, !resource.hasPersistentBackgroundContent else { return false }
    let origins = records[context.uniqueIdentifier]?.origins ?? []
    return tabs.values.contains { runsContentScripts(context, in: $0, origins: origins) }
  }

  func allowsNavigation(_ url: URL, context: WKWebExtensionContext) -> Bool {
    owns(context) && WebKitExtensionPackage.allows(url, origins: records[context.uniqueIdentifier]?.origins ?? [], allowLoopback: LaunchConfig.shared.testInstance)
  }
}
