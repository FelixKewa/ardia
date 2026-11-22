#import "ArdiaServices.h"

#import "ArdiaInternal.h"
#import "ArdiaLaunchConfig.h"

@implementation ArdiaServices (Vault)

+ (dispatch_block_t)vaultSignIn:(NSString *)profile
                            url:(NSString *)url
                         origin:(NSString *)origin
                       username:(NSString *)username
                   codeProvider:(void (^)(void (^reply)(NSString *_Nullable code)))codeProvider
                     completion:(ArdiaCoreResult)completion {
  __block BOOL cancelled = NO;
  __block BOOL settled = NO;
  __block ArdiaCoreVaultSignIn *running = nil;
  void (^settle)(NSDictionary *) = ^(NSDictionary *result) {
    if (settled) return;
    settled = YES;
    running = nil;
    completion(cancelled ? @{@"status" : @"cancelled"} : (result ?: @{}));
  };
  ardia_host::WithProfile(profile, ^(ArdiaCoreProfile *loaded) {
    if (cancelled) return settle(nil);
    if (!loaded || loaded.destroyed || loaded.offTheRecord) return settle(@{@"status" : @"failed", @"reason" : @"noProfile"});
    NSURL *page = [NSURL URLWithString:url];
    if (!page) return settle(@{@"status" : @"failed", @"reason" : @"badURL"});
    if (NSString *fake = [ArdiaLaunchConfig.shared testValue:@"vaultFakeSignInMs"]) {
      dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(fake.doubleValue * NSEC_PER_MSEC)), dispatch_get_main_queue(), ^{
        settle(@{@"status" : @"signed_in", @"readyMs" : @(fake.doubleValue), @"fillMs" : @0, @"totalMs" : @(fake.doubleValue), @"fake" : @YES});
      });
      return;
    }
    void (^asked)(ArdiaCoreVaultCodeReply) = nil;
    if (codeProvider) asked = ^(ArdiaCoreVaultCodeReply reply) {
      if (cancelled) return reply(nil);
      codeProvider(reply);
    };
    running = [loaded vaultSignInAtURL:page
                                origin:origin
                              username:username
                          codeProvider:asked
                            completion:^(NSDictionary<NSString *, id> *result) {
                              if ([NSThread isMainThread]) return settle(result);
                              dispatch_async(dispatch_get_main_queue(), ^{ settle(result); });
                            }];
  });
  return ^{
    if (settled) return;
    cancelled = YES;
    [running cancel];
    settle(nil);
  };
}

@end
