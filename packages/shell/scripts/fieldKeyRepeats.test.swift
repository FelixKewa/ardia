import AppKit
import WebKit

final class TypingWindow: NSWindow {
  override var isKeyWindow: Bool { true }
  override var canBecomeKey: Bool { true }
}

final class RenderWidgetHostViewCocoa: NSView {
  var received: [String] = []
  override var acceptsFirstResponder: Bool { true }
  override func keyDown(with event: NSEvent) { received.append(event.isARepeat ? "repeat \(event.keyCode)" : "down \(event.keyCode)") }
  override func keyUp(with event: NSEvent) { received.append("up \(event.keyCode)") }
}

final class Loaded: NSObject, WKNavigationDelegate {
  var done = false
  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { done = true }
}

typealias KeyMonitor = @convention(block) (NSEvent) -> NSEvent?

@main
struct FieldKeyRepeatsTest {
  static var failures = 0
  static var monitors: [(mask: UInt64, handle: KeyMonitor)] = []

  static func captureMonitors() {
    let install = #selector(NSEvent.addLocalMonitorForEvents(matching:handler:))
    guard let method = class_getClassMethod(NSEvent.self, install) else { return }
    let capture: @convention(block) (AnyObject, UInt64, @escaping KeyMonitor) -> AnyObject = { _, mask, handle in
      monitors.append((mask, handle))
      return NSObject()
    }
    method_setImplementation(method, imp_implementationWithBlock(capture))
  }

  static func expect(_ passed: Bool, _ what: String) {
    if passed { return }
    failures += 1
    FileHandle.standardError.write(Data("failed: \(what)\n".utf8))
  }

  static func pause(_ seconds: Double = 0.3) { RunLoop.main.run(until: Date(timeIntervalSinceNow: seconds)) }

