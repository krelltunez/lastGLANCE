package com.lastglance.app.launcher

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.lastglance.app.MainActivity
import com.lastglance.app.SharedDataStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.coroutines.resume

/**
 * Closes the app's own page when it stopped answering the launcher in the
 * background, and hands the refresh to the headless path, as a swipe from
 * Recents does today (docs/launcher-integration.md, "Freshness").
 *
 * A backgrounded WebView can stop running timers and network replies for hours
 * while still running a script handed to it directly: a drain stuck that way
 * leaves every later REFRESH untaken. Closing it is safe only when it loses
 * nothing, so every step must hold or the page is left as it is:
 *  - the app has been in the background for [LauncherRefreshWait.RETIRE_MIN_BACKGROUND_MS],
 *    long after any write it started has landed;
 *  - the page answers the retire check `ok` (a script handed to it directly);
 *  - it is still in the background on the main thread, just before it closes.
 * The page is closed with finish(), so the next open starts it fresh from storage,
 * which the headless run keeps current.
 */
object LauncherPageRetire {
    private const val TAG = "LauncherRefresh"
    private const val CHECK_TIMEOUT_MS = 3_000L
    private const val CLOSE_TIMEOUT_MS = 5_000L

    /** After an unanswered hold for [clientId]. Never throws. */
    suspend fun closeIfUnresponsive(context: Context, clientId: String) {
        try {
            val activity = MainActivity.liveInstance() ?: return
            if (!LauncherRefreshWait.mayRetire(MainActivity.stoppedAt, System.currentTimeMillis())) return
            val check = withTimeoutOrNull(CHECK_TIMEOUT_MS) {
                suspendCancellableCoroutine<String?> { cont ->
                    Handler(Looper.getMainLooper()).post { activity.checkRetireReady { if (cont.isActive) cont.resume(it) } }
                }
            }
            if (!LauncherRefreshWait.pageReady(check)) {
                val why = if (check == null) "it did not answer the check" else "it was not ready to close"
                SharedDataStore.updateLauncherRefreshIf(context, clientId) { LauncherRefreshWait.keptPatch(it, why) }
                return
            }
            // Opened in the meantime: the page is live again, and its own cycle runs on start.
            val closing = withContext(Dispatchers.Main) {
                if (MainActivity.stoppedAt == 0L || activity.isFinishing) false else { activity.finish(); true }
            }
            if (!closing) return
            withTimeoutOrNull(CLOSE_TIMEOUT_MS) { while (LauncherBridgePlugin.rendererAlive) delay(100) }
            if (LauncherBridgePlugin.rendererAlive) {
                SharedDataStore.updateLauncherRefreshIf(context, clientId) { LauncherRefreshWait.keptPatch(it, "it did not close") }
                return
            }
            SharedDataStore.updateLauncherRefreshIf(context, clientId) { LauncherRefreshWait.retiredPatch(it) }
            val entry = LauncherRefreshWait.headlessEntry(clientId, System.currentTimeMillis())
            SharedDataStore.appendLauncherRefresh(context, entry)
            LauncherRefreshWorker.schedule(context, entry.getString("clientId"))
            Log.i(TAG, "refresh $clientId: closed the unresponsive page, headless run scheduled")
        } catch (e: Exception) {
            Log.w(TAG, "refresh $clientId: could not close the unresponsive page", e)
        } finally {
            context.contentResolver.notifyChange(LauncherProvider.CONTENT_URI, null)
        }
    }
}
