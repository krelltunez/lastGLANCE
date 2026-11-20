import Capacitor
import UIKit

/// App-local Capacitor plugins are not auto-discovered on iOS (unlike Android's
/// registerPlugin in MainActivity), so Main.storyboard instantiates this
/// subclass instead of CAPBridgeViewController and each plugin is registered
/// here, after the bridge exists but before the WebView loads the app.
class BridgeViewController: CAPBridgeViewController {

    override open func capacitorDidLoad() {
        paintLaunchBackground()
        bridge?.registerPluginInstance(VaultSsePlugin())
        bridge?.registerPluginInstance(WidgetBridgePlugin())
        bridge?.registerPluginInstance(SecureStorePlugin())
        bridge?.registerPluginInstance(DirectAccessPlugin())
        bridge?.registerPluginInstance(ContactsPlugin())
        bridge?.registerPluginInstance(ICloudPlugin())
        bridge?.registerPluginInstance(BillingBridgePlugin())
    }

    /// The web view IS this controller's view (Capacitor's loadView), and until
    /// the page paints its first frame the web view's own background is what
    /// shows. Capacitor makes that `systemBackground` when capacitor.config sets
    /// no colour: white in light mode, a white flash between the dark launch
    /// screen and the app. Paint it the launch screen's colour instead, so the
    /// launch screen simply continues until the page appears.
    ///
    /// LaunchBackground has a light and a dark appearance, matching the two
    /// Splash images, which a single capacitor.config colour cannot. Called from
    /// capacitorDidLoad: after the web view exists, before the page loads.
    private func paintLaunchBackground() {
        guard let launch = UIColor(named: "LaunchBackground") else { return }
        view.backgroundColor = launch
        webView?.isOpaque = false
        webView?.backgroundColor = launch
        webView?.scrollView.backgroundColor = launch
    }
}
