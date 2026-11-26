import AppKit
import ArdiaCore
import ArdiaShell
import ArdiaSync

guard ArdiaHost.authorizePersonalLaunch(protectingLegacyBundle: LegacyName.bundleId) else {
  fputs("Ardia Personal refused to open: \(ArdiaHost.personalLaunchFailure ?? "Launch verification failed.")\n", stderr)
  exit(78)
}

ArdiaHost.markMainStarted()

let config = LaunchConfig.shared
if config.prewarm { exit(0) }
WebUIShellLaunch.routeIfRequested(config)

LegacyMigration.moveToNewName()

let scratch = config.dataDirectory.map {
  LegacyMigration.ScratchInstance(
    dataDirectory: $0, legacySource: config.testValue("legacySource"), crashAfter: config.testValue("legacyCrashAfter"))
}
if !LegacyMigration.runAtLaunch(scratch: scratch) { exit(0) }

exit(ArdiaHost.run(argc: CommandLine.argc, argv: CommandLine.unsafeArgv) { AppDelegate() })
