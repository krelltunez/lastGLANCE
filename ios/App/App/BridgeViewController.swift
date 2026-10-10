import Capacitor
import UIKit

/// App-local Capacitor plugins are not auto-discovered on iOS (unlike Android's
/// registerPlugin in MainActivity), so Main.storyboard instantiates this
/// subclass instead of CAPBridgeViewController and each plugin is registered
/// here, after the bridge exists but before the WebView loads the app.
class BridgeViewController: CAPBridgeViewController {

    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(VaultSsePlugin())
        bridge?.registerPluginInstance(WidgetBridgePlugin())
        bridge?.registerPluginInstance(SecureStorePlugin())
        bridge?.registerPluginInstance(DirectAccessPlugin())
    }
}
