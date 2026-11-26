import AppKit
import WebKit

@available(macOS 15.4, *)
extension WebKitExtensionHost: WKWebExtensionControllerDelegate, NSPopoverDelegate {
  func show(id: String, browserId: Int32, completion: @escaping WebKitExtensions.Reply) throws {
    guard let context = contexts[id], owns(context), let target = tabs[browserId], target.active,
      target.shouldGrantPermissionsOnUserGesture(for: context) else {
      throw WebKitExtensionPackage.failure("Select an approved WebKit page in this profile before opening the extension.")
    }
    closePopup()
    let token = UUID()
    popupToken = token
    popupReply = completion
    popupTab = target
    popupContext = context
    popupAction = context.action(for: target)
    if context.action(for: target)?.presentsPopup != true {
      context.performAction(for: target)
      popupReply = nil
      popupToken = nil
      popupTab = nil
      popupContext = nil
      popupAction = nil
      return completion(.success(["shown": false]))
    }
    context.performAction(for: target)
    DispatchQueue.main.asyncAfter(deadline: .now() + 15) { [weak self] in
      guard let self, self.popupToken == token, self.popupReply != nil else { return }
      self.closePopup(error: WebKitExtensionPackage.failure("The extension popup did not become ready."))
    }
  }

  func closePopup(error: Error = WebKitExtensionPackage.failure("The extension popup was closed.")) {
    let action = popup
    let pendingAction = popupAction
    let reply = popupReply
    popup = nil
    popupReply = nil
    popupToken = nil
    popupTab = nil
    popupContext = nil
    popupAction = nil
    action?.popupPopover?.delegate = nil
    action?.closePopup()
    if pendingAction !== action { pendingAction?.closePopup() }
    reply?(.failure(error))
  }

  func popoverDidClose(_ notification: Notification) { closePopup() }

  func webExtensionController(_ controller: WKWebExtensionController, openWindowsFor context: WKWebExtensionContext) -> [any WKWebExtensionWindow] {
    guard owns(context) else { return [] }
    let ordered = windows.values.filter { !$0.orderedTabs.isEmpty }.sorted {
      let first = (popupContext === context && $0 === popupTab?.hostWindow) || $0.native?.isKeyWindow == true
      let second = (popupContext === context && $1 === popupTab?.hostWindow) || $1.native?.isKeyWindow == true
      if first != second { return first }
      return ($0.native?.windowNumber ?? 0) < ($1.native?.windowNumber ?? 0)
    }
    return ordered
  }

  func webExtensionController(_ controller: WKWebExtensionController, focusedWindowFor context: WKWebExtensionContext) -> (any WKWebExtensionWindow)? {
    guard owns(context) else { return nil }
    if popupContext === context, let target = popupTab, target.active { return target.hostWindow }
    return NSApp.keyWindow.flatMap { windows[ObjectIdentifier($0)] }
  }

  func webExtensionController(_ controller: WKWebExtensionController, presentActionPopup action: WKWebExtension.Action,
                             for context: WKWebExtensionContext, completionHandler: @escaping (Error?) -> Void) {
    guard owns(context), popupContext === context, popupAction === action, let target = popupTab, target.active,
      target.shouldGrantPermissionsOnUserGesture(for: context), action.associatedTab as AnyObject? === target,
      popupReply != nil, let view = target.tab, let popover = action.popupPopover else {
      action.closePopup()
      return completionHandler(WebKitExtensionPackage.failure("Open this extension from its selected, approved WebKit tab."))
    }
    guard !LaunchConfig.shared.background else {
      action.closePopup()
      closePopup(error: WebKitExtensionPackage.failure("Extension popups are not presented by background test instances."))
      return completionHandler(WebKitExtensionPackage.failure("Background test instances do not present extension popups."))
    }
    popup = action
    popover.behavior = .transient
    popover.animates = false
    popover.delegate = self
    popover.show(relativeTo: NSRect(x: max(0, view.bounds.maxX - 44), y: 0, width: 32, height: 1), of: view, preferredEdge: .maxY)
    let reply = popupReply
    popupReply = nil
    completionHandler(nil)
    reply?(.success(["shown": true]))
  }

