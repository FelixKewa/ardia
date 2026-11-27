import AppKit
import Carbon.HIToolbox
import WebKit

final class FieldKeyRepeats {
  static let shared = FieldKeyRepeats()
  private var typedInField = Set<UInt16>()
  private var keptFromPage = Set<UInt16>()
  private var monitor: Any?
  private var kept: () -> Void = {}

  func install(kept: @escaping () -> Void) {
    self.kept = kept
    guard monitor == nil else { return }
    monitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .keyUp]) { [weak self] event in
      self?.keepsFromPage(event) == true ? nil : event
    }
  }

  private func keepsFromPage(_ event: NSEvent) -> Bool {
    let key = event.keyCode
    if event.type == .keyUp {
      return keptFromPage.remove(key) != nil && Self.leadsToPage(event.window)
    }
    guard event.isARepeat else {
      keptFromPage.remove(key)
      if !Self.stepsThroughTabs(event), Self.isTextField(event.window?.firstResponder) {
        typedInField.insert(key)
      } else {
        typedInField.remove(key)
      }
      return false
    }
    guard typedInField.contains(key), Self.leadsToPage(event.window) else { return false }
    if keptFromPage.insert(key).inserted { kept() }
    return true
  }

  private static func stepsThroughTabs(_ event: NSEvent) -> Bool {
    event.keyCode == UInt16(kVK_Tab) && event.modifierFlags.contains(.control)
  }

  private static func isTextField(_ responder: NSResponder?) -> Bool {
    (responder as? NSTextView)?.isEditable == true
  }

  private static func leadsToPage(_ window: NSWindow?) -> Bool {
    guard let window, let responder = window.firstResponder, responder !== window else { return true }
    return responder is WKWebView || String(describing: type(of: responder)) == "RenderWidgetHostViewCocoa"
  }
}
