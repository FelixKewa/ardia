#import "ArdiaChromeWindowHost.h"

#import <WebKit/WebKit.h>
#import <dlfcn.h>
#import <execinfo.h>

#import "ArdiaEvents.h"
#import "ArdiaRuntime.h"

namespace {

const void *ImageHolding(const void *address) {
  Dl_info info;
  return dladdr(address, &info) ? info.dli_fbase : nullptr;
}

bool AskedByWebKit() {
  static const void *webKit =
      ImageHolding(reinterpret_cast<const void *>(class_getMethodImplementation(WKWebView.class, @selector(loadRequest:))));
  static const void *ardia = ImageHolding(reinterpret_cast<const void *>(&ArdiaKeepTypingFromPage));
  void *frames[12];
  const int count = backtrace(frames, 12);
  for (int index = 0; index < count; index++) {
    const void *image = ImageHolding(frames[index]);
    if (image != ardia) return webKit && image == webKit;
  }
  return false;
}

NSView *FieldBeingTypedIn(NSWindow *window) {
  NSTextView *text = [window.firstResponder isKindOfClass:NSTextView.class] ? (NSTextView *)window.firstResponder : nil;
  if (!text.editable) return nil;
  id owner = text.fieldEditor ? text.delegate : nil;
  return [owner isKindOfClass:NSView.class] ? (NSView *)owner : text;
}

NSHashTable<NSResponder *> *GuardedPages() {
  static NSHashTable<NSResponder *> *pages = NSHashTable.weakObjectsHashTable;
  return pages;
}

void GuardWindows() {
  const SEL take = @selector(makeFirstResponder:);
  ardia_runtime::ReplaceMethod(NSWindow.class, take, ^id(IMP original) {
    __block __weak NSView *counted = nil;
    return ^BOOL(NSWindow *window, NSResponder *responder) {
      NSView *field = [GuardedPages() containsObject:responder] ? FieldBeingTypedIn(window) : nil;
      if (field && AskedByWebKit()) {
        if (counted != field) {
          counted = field;
          [ArdiaEvents emit:@"webKit.counted" data:[[ArdiaConsentStamp begin] onto:@{@"name" : @"typingKeptFromPage"}]];
        }
        return NO;
      }
      return reinterpret_cast<BOOL (*)(NSWindow *, SEL, NSResponder *)>(original)(window, take, responder);
    };
  });
}

}

void ArdiaKeepTypingFromPage(NSView *page) {
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    GuardWindows();
  });
  [GuardedPages() addObject:page];
}
