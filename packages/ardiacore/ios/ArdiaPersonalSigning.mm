#import "ArdiaPersonalSigning.h"
#import "ArdiaLaunchConfig.h"

#import <CommonCrypto/CommonDigest.h>
#import <limits.h>
#import <sys/stat.h>

#include <atomic>

namespace {

std::atomic<int> gPersonalLaunch{-1};

BOOL ValidPin(NSString *pin) {
  return [pin isKindOfClass:NSString.class] && pin.length == 64 &&
      [pin rangeOfCharacterFromSet:[NSCharacterSet characterSetWithCharactersInString:@"0123456789abcdef"].invertedSet].location == NSNotFound;
}

NSString *Hex(const unsigned char *bytes, NSUInteger count) {
  NSMutableString *text = [NSMutableString stringWithCapacity:count * 2];
  for (NSUInteger index = 0; index < count; index++) [text appendFormat:@"%02x", bytes[index]];
  return text;
}

NSString *CanonicalPath(NSString *path) {
  if (!path.absolutePath) path = [NSFileManager.defaultManager.currentDirectoryPath stringByAppendingPathComponent:path];
  NSString *resolved = @"/";
  for (NSString *component in path.pathComponents) {
    if (!component.length || [component isEqualToString:@"/"] || [component isEqualToString:@"."]) continue;
    if ([component isEqualToString:@".."]) {
      resolved = resolved.stringByDeletingLastPathComponent;
      continue;
    }
    NSString *next = [resolved stringByAppendingPathComponent:component];
    char canonical[PATH_MAX];
    if (realpath(next.fileSystemRepresentation, canonical)) {
      resolved = [NSString stringWithUTF8String:canonical];
      continue;
    }
    if (errno != ENOENT) return nil;
    struct stat status;
    if (lstat(next.fileSystemRepresentation, &status) == 0 || errno != ENOENT) return nil;
    resolved = next;
  }
  return resolved;
}

BOOL Within(NSString *path, NSString *root) {
  NSString *lowerPath = path.lowercaseString;
  NSString *lowerRoot = root.lowercaseString;
  if ([lowerPath isEqualToString:lowerRoot] || [lowerRoot isEqualToString:@"/"] ||
      [lowerPath hasPrefix:[lowerRoot stringByAppendingString:@"/"]]) return YES;
  struct stat rootStatus;
  if (stat(root.fileSystemRepresentation, &rootStatus) != 0) return NO;
  for (NSString *ancestor = path; ancestor.length > 1; ancestor = ancestor.stringByDeletingLastPathComponent) {
    struct stat status;
    if (stat(ancestor.fileSystemRepresentation, &status) == 0 && status.st_dev == rootStatus.st_dev && status.st_ino == rootStatus.st_ino) return YES;
  }
  return NO;
}

BOOL SafeScratch(NSString *path, NSString *home, NSString *legacyBundleIdentifier) {
  NSString *scratch = CanonicalPath(path);
  NSString *engine = CanonicalPath([path stringByAppendingPathComponent:@"Chromium"]);
  if (!scratch || !engine) return NO;
  NSString *support = [home stringByAppendingPathComponent:@"Library/Application Support"];
  for (NSString *name in @[ @"com.ardia.browser", legacyBundleIdentifier, @"Ardia" ]) {
    NSString *live = CanonicalPath([support stringByAppendingPathComponent:name]);
    if (!live || Within(scratch, live) || Within(live, scratch) || Within(engine, live) || Within(live, engine)) return NO;
  }
  return YES;
}

SecRequirementRef PinnedRequirement(SecStaticCodeRef code, NSString *pin) {
  if (!ValidPin(pin)) return nullptr;
  CFDictionaryRef raw = nullptr;
  if (SecCodeCopySigningInformation(code, kSecCSSigningInformation, &raw) != errSecSuccess || !raw) return nullptr;
  NSDictionary *info = CFBridgingRelease(raw);
  if (![info[(__bridge NSString *)kSecCodeInfoIdentifier] isEqual:@"com.ardia.browser"]) return nullptr;
  NSNumber *flags = info[(__bridge NSString *)kSecCodeInfoFlags];
  if (!flags || (flags.unsignedIntValue & kSecCodeSignatureAdhoc)) return nullptr;
  NSArray *certificates = info[(__bridge NSString *)kSecCodeInfoCertificates];
  if (![certificates isKindOfClass:NSArray.class] || !certificates.count) return nullptr;
  SecCertificateRef certificate = (__bridge SecCertificateRef)certificates.firstObject;
  if (CFGetTypeID(certificate) != SecCertificateGetTypeID()) return nullptr;
  NSData *der = CFBridgingRelease(SecCertificateCopyData(certificate));
  if (!der.length || der.length > UINT_MAX) return nullptr;
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(der.bytes, (CC_LONG)der.length, digest);
  if (![Hex(digest, sizeof(digest)) isEqualToString:pin]) return nullptr;
  unsigned char requirementDigest[CC_SHA1_DIGEST_LENGTH];
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
  CC_SHA1(der.bytes, (CC_LONG)der.length, requirementDigest);
#pragma clang diagnostic pop
  NSString *text = [NSString stringWithFormat:@"identifier \"com.ardia.browser\" and certificate leaf = H\"%@\"", Hex(requirementDigest, sizeof(requirementDigest))];
  SecRequirementRef requirement = nullptr;
  if (SecRequirementCreateWithString((__bridge CFStringRef)text, kSecCSDefaultFlags, &requirement) != errSecSuccess) return nullptr;
  return requirement;
}

BOOL ValidRunningCode(NSString *pin) {
  SecCodeRef running = nullptr;
  if (SecCodeCopySelf(kSecCSDefaultFlags, &running) != errSecSuccess) return NO;
  SecStaticCodeRef code = nullptr;
  BOOL valid = NO;
  if (SecCodeCopyStaticCode(running, kSecCSDefaultFlags, &code) == errSecSuccess) {
    SecRequirementRef requirement = PinnedRequirement(code, pin);
    if (requirement) {
      valid = ArdiaPersonalStaticCodeMatches(code, pin) && SecCodeCheckValidity(running, kSecCSDefaultFlags, requirement) == errSecSuccess;
      CFRelease(requirement);
    }
    CFRelease(code);
  }
  CFRelease(running);
  return valid;
}

}

