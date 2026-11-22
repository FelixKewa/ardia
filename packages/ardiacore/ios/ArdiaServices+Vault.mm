#import "ArdiaServices.h"

#import "ArdiaInternal.h"

@implementation ArdiaServices (Vault)

+ (void)vaultSignIn:(NSString *)profile
                url:(NSString *)url
             origin:(NSString *)origin
           username:(NSString *)username
               code:(NSString *)code
         completion:(ArdiaCoreResult)completion {
  ardia_host::WithProfile(profile, ^(ArdiaCoreProfile *loaded) {
    if (!loaded || loaded.destroyed || loaded.offTheRecord) return completion(@{@"status" : @"failed", @"reason" : @"noProfile"});
    NSURL *page = [NSURL URLWithString:url];
    if (!page) return completion(@{@"status" : @"failed", @"reason" : @"badURL"});
    [loaded vaultSignInAtURL:page
                      origin:origin
                    username:username
                 oneTimeCode:code
                  completion:^(NSDictionary<NSString *, id> *result) {
                    if ([NSThread isMainThread]) return completion(result ?: @{});
                    dispatch_async(dispatch_get_main_queue(), ^{ completion(result ?: @{}); });
                  }];
  });
}

@end
