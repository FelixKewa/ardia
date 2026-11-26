#import "../ios/ArdiaPersonalSigning.h"

#include <cstdio>
#include <sys/stat.h>

static int failures = 0;
#define CHECK(condition) do { if (!(condition)) { std::printf("FAIL %d: %s\n", __LINE__, #condition); failures++; } } while (0)

static NSString *Pin() { return [@"a" stringByPaddingToLength:64 withString:@"a" startingAtIndex:0]; }

static NSDictionary *Personal() { return @{@"ACPersonalBuild": @YES, @"ACPersonalSigningCertificateSHA256": Pin()}; }

static void Policy(NSString *home) {
  __block int checks = 0;
  BOOL (^valid)(NSString *) = ^BOOL(NSString *pin) { checks++; return [pin isEqualToString:Pin()]; };
  CHECK(ArdiaPersonalLaunchFor(@{}, @"dev.ardia", nil, home, @"fixture.legacy", valid) == ArdiaPersonalLaunchStandard);
  CHECK(ArdiaPersonalLaunchFor(@{}, @"dev.ardia", home, @"fixture.legacy", home, valid) == ArdiaPersonalLaunchStandard);
  CHECK(checks == 0);
  CHECK(ArdiaPersonalLaunchFor(Personal(), @"com.ardia.browser", nil, home, @"fixture.legacy", valid) == ArdiaPersonalLaunchVerified);
  CHECK(checks == 1);
  CHECK(ArdiaPersonalLaunchFor(Personal(), @"other.browser", nil, home, @"fixture.legacy", valid) == ArdiaPersonalLaunchRefused);
  CHECK(checks == 1);
  for (NSDictionary *info in @[
    @{@"ACPersonalBuild": @YES}, @{@"ACPersonalSigningCertificateSHA256": Pin()},
    @{@"ACPersonalBuild": @NO, @"ACPersonalSigningCertificateSHA256": Pin()},
    @{@"ACPersonalBuild": @"true", @"ACPersonalSigningCertificateSHA256": Pin()},
    @{@"ACPersonalBuild": @YES, @"ACPersonalSigningCertificateSHA256": @""},
    @{@"ACPersonalBuild": @YES, @"ACPersonalSigningCertificateSHA256": Pin().uppercaseString},
    @{@"ACPersonalBuild": @YES, @"ACPersonalSigningCertificateSHA256": @42},
  ]) CHECK(ArdiaPersonalLaunchFor(info, @"com.ardia.browser", nil, home, @"fixture.legacy", valid) == ArdiaPersonalLaunchRefused);
  CHECK(checks == 1);
  BOOL (^invalid)(NSString *) = ^BOOL(NSString *) { return NO; };
  CHECK(ArdiaPersonalLaunchFor(Personal(), @"com.ardia.browser", nil, home, @"fixture.legacy", invalid) == ArdiaPersonalLaunchRefused);
  NSString *scratch = [home stringByAppendingPathComponent:@"scratch/new"];
  CHECK(ArdiaPersonalLaunchFor(Personal(), @"com.ardia.browser", scratch, home, @"fixture.legacy", invalid) == ArdiaPersonalLaunchRefused);
  CHECK(ArdiaPersonalLaunchFor(Personal(), @"com.ardia.browser", scratch, home, @"fixture.legacy", valid) == ArdiaPersonalLaunchIsolated);
}

