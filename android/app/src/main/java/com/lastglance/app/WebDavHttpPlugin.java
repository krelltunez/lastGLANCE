package com.lastglance.app;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.Iterator;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.ResponseBody;

/**
 * HTTP bridge for the WebDAV extension verbs (PROPFIND, MKCOL, ...) that
 * CapacitorHttp cannot send on Android: its HttpURLConnection backend passes
 * the verb straight to setRequestMethod(), which throws ProtocolException
 * ("Invalid HTTP method: PROPFIND") for anything outside the HTTP/1.1 core
 * set. OkHttp accepts arbitrary methods, so remote-backup listing, sync-folder
 * creation, and connection tests route through here (see src/sync/nativeHttp.ts)
 * while plain GET/PUT stay on CapacitorHttp.
 */
@CapacitorPlugin(name = "WebDavHttp")
public class WebDavHttpPlugin extends Plugin {
    private final ExecutorService executor = Executors.newCachedThreadPool();
    private final OkHttpClient client = new OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build();

    @PluginMethod
    public void request(PluginCall call) {
        String method = call.getString("method");
        String url = call.getString("url");
        if (method == null || url == null) {
            call.reject("method and url are required");
            return;
        }
        JSObject headers = call.getObject("headers", new JSObject());
        String body = call.getString("body");

        executor.execute(() -> {
            try {
                Request.Builder builder = new Request.Builder().url(url);
                String contentType = null;
                Iterator<String> keys = headers.keys();
                while (keys.hasNext()) {
                    String key = keys.next();
                    String value = headers.getString(key);
                    if (value == null) continue;
                    if ("content-type".equalsIgnoreCase(key)) contentType = value;
                    builder.header(key, value);
                }
                RequestBody requestBody = body != null
                    ? RequestBody.create(body, contentType != null ? MediaType.parse(contentType) : null)
                    : null;
                builder.method(method, requestBody);

                try (Response response = client.newCall(builder.build()).execute()) {
                    JSObject responseHeaders = new JSObject();
                    for (String name : response.headers().names()) {
                        responseHeaders.put(name.toLowerCase(), response.header(name));
                    }
                    ResponseBody responseBody = response.body();
                    JSObject result = new JSObject();
                    result.put("status", response.code());
                    result.put("body", responseBody != null ? responseBody.string() : "");
                    result.put("headers", responseHeaders);
                    call.resolve(result);
                }
            } catch (Exception e) {
                call.reject(e.getMessage() != null ? e.getMessage() : e.toString(), e);
            }
        });
    }

    @Override
    protected void handleOnDestroy() {
        executor.shutdown();
    }
}
