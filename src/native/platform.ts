import { Capacitor } from '@capacitor/core'
import { isDesktop } from './desktop'

// Platform predicates for the native bridges.
//
// Deliberately separate from the `isAndroid()` in intentsBridge.ts: that one
// answers "can this device receive Tasker intents", which is Android-only by
// nature and will never grow an iOS branch. These answer "which native shell are
// we running inside", which most bridges care about now that iOS has one.

export function isAndroid(): boolean {
  return Capacitor.getPlatform() === 'android'
}

export function isIOS(): boolean {
  return Capacitor.getPlatform() === 'ios'
}

// True inside either native shell, false on web/PWA. This is the guard most
// bridges actually want: the question is almost always "is there a native plugin
// behind this call", not "which OS is it".
export function isNativeShell(): boolean {
  return isAndroid() || isIOS()
}

// Scheduled reminders that fire with the app closed or in the background: the
// phones' Local Notifications plugin, or the desktop app's scheduler in main
// (src/native/desktopNotifications.ts). The web and PWA keep the in-page path.
export function hasNativeReminders(): boolean {
  return isNativeShell() || isDesktop()
}
