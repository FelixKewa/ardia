import AppKit
import WebKit

public enum ArdiaQuit {
  public static let changed = Notification.Name("ardia.quit.changed")
}

@available(macOS 15.4, *)
final class WebKitExtensionKeepAlive {
  static let interval: TimeInterval = 20
  private(set) var running: [String: (context: WKWebExtensionContext, timer: Timer)] = [:]
  var started: () -> Void = {}
  private var wanted: [WKWebExtensionContext] = []
  private var asleep = false
  private var quitting = false
  private var observers: [(NotificationCenter, NSObjectProtocol)] = []

  init() {
    let workspace = NSWorkspace.shared.notificationCenter
    observe(workspace, NSWorkspace.willSleepNotification) { keeper, _ in keeper.asleep = true }
    observe(workspace, NSWorkspace.didWakeNotification) { keeper, _ in keeper.asleep = false }
    observe(.default, NSApplication.willTerminateNotification) { keeper, _ in keeper.quitting = true }
    observe(.default, ArdiaQuit.changed) { keeper, note in keeper.quitting = note.object as? Bool ?? false }
  }

  deinit {
    running.values.forEach { $0.timer.invalidate() }
    observers.forEach { $0.0.removeObserver($0.1) }
  }

  func keep(_ contexts: [WKWebExtensionContext]) {
    wanted = contexts
    apply()
  }

  func stop(_ id: String) {
    wanted.removeAll { $0.uniqueIdentifier == id }
    running.removeValue(forKey: id)?.timer.invalidate()
  }

  func stopAll() {
    wanted = []
    apply()
  }

  private func observe(_ center: NotificationCenter, _ name: Notification.Name, _ change: @escaping (WebKitExtensionKeepAlive, Notification) -> Void) {
    observers.append((center, center.addObserver(forName: name, object: nil, queue: nil) { [weak self] note in
      guard let self else { return }
      change(self, note)
      self.apply()
    }))
  }

  private func apply() {
    let allowed = asleep || quitting ? [] : wanted
    for (id, entry) in running where !allowed.contains(where: { $0 === entry.context }) {
      entry.timer.invalidate()
      running.removeValue(forKey: id)
    }
    for context in allowed where running[context.uniqueIdentifier] == nil {
      let timer = Timer(timeInterval: Self.interval, repeats: true) { [weak context] _ in context?.loadBackgroundContent { _ in } }
      timer.tolerance = 2
      RunLoop.main.add(timer, forMode: .common)
      running[context.uniqueIdentifier] = (context, timer)
      context.loadBackgroundContent { _ in }
      started()
    }
  }
}
