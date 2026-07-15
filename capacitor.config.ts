import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  // Android uses this as the applicationId. The iOS bundle identifier is set
  // to com.lastglance in the Xcode project (ios/App/App.xcodeproj).
  appId: 'com.lastglance.app',
  appName: 'lastGLANCE',
  // Vite emits the production build here; `cap sync` copies it into the
  // native projects' web assets.
  webDir: 'dist',
  android: {
    // WebView remote debugging (chrome://inspect). OFF by default so shipped
    // builds are not inspectable — an inspectable production WebView would let
    // anyone with a USB cable read localStorage (sync credentials, passphrase
    // material). Enable ONLY for a throwaway internal test build via
    // `./build-android.sh --release --webview-debug` (sets CAP_WEBVIEW_DEBUG=1);
    // never promote such a build to production.
    webContentsDebuggingEnabled: process.env.CAP_WEBVIEW_DEBUG === '1',
  },
  plugins: {
    // Route fetch/XHR through the native HTTP stack so WebDAV/Nextcloud sync
    // works without a CORS proxy inside the native WebView.
    CapacitorHttp: {
      enabled: true,
    },
    // Initial status bar appearance (brand defaults to dark); the app then
    // keeps it in sync with the live theme via src/native/statusBar.ts.
    // overlaysWebView draws the app background behind a transparent bar
    // (required on Android 15 / targetSdk 36, which ignores a bar color).
    StatusBar: {
      style: 'DARK',
      overlaysWebView: true,
    },
    // Notification status-bar icon + accent. smallIcon points at the monochrome
    // contribution-grid drawable (res/drawable/ic_stat_notify); without it the
    // plugin falls back to a generic info glyph. iconColor tints the icon/accent
    // with the brand green.
    LocalNotifications: {
      smallIcon: 'ic_stat_notify',
      iconColor: '#22c55e',
    },
  },
}

export default config