ArdiaPersonalLaunch ArdiaPersonalLaunchFor(NSDictionary *info, NSString *bundleIdentifier, NSString *dataDirectory,
                                          NSString *homeDirectory, NSString *legacyBundleIdentifier, BOOL (^verify)(NSString *pin)) {
  if (!info[@"ACPersonalBuild"] && !info[@"ACPersonalSigningCertificateSHA256"]) return ArdiaPersonalLaunchStandard;
  id marker = info[@"ACPersonalBuild"];
  NSString *pin = info[@"ACPersonalSigningCertificateSHA256"];
  if (![marker isKindOfClass:NSNumber.class] || ![marker isEqual:@YES] || ![bundleIdentifier isEqualToString:@"com.ardia.browser"] || !ValidPin(pin))
    return ArdiaPersonalLaunchRefused;
  if (!legacyBundleIdentifier.length || [legacyBundleIdentifier containsString:@"/"]) return ArdiaPersonalLaunchRefused;
  if (dataDirectory && !SafeScratch(dataDirectory, homeDirectory, legacyBundleIdentifier)) return ArdiaPersonalLaunchRefused;
  if (!verify(pin)) return ArdiaPersonalLaunchRefused;
  if (!dataDirectory) {
    NSString *lock = [homeDirectory stringByAppendingPathComponent:@"Library/Application Support/com.ardia.browser.preview-import.lock"];
    struct stat status;
    if (lstat(lock.fileSystemRepresentation, &status) == 0 || errno != ENOENT) return ArdiaPersonalLaunchMigrationPending;
  }
  return dataDirectory ? ArdiaPersonalLaunchIsolated : ArdiaPersonalLaunchVerified;
}

BOOL ArdiaPersonalStaticCodeMatches(SecStaticCodeRef code, NSString *pin) {
  SecRequirementRef requirement = PinnedRequirement(code, pin);
  if (!requirement) return NO;
  const SecCSFlags flags = kSecCSStrictValidate | kSecCSCheckAllArchitectures | kSecCSCheckNestedCode;
  BOOL valid = SecStaticCodeCheckValidity(code, flags, requirement) == errSecSuccess;
  CFRelease(requirement);
  SecRequirementRef designated = nullptr;
  if (!valid || SecCodeCopyDesignatedRequirement(code, kSecCSDefaultFlags, &designated) != errSecSuccess) return NO;
  valid = SecStaticCodeCheckValidity(code, flags, designated) == errSecSuccess;
  CFRelease(designated);
  return valid;
}

ArdiaPersonalLaunch ArdiaAuthorizePersonalLaunch(NSString *legacyBundleIdentifier) {
  static ArdiaPersonalLaunch decision;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    decision = ArdiaPersonalLaunchFor(NSBundle.mainBundle.infoDictionary ?: @{}, NSBundle.mainBundle.bundleIdentifier ?: @"",
                                     ArdiaLaunchConfig.shared.dataDirectory, NSHomeDirectory(), legacyBundleIdentifier, ^BOOL(NSString *pin) { return ValidRunningCode(pin); });
    gPersonalLaunch.store((int)decision);
  });
  return decision;
}

ArdiaPersonalLaunch ArdiaCurrentPersonalLaunch(void) {
  const int decision = gPersonalLaunch.load();
  if (decision >= 0) return (ArdiaPersonalLaunch)decision;
  NSDictionary *info = NSBundle.mainBundle.infoDictionary;
  return info[@"ACPersonalBuild"] || info[@"ACPersonalSigningCertificateSHA256"] ? ArdiaPersonalLaunchRefused : ArdiaPersonalLaunchStandard;
}
