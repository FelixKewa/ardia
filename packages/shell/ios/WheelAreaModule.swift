import AppKit
import ExpoModulesCore

public class WheelAreaModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ArdiaWheelArea")

    AsyncFunction("devWheel") { (windowId: String, x: Double, y: Double, steps: [[String: Any]]) -> [String: Any] in
      #if DEBUG
      return WheelArea.devWheel(windowId: windowId, x: x, y: y, steps: steps)
      #else
      return ["error": "DEV builds only"]
      #endif
    }.runOnQueue(.main)

    AsyncFunction("glideScroll") { (tag: Int, y: Double, duration: Double) in
      guard let host = self.appContext?.findView(withTag: tag, ofType: NSView.self), let scroll = WheelArea.scrollView(in: host) else { return }
      WheelArea.glide(scroll, to: CGFloat(y), duration: duration)
    }.runOnQueue(.main)

    View(WheelArea.self) {
      Events("onWheel")
    }
  }
}
