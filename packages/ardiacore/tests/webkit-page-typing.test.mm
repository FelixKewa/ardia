#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>
#import <objc/runtime.h>

#import "ArdiaChromeWindowHost.h"
#import "ArdiaEvents.h"

static NSMutableArray<NSString *> *gCounted;

NSNotificationName const ArdiaConsentEpochDidChangeNotification = @"ArdiaConsentEpochDidChange";

@implementation ArdiaEvents
+ (void)setSender:(void (^)(NSString *, NSDictionary<NSString *, id> *))sender forDomain:(NSString *)domain {
}
+ (BOOL)listens:(NSString *)domain {
  return YES;
}
+ (void)emit:(NSString *)name data:(NSDictionary<NSString *, id> *)data {
  [gCounted addObject:[NSString stringWithFormat:@"%@ %@", name, data[@"name"]]];
}
+ (NSString *)consentEpoch {
  return @"";
}
+ (void)setConsentEpoch:(NSString *)epoch {
}
@end

@implementation ArdiaConsentStamp {
  NSString *_epoch;
}
+ (instancetype)begin {
  return [[self alloc] initWithEpoch:@""];
}
- (instancetype)initWithEpoch:(NSString *)epoch {
  if ((self = [super init])) _epoch = [epoch copy];
  return self;
}
- (NSString *)epoch {
  return _epoch;
}
- (NSDictionary<NSString *, id> *)onto:(NSDictionary<NSString *, id> *)payload {
  return payload;
}
@end

@interface TypingWindow : NSWindow
@end
@implementation TypingWindow
- (BOOL)isKeyWindow {
  return YES;
}
- (BOOL)canBecomeKey {
  return YES;
}
@end

@interface Loaded : NSObject <WKNavigationDelegate>
@property(nonatomic) BOOL done;
@end
@implementation Loaded
- (void)webView:(WKWebView *)webView didFinishNavigation:(WKNavigation *)navigation {
  self.done = YES;
}
@end

static int gFailures = 0;

static void Expect(BOOL passed, NSString *what) {
  if (passed) return;
  gFailures++;
  fprintf(stderr, "failed: %s\n", what.UTF8String);
}

static void Pause(NSTimeInterval seconds) {
  [NSRunLoop.mainRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:seconds]];
}

static NSString *Run(WKWebView *page, NSString *code) {
  __block NSString *answer = nil;
  [page evaluateJavaScript:[NSString stringWithFormat:@"String(%@)", code]
         completionHandler:^(id value, NSError *error) {
           answer = error ? error.localizedDescription : (value ?: @"");
         }];
  for (int turn = 0; !answer && turn < 500; turn++) Pause(0.02);
  return answer ?: @"no answer";
}

static void PageFocuses(WKWebView *page, NSString *element) {
  Run(page, [NSString stringWithFormat:@"(document.getElementById('%@').focus(), 0)", element]);
  Pause(0.5);
}

static NSTextView *Editor(NSWindow *window) {
  return [window.firstResponder isKindOfClass:NSTextView.class] ? (NSTextView *)window.firstResponder : nil;
}