static void Scratch(NSString *home) {
  NSFileManager *files = NSFileManager.defaultManager;
  NSString *support = [home stringByAppendingPathComponent:@"Library/Application Support"];
  NSMutableArray<NSString *> *unsafe = [NSMutableArray arrayWithArray:@[ @"/", home, support ]];
  for (NSString *name in @[ @"com.ardia.browser", @"fixture.legacy", @"Ardia" ]) {
    NSString *live = [support stringByAppendingPathComponent:name];
    [files createDirectoryAtPath:[live stringByAppendingPathComponent:@"Chromium"] withIntermediateDirectories:YES attributes:nil error:nil];
    [unsafe addObjectsFromArray:@[ live, [live stringByAppendingPathComponent:@"new/child"], [live stringByAppendingPathComponent:@"Chromium/new"], live.uppercaseString ]];
    NSString *alias = [home stringByAppendingPathComponent:[@"alias-" stringByAppendingString:name]];
    [files createSymbolicLinkAtPath:alias withDestinationPath:live error:nil];
    [unsafe addObjectsFromArray:@[ alias, [alias stringByAppendingPathComponent:@"new/child"], [alias stringByAppendingPathComponent:@"missing/../new"] ]];
    NSString *engineAlias = [home stringByAppendingPathComponent:[@"engine-" stringByAppendingString:name]];
    [files createDirectoryAtPath:engineAlias withIntermediateDirectories:YES attributes:nil error:nil];
    [files createSymbolicLinkAtPath:[engineAlias stringByAppendingPathComponent:@"Chromium"] withDestinationPath:[live stringByAppendingPathComponent:@"Chromium"] error:nil];
    [unsafe addObject:engineAlias];
  }
  NSString *dangling = [home stringByAppendingPathComponent:@"dangling"];
  [files createSymbolicLinkAtPath:dangling withDestinationPath:[home stringByAppendingPathComponent:@"absent"] error:nil];
  [unsafe addObject:dangling];
  __block int checks = 0;
  for (NSString *path in unsafe) {
    CHECK(ArdiaPersonalLaunchFor(Personal(), @"com.ardia.browser", path, home, @"fixture.legacy", ^BOOL(NSString *) { checks++; return YES; }) == ArdiaPersonalLaunchRefused);
  }
  CHECK(checks == 0);
  NSString *safe = [home stringByAppendingPathComponent:@"fixture"];
  [files createDirectoryAtPath:safe withIntermediateDirectories:YES attributes:nil error:nil];
  NSString *alias = [home stringByAppendingPathComponent:@"safe-alias"];
  [files createSymbolicLinkAtPath:alias withDestinationPath:safe error:nil];
  for (NSString *path in @[ safe, alias, [alias stringByAppendingPathComponent:@"not-yet/child"], [safe stringByAppendingPathComponent:@"missing/../new"] ]) {
    CHECK(ArdiaPersonalLaunchFor(Personal(), @"com.ardia.browser", path, home, @"fixture.legacy", ^BOOL(NSString *) { return YES; }) == ArdiaPersonalLaunchIsolated);
  }
}

static void MigrationLock(NSString *home) {
  NSFileManager *files = NSFileManager.defaultManager;
  NSString *lock = [home stringByAppendingPathComponent:@"Library/Application Support/com.ardia.browser.preview-import.lock"];
  BOOL (^valid)(NSString *) = ^BOOL(NSString *) { return YES; };
  for (NSInteger kind = 0; kind < 3; kind++) {
    if (kind == 0) [files createFileAtPath:lock contents:[NSData data] attributes:nil];
    if (kind == 1) [files createDirectoryAtPath:lock withIntermediateDirectories:NO attributes:nil error:nil];
    if (kind == 2) [files createSymbolicLinkAtPath:lock withDestinationPath:[home stringByAppendingPathComponent:@"absent"] error:nil];
    CHECK(ArdiaPersonalLaunchFor(Personal(), @"com.ardia.browser", nil, home, @"fixture.legacy", valid) == ArdiaPersonalLaunchMigrationPending);
    CHECK(ArdiaPersonalLaunchFor(Personal(), @"com.ardia.browser", [home stringByAppendingPathComponent:@"fixture"], home, @"fixture.legacy", valid) == ArdiaPersonalLaunchIsolated);
    CHECK(ArdiaPersonalLaunchFor(@{}, @"com.ardia.browser", nil, home, @"fixture.legacy", valid) == ArdiaPersonalLaunchStandard);
    struct stat status;
    CHECK(lstat(lock.fileSystemRepresentation, &status) == 0);
    [files removeItemAtPath:lock error:nil];
  }
  CHECK(ArdiaPersonalLaunchFor(Personal(), @"com.ardia.browser", nil, home, @"fixture.legacy", valid) == ArdiaPersonalLaunchVerified);
}

int main(int argc, const char **argv) {
  @autoreleasepool {
    if (argc == 2 && strcmp(argv[1], "uninitialized") == 0) return (int)ArdiaCurrentPersonalLaunch();
    if (argc == 2 && strcmp(argv[1], "current") == 0) return (int)ArdiaAuthorizePersonalLaunch(@"fixture.legacy");
    if (argc == 4 && strcmp(argv[1], "verify") == 0) {
      SecStaticCodeRef code = nullptr;
      NSURL *url = [NSURL fileURLWithPath:[NSString stringWithUTF8String:argv[2]]];
      BOOL valid = SecStaticCodeCreateWithPath((__bridge CFURLRef)url, kSecCSDefaultFlags, &code) == errSecSuccess &&
          ArdiaPersonalStaticCodeMatches(code, [NSString stringWithUTF8String:argv[3]]);
      if (code) CFRelease(code);
      return valid ? 0 : 1;
    }
    char pattern[] = "/tmp/ardia-personal-policy-XXXXXX";
    NSString *home = [NSString stringWithUTF8String:mkdtemp(pattern)];
    Policy(home);
    Scratch(home);
    MigrationLock(home);
    [NSFileManager.defaultManager removeItemAtPath:home error:nil];
    std::printf("personal signing policy: %d failures\n", failures);
    return failures ? 1 : 0;
  }
}
