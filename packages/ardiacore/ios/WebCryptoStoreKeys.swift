import Foundation
import WebKit

public class WebCryptoStoreKeys: NSObject {
  private static var holding: UInt8 = 0
  private static let announced: Void = NSLog("[webcrypto] master key: requested by WebKit")

  public static func cover(_ store: WKWebsiteDataStore) {
    WebCryptoStoreKeys().attach(to: store)
  }

  @discardableResult
  func attach(to store: WKWebsiteDataStore) -> Bool {
    let setter = NSSelectorFromString("set_delegate:")
    guard store.responds(to: setter) else {
      NSLog("[webcrypto] this WebKit takes no data store delegate")
      return false
    }
    objc_setAssociatedObject(store, &Self.holding, self, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
    store.perform(setter, with: self)
    return true
  }

  public override func responds(to selector: Selector!) -> Bool {
    if selector == #selector(webCryptoMasterKey(_:)) {
      guard #available(macOS 15.0, *) else { return false }
      return true
    }
    return super.responds(to: selector)
  }

  @objc(webCryptoMasterKey:)
  func webCryptoMasterKey(_ completion: @escaping (Data) -> Void) {
    _ = Self.announced
    guard let master = WebCryptoMasterKey.shared else { return completion(Data()) }
    master.answer(completion)
  }
}