int main() {
  @autoreleasepool {
    gCounted = [NSMutableArray array];
    [NSApplication.sharedApplication setActivationPolicy:NSApplicationActivationPolicyProhibited];
    TypingWindow *window = [[TypingWindow alloc] initWithContentRect:NSMakeRect(-4000, -4000, 800, 600)
                                                           styleMask:NSWindowStyleMaskTitled
                                                             backing:NSBackingStoreBuffered
                                                               defer:NO];
    window.releasedWhenClosed = NO;
    WKWebView *page = [[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 800, 440)];
    NSTextField *bar = [[NSTextField alloc] initWithFrame:NSMakeRect(10, 560, 400, 24)];
    NSTextField *find = [[NSTextField alloc] initWithFrame:NSMakeRect(10, 530, 400, 24)];
    NSTextView *notes = [[NSTextView alloc] initWithFrame:NSMakeRect(10, 480, 400, 40)];
    NSTextView *label = [[NSTextView alloc] initWithFrame:NSMakeRect(10, 450, 400, 24)];
    label.editable = NO;
    label.selectable = YES;
    for (NSView *view in @[ page, bar, find, notes, label ]) [window.contentView addSubview:view];
    Loaded *loaded = [Loaded new];
    page.navigationDelegate = loaded;
    ArdiaKeepTypingFromPage(page);
    ArdiaKeepTypingFromPage(page);
    [page loadHTMLString:@"<!doctype html><div id=player tabindex=0>player</div><div id=video tabindex=0>video</div>"
                 baseURL:[NSURL URLWithString:@"http://127.0.0.1/"]];
    for (int turn = 0; !loaded.done && turn < 500; turn++) Pause(0.02);
    Expect(loaded.done, @"the page loads");

    Expect([window makeFirstResponder:page], @"the browser can give the page the keyboard");
    PageFocuses(page, @"player");

    [window makeFirstResponder:bar];
    [Editor(window) insertText:@"typed" replacementRange:NSMakeRange(NSNotFound, 0)];
    PageFocuses(page, @"video");
    Expect(Editor(window).delegate == (id)bar, @"a page script can't take the keyboard from a field being typed in");
    Expect([Editor(window).string isEqualToString:@"typed"], @"the typed text stays");
    Expect([Run(page, @"document.hasFocus()") isEqualToString:@"false"], @"the page knows it doesn't have the keyboard");
    PageFocuses(page, @"player");
    Expect(Editor(window).delegate == (id)bar, @"a second try is refused too");
    Expect([gCounted isEqualToArray:@[ @"webKit.counted typingKeptFromPage" ]], @"counted once for the field");

    Expect([window makeFirstResponder:page], @"the browser can still move the keyboard from a field to the page");
    Expect(window.firstResponder == page, @"the page has the keyboard once the browser gave it");

    [window makeFirstResponder:find];
    PageFocuses(page, @"video");
    Expect(Editor(window).delegate == (id)find, @"every browser field is kept");
    Expect(gCounted.count == 2, @"counted again for another field");

    [window makeFirstResponder:notes];
    PageFocuses(page, @"player");
    Expect(window.firstResponder == notes, @"a multiline browser field is kept");

    const SEL take = @selector(makeFirstResponder:);
    Method method = class_getInstanceMethod(NSWindow.class, take);
    const IMP inner = method_getImplementation(method);
    method_setImplementation(method, imp_implementationWithBlock(^BOOL(NSWindow *wrapped, NSResponder *responder) {
      return reinterpret_cast<BOOL (*)(NSWindow *, SEL, NSResponder *)>(inner)(wrapped, take, responder);
    }));
    [window makeFirstResponder:bar];
    PageFocuses(page, @"video");
    Expect(Editor(window).delegate == (id)bar, @"a field is kept when something else wraps the same window method");

    [window makeFirstResponder:page];
    PageFocuses(page, @"video");
    [window makeFirstResponder:label];
    PageFocuses(page, @"player");
    Expect(window.firstResponder == page, @"selected read-only text doesn't hold the keyboard");

    WKWebView *inspector = [[WKWebView alloc] initWithFrame:NSMakeRect(420, 440, 360, 140)];
    Loaded *inspectorLoaded = [Loaded new];
    inspector.navigationDelegate = inspectorLoaded;
    [window.contentView addSubview:inspector];
    [inspector loadHTMLString:@"<!doctype html><div id=console tabindex=0>console</div>" baseURL:nil];
    for (int turn = 0; !inspectorLoaded.done && turn < 500; turn++) Pause(0.02);
    [window makeFirstResponder:bar];
    PageFocuses(inspector, @"console");
    Expect(window.firstResponder == inspector, @"a web view that isn't a page, such as Web Inspector, can still take the keyboard");

    [window makeFirstResponder:nil];
    PageFocuses(page, @"video");
    Expect(window.firstResponder == page, @"a page takes the keyboard when nobody is typing in the browser");

    [window close];
  }
  return gFailures ? 1 : 0;
}
