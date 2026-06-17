import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  // Android uses this as the applicationId. The iOS bundle identifier is set
  // to com.lastglance in the Xcode project (ios/App/App.xcodeproj).
  appId: 'com.lastglance.app',
  appName: 'lastGLANCE',
  // Vite emits the production build here; `cap sync` copies it into the
  // native projects' web assets.
  webDir: 'dist',
  plugins: {
    // Route fetch/XHR through the native HTTP stack so WebDAV/Nextcloud sync
    // works without a CORS proxy inside the native WebView.
    CapacitorHttp: {
      enabled: true,
    },
    // Initial status bar appearance (brand defaults to dark); the app then
    // keeps it in sync with the live theme via src/native/statusBar.ts.
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#020617',
    },
  },
}

export default config
