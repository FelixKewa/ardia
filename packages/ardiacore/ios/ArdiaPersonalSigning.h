#import <Foundation/Foundation.h>
#import <Security/Security.h>

NS_ASSUME_NONNULL_BEGIN

typedef NS_ENUM(NSInteger, ArdiaPersonalLaunch) {
  ArdiaPersonalLaunchStandard,
  ArdiaPersonalLaunchVerified,
  ArdiaPersonalLaunchIsolated,
  ArdiaPersonalLaunchRefused,
  ArdiaPersonalLaunchMigrationPending,
};

ArdiaPersonalLaunch ArdiaPersonalLaunchFor(NSDictionary *info, NSString *bundleIdentifier, NSString *_Nullable dataDirectory,
                                          NSString *homeDirectory, NSString *legacyBundleIdentifier, BOOL (^verify)(NSString *pin));
BOOL ArdiaPersonalStaticCodeMatches(SecStaticCodeRef code, NSString *pin);
ArdiaPersonalLaunch ArdiaAuthorizePersonalLaunch(NSString *legacyBundleIdentifier);
ArdiaPersonalLaunch ArdiaCurrentPersonalLaunch(void);

NS_ASSUME_NONNULL_END