  func webExtensionController(_ controller: WKWebExtensionController, openNewTabUsing configuration: WKWebExtension.TabConfiguration,
                             for context: WKWebExtensionContext, completionHandler: @escaping ((any WKWebExtensionTab)?, Error?) -> Void) {
    guard owns(context), popupContext === context, let target = popupTab, target.active,
      target.shouldGrantPermissionsOnUserGesture(for: context), let opener = target.tab,
      let url = configuration.url, allowsNavigation(url, context: context),
      configuration.window == nil || configuration.window as AnyObject? === target.hostWindow,
      !configuration.shouldBePinned, !configuration.shouldBeMuted, !configuration.shouldReaderModeBeActive else {
      return completionHandler(nil, WebKitExtensionPackage.failure("Opening extension tabs requires its active popup and an approved HTTPS destination."))
    }
    let child = WebKitWebView(frame: .zero, configuration: WebKitHub.shared.configuration(profile: profile))
    let offer = WebKitHub.shared.transfers.offer(child)
    let key = ObjectIdentifier(child)
    pendingTabs[key] = WebKitExtensionPendingTab(context: context, offer: offer, view: child, completion: completionHandler)
    WebKitHeldPopup.hold(child, offer: offer, opener: opener)
    opener.emit("openWindow", ["url": url.absoluteString, "disposition": configuration.shouldBeActive ? "foreground" : "background", "adoptId": offer, "userGesture": true])
    child.load(URLRequest(url: url))
    DispatchQueue.main.asyncAfter(deadline: .now() + 10) { [weak self] in
      guard let self, let pending = self.pendingTabs.removeValue(forKey: key) else { return }
      if WebKitHub.shared.transfers.claimOffered(pending.offer) === child { WebKitHub.close(child) }
      pending.completion(nil, WebKitExtensionPackage.failure("The new WebKit tab was not adopted by this profile."))
    }
  }

  func webExtensionController(_ controller: WKWebExtensionController, promptForPermissions permissions: Set<WKWebExtension.Permission>,
                             in tab: (any WKWebExtensionTab)?, for context: WKWebExtensionContext,
                             completionHandler: @escaping (Set<WKWebExtension.Permission>, Date?) -> Void) {
    guard owns(context), permittedTab(tab, context: context) else { return completionHandler([], nil) }
    let approved = Set(effectiveRecords[context.uniqueIdentifier]?.permissions ?? [])
    completionHandler(Set(permissions.filter { approved.contains($0.rawValue) }), nil)
  }

  func webExtensionController(_ controller: WKWebExtensionController, promptForPermissionMatchPatterns patterns: Set<WKWebExtension.MatchPattern>,
                             in tab: (any WKWebExtensionTab)?, for context: WKWebExtensionContext,
                             completionHandler: @escaping (Set<WKWebExtension.MatchPattern>, Date?) -> Void) {
    guard owns(context), permittedTab(tab, context: context) else { return completionHandler([], nil) }
    guard let record = effectiveRecords[context.uniqueIdentifier] else { return completionHandler([], nil) }
    completionHandler(Set(patterns.filter {
      record.allWebsites == true ? WebKitExtensionPolicy.covers(record.origins, requested: $0) : record.origins.contains($0.string)
    }), nil)
  }

  func webExtensionController(_ controller: WKWebExtensionController, promptForPermissionToAccess urls: Set<URL>,
                             in tab: (any WKWebExtensionTab)?, for context: WKWebExtensionContext,
                             completionHandler: @escaping (Set<URL>, Date?) -> Void) {
    guard owns(context), permittedTab(tab, context: context) else { return completionHandler([], nil) }
    completionHandler(Set(urls.filter { allowsNavigation($0, context: context) }), nil)
  }

  private func permittedTab(_ tab: (any WKWebExtensionTab)?, context: WKWebExtensionContext) -> Bool {
    guard let tab else { return true }
    return (tab as? WebKitExtensionTabAdapter)?.accepts(context) == true
  }
}
