import UIKit
import Capacitor

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // RevenueCat, before the scene loads BridgeViewController and its web
        // view: BillingBridgePlugin reads the cached entitlement and prices
        // this starts fetching. The key is RevenueCat's public Apple SDK key.
        RevenueCatBilling.shared.configure(apiKey: "appl_xWQMlBxhFQklvPrhJlwwwSkuCWX")
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    // URL opens, home-screen shortcuts and user activities are delivered to
    // SceneDelegate (UIScene lifecycle, see UIApplicationSceneManifest in
    // Info.plist), which calls the handlers below.
    static func handleOpenURL(_ url: URL, options: UIScene.OpenURLOptions) {
        // lastglance:// is the app's own navigation scheme (widget body-taps,
        // home-screen shortcuts). Map it to the internal token the web router
        // consumes and stash it in the App Group — the same hand-off
        // MainActivity.captureWidgetDeepLink does on Android. The web app owns
        // navigation; this just records the target, which usePendingDeepLink
        // picks up on mount (cold start) or on the visibilitychange the
        // foregrounding causes (warm start).
        if url.scheme == "lastglance" {
            if let token = AppDelegate.deepLinkToken(from: url) {
                SharedDataStore.writePendingDeepLink(token)
            }
            return
        }
        // Anything else (OAuth callbacks etc.) keeps the Capacitor path.
        var appOptions: [UIApplication.OpenURLOptionsKey: Any] = [:]
        if let source = options.sourceApplication {
            appOptions[.sourceApplication] = source
        }
        if let annotation = options.annotation {
            appOptions[.annotation] = annotation
        }
        appOptions[.openInPlace] = options.openInPlace
        _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, open: url, options: appOptions)
    }

    // Home-screen quick actions (long-press the app icon). The item's `type` IS
    // the internal deep-link token — WidgetBridgePlugin builds the items that
    // way — so handling is a validity check and a store, nothing more.
    // SceneDelegate calls this for both warm taps and cold starts.
    static func handleShortcut(_ shortcutItem: UIApplicationShortcutItem) -> Bool {
        let token = shortcutItem.type
        let valid = token.hasPrefix("chore:")
            || token == "filter:soon" || token == "action:add" || token == "action:search"
        if valid {
            SharedDataStore.writePendingDeepLink(token)
        }
        return valid
    }

    // Activities the app was launched or resumed with, including Universal
    // Links. Keep the Capacitor call so the App API can track app url opens.
    static func handleUserActivity(_ userActivity: NSUserActivity) {
        _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, continue: userActivity, restorationHandler: { _ in })
    }

    // Map a lastglance:// URL to the internal pending-deep-link token the web
    // app consumes — the exact mirror of MainActivity.linkFromUri. Returns nil
    // for anything unrecognized rather than guessing.
    static func deepLinkToken(from url: URL) -> String? {
        switch url.host {
        case "chore":
            let id = url.lastPathComponent
            return (id.isEmpty || id == "/") ? nil : "chore:\(id)"
        case "filter":
            return "filter:soon"
        case "person":
            // People widgets: open a person, or quick-log for them.
            let id = url.lastPathComponent
            return (id.isEmpty || id == "/") ? nil : "person:\(id)"
        case "log":
            let id = url.lastPathComponent
            return (id.isEmpty || id == "/") ? nil : "log:\(id)"
        case "people":
            return "people"
        case "chores":
            return "chores"
        case "action":
            switch url.lastPathComponent {
            case "search": return "action:search"
            case "add": return "action:add"
            default: return nil
            }
        default:
            return nil
        }
    }

}