  static func main() {
    let app = NSApplication.shared
    app.setActivationPolicy(.prohibited)
    let window = TypingWindow(contentRect: NSRect(x: -4000, y: -4000, width: 800, height: 600), styleMask: [.titled], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    let page = WKWebView(frame: NSRect(x: 0, y: 0, width: 800, height: 400))
    let engine = RenderWidgetHostViewCocoa(frame: NSRect(x: 0, y: 400, width: 800, height: 40))
    let bar = NSTextField(frame: NSRect(x: 10, y: 560, width: 400, height: 24))
    let find = NSTextField(frame: NSRect(x: 10, y: 530, width: 400, height: 24))
    for view in [page, engine, bar, find] { window.contentView?.addSubview(view) }
    let loaded = Loaded()
    page.navigationDelegate = loaded
    page.loadHTMLString("<!doctype html><p>page</p><script>window.seen = []; addEventListener('keydown', (e) => seen.push((e.repeat ? 'repeat ' : 'down ') + e.key), true); addEventListener('keyup', (e) => seen.push('up ' + e.key), true);</script>", baseURL: URL(string: "http://127.0.0.1/"))
    for _ in 0..<500 where !loaded.done { pause(0.02) }
    expect(loaded.done, "the page loads")

    captureMonitors()
    var kept = 0
    FieldKeyRepeats.shared.install { kept += 1 }
    FieldKeyRepeats.shared.install { kept += 1 }
    let keys = NSEvent.EventTypeMask([.keyDown, .keyUp]).rawValue
    expect(monitors.map(\.mask) == [keys], "one monitor watches key presses and releases")
    let monitor = monitors.first?.handle

    func send(_ type: NSEvent.EventType, _ key: UInt16, _ characters: String, repeated: Bool = false, modifiers: NSEvent.ModifierFlags = []) {
      let event = NSEvent.keyEvent(with: type, location: .zero, modifierFlags: modifiers, timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, characters: characters, charactersIgnoringModifiers: characters, isARepeat: repeated, keyCode: key)!
      if let monitor, let passed = monitor(event) { window.sendEvent(passed) }
      if monitor == nil { window.sendEvent(event) }
    }
    func backspace(_ type: NSEvent.EventType = .keyDown, repeated: Bool = false, modifiers: NSEvent.ModifierFlags = []) { send(type, 51, "\u{7f}", repeated: repeated, modifiers: modifiers) }
    func escape(_ type: NSEvent.EventType = .keyDown, repeated: Bool = false) { send(type, 53, "\u{1b}", repeated: repeated) }
    func pageSaw() -> [String] {
      pause()
      var answer: [String]?
      page.evaluateJavaScript("seen.splice(0)") { value, _ in answer = value as? [String] ?? [] }
      for _ in 0..<500 where answer == nil { pause(0.02) }
      return answer ?? ["no answer"]
    }
    func editorText() -> String { (window.firstResponder as? NSTextView)?.string ?? "" }
    func type(into field: NSTextField, _ text: String) {
      window.makeFirstResponder(field)
      (window.firstResponder as? NSTextView)?.insertText(text, replacementRange: NSRange(location: NSNotFound, length: 0))
    }

    type(into: bar, "held")
    backspace()
    for _ in 0..<6 { backspace(repeated: true) }
    expect(editorText() == "", "held Backspace empties the field it was pressed in")
    expect(window.firstResponder is NSTextView, "the field keeps the keyboard while the key is held")

    window.makeFirstResponder(page)
    for _ in 0..<5 { backspace(repeated: true) }
    backspace(.keyUp)
    expect(pageSaw() == [], "repeats and the release of a key pressed in a field never reach a WebKit page")
    expect(kept == 1, "counted once for the held key")

    backspace()
    backspace(repeated: true)
    backspace(.keyUp)
    expect(pageSaw() == ["down Backspace", "repeat Backspace", "up Backspace"], "a fresh press on the page works as before")

    type(into: bar, "held")
    escape()
    window.makeFirstResponder(engine)
    for _ in 0..<3 { escape(repeated: true) }
    escape(.keyUp)
    expect(engine.received == [], "a Chromium page gets none of them either")
    expect(kept == 2, "counted again for the next held key")

    type(into: bar, "held")
    backspace()
    window.makeFirstResponder(nil)
    window.makeFirstResponder(page)
    backspace(repeated: true)
    backspace(.keyUp)
    expect(pageSaw() == [], "the page stays clear after the field is gone")

    window.makeFirstResponder(page)
    escape()
    type(into: bar, "held")
    window.makeFirstResponder(page)
    escape(repeated: true)
    escape(.keyUp)
    window.makeFirstResponder(page)
    backspace()
    type(into: bar, "held")
    window.makeFirstResponder(page)
    backspace(repeated: true)
    backspace(.keyUp)
    expect(pageSaw() == ["down Escape", "repeat Escape", "up Escape", "down Backspace", "repeat Backspace", "up Backspace"], "a key first pressed on the page keeps going there")

    type(into: bar, "held")
    backspace()
    type(into: find, "more")
    backspace(repeated: true)
    expect(editorText() == "mor", "a held key keeps working when another field takes over")
    backspace(.keyUp)

    engine.received = []
    type(into: bar, "held")
    send(.keyDown, 36, "\r", modifiers: .command)
    window.makeFirstResponder(engine)
    send(.keyDown, 36, "\r", repeated: true, modifiers: .command)
    send(.keyUp, 36, "\r", modifiers: .command)
    expect(engine.received == [], "a shortcut pressed in a field doesn't repeat into the page")

    type(into: bar, "held")
    backspace(modifiers: .control)
    window.makeFirstResponder(engine)
    backspace(repeated: true, modifiers: .control)
    backspace(.keyUp, modifiers: .control)
    expect(engine.received == [], "nor does an editing key held with Control")

    type(into: bar, "held")
    send(.keyDown, 48, "\t", modifiers: .control)
    window.makeFirstResponder(engine)
    send(.keyDown, 48, "\t", repeated: true, modifiers: .control)
    expect(engine.received == ["repeat 48"], "holding Control-Tab keeps stepping through the tab switcher")

    engine.received = []
    type(into: bar, "held")
    escape()
    escape(.keyUp)
    window.makeFirstResponder(engine)
    escape(repeated: true)
    escape(.keyUp)
    expect(engine.received == [], "repeats replayed after the release was seen stay off the page")
    expect(kept == 6, "each kept press is counted once")

    window.close()
    exit(failures == 0 ? 0 : 1)
  }
}
