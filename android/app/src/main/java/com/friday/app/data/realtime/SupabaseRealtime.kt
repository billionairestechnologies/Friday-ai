package com.friday.app.data.realtime

import android.util.Log
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject

/**
 * Hand-rolled Supabase Realtime client (Phoenix Channels protocol over a plain OkHttp
 * WebSocket). There is no official Kotlin SDK wired into this project and we're deliberately
 * not adding one — this reimplements just enough of the wire protocol to subscribe to Postgres
 * changes on `conversations` and `messages` (RLS already scopes every row to the signed-in
 * user, so the client only ever needs to open an authenticated socket).
 *
 * Mirrors the behavior of the web client at frontend/src/lib/chat/realtime.ts: it never tries to
 * reconstruct rows from the realtime payload, it just treats any change event as a "something
 * changed" signal, debounces ~400ms, and lets the caller refetch via the existing REST API.
 *
 * Usage from a ViewModel:
 *   SupabaseRealtime.connect(userId, accessToken, onConversationsChanged = { ... refetch ... },
 *       onMessagesChanged = { conversationId -> ... refetch that conversation (or all) ... })
 *   SupabaseRealtime.updateAuth(newAccessToken)   // whenever the token rotates
 *   SupabaseRealtime.disconnect()                 // onCleared() / logout
 */
object SupabaseRealtime {
    private const val TAG = "SupabaseRealtime"

    private const val REALTIME_HOST = "kqrokhxgsaufpgszuzkf.supabase.co"
    private const val REALTIME_URL = "wss://$REALTIME_HOST/realtime/v1/websocket"

    // Public anon/publishable key — safe to embed, every row it can see is still gated by RLS.
    private const val ANON_KEY =
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imtxcm9raHhnc2F1ZnBnc3p1emtmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkzNzIwNjgsImV4cCI6MjEwNDk0ODA2OH0.VGlwSRLI61QD7H9cEtZ4e_m8BUjzjuUsYvXNBqPUc_A"

    private const val HEARTBEAT_INTERVAL_MS = 25_000L
    private const val DEBOUNCE_MS = 400L
    private const val MAX_BACKOFF_MS = 30_000L
    private const val BASE_BACKOFF_MS = 1_000L

    private val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        // No read timeout — this is a long-lived socket. OkHttp's own ping frames are a
        // secondary keep-alive on top of the Phoenix-level heartbeat we send ourselves below.
        .readTimeout(0, TimeUnit.SECONDS)
        .pingInterval(20, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()

    // Background timers (heartbeat, reconnect backoff) — never touches UI.
    private val workScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    // Callback delivery — dispatched on Main so ViewModel state updates are safe.
    private val mainScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    private val refCounter = AtomicInteger(0)
    private fun nextRef(): String = refCounter.incrementAndGet().toString()

    private val lock = Any()

    private var webSocket: WebSocket? = null
    private var joinRef: String? = null
    private var topic: String? = null

    private var userId: String? = null
    private var accessToken: String? = null
    private var onConversationsChanged: (() -> Unit)? = null
    private var onMessagesChanged: ((String?) -> Unit)? = null

    private var heartbeatJob: Job? = null
    private var reconnectJob: Job? = null
    private var conversationsDebounceJob: Job? = null
    private val messagesDebounceJobs = HashMap<String, Job>()

    private var reconnectAttempt = 0
    @Volatile private var manuallyDisconnected = true

    /** Opens (or re-opens, if the user/token changed) the realtime socket and starts syncing. */
    fun connect(
        userId: String,
        accessToken: String,
        onConversationsChanged: () -> Unit,
        onMessagesChanged: (conversationId: String?) -> Unit,
    ) {
        synchronized(lock) {
            this.userId = userId
            this.accessToken = accessToken
            this.onConversationsChanged = onConversationsChanged
            this.onMessagesChanged = onMessagesChanged
            manuallyDisconnected = false
            reconnectAttempt = 0
            reconnectJob?.cancel()
            reconnectJob = null
            // Drop any existing socket (e.g. switching accounts) before reopening cleanly.
            closeSocketLocked("reconnecting")
        }
        openSocket()
    }

    /** Call whenever the access token rotates (ApiClient's Authenticator refreshes it on 401)
     *  so the realtime JWT backing the RLS check never goes stale mid-session. */
    fun updateAuth(accessToken: String) {
        synchronized(lock) {
            this.accessToken = accessToken
            val ws = webSocket
            val jr = joinRef
            val tp = topic
            if (ws != null && jr != null && tp != null) {
                send(ws, jr, nextRef(), tp, "access_token", JSONObject().put("access_token", accessToken))
            }
        }
    }

    /** Tears the socket down and stops all timers/debounces. Safe to call repeatedly. */
    fun disconnect() {
        synchronized(lock) {
            manuallyDisconnected = true
            reconnectJob?.cancel()
            reconnectJob = null
            conversationsDebounceJob?.cancel()
            conversationsDebounceJob = null
            messagesDebounceJobs.values.forEach { it.cancel() }
            messagesDebounceJobs.clear()
            closeSocketLocked("client disconnect")
            userId = null
            accessToken = null
            onConversationsChanged = null
            onMessagesChanged = null
        }
    }

    // Must be called while holding [lock].
    private fun closeSocketLocked(reason: String) {
        heartbeatJob?.cancel()
        heartbeatJob = null
        webSocket?.close(1000, reason)
        webSocket = null
        joinRef = null
        topic = null
    }

    private fun openSocket() {
        val token: String
        val uid: String
        synchronized(lock) {
            if (manuallyDisconnected) return
            if (webSocket != null) return
            token = accessToken ?: return
            uid = userId ?: return
        }
        val url = "$REALTIME_URL?apikey=$ANON_KEY&vsn=1.0.0&log_level=info"
        val request = Request.Builder().url(url).build()
        val ws = client.newWebSocket(request, Listener())
        synchronized(lock) { webSocket = ws }
        // Referenced so the compiler doesn't warn on unused locals when logging is stripped.
        Log.d(TAG, "connecting realtime socket for user=$uid")
    }

    private class Listener : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            synchronized(lock) {
                reconnectAttempt = 0
                val uid = userId ?: return
                val token = accessToken
                val newTopic = "realtime:chat-sync:$uid"
                topic = newTopic
                val ref = nextRef()
                joinRef = ref

                val postgresChanges = JSONArray().apply {
                    put(
                        JSONObject()
                            .put("event", "*")
                            .put("schema", "public")
                            .put("table", "conversations")
                            .put("filter", "user_id=eq.$uid"),
                    )
                    // DELETE events can't be filtered by column, so the filtered entry above never
                    // fires for a delete made on another device — this unfiltered one does.
                    put(
                        JSONObject()
                            .put("event", "DELETE")
                            .put("schema", "public")
                            .put("table", "conversations"),
                    )
                    put(
                        JSONObject()
                            .put("event", "*")
                            .put("schema", "public")
                            .put("table", "messages"),
                    )
                }
                val config = JSONObject().put("postgres_changes", postgresChanges)
                val joinPayload = JSONObject().put("config", config)
                if (token != null) joinPayload.put("access_token", token)

                // join_ref == ref on the join push itself (Phoenix convention); every later
                // push on this topic reuses joinRef but gets its own fresh ref.
                send(webSocket, ref, ref, newTopic, "phx_join", joinPayload)

                // Belt-and-suspenders: resend the token via the dedicated "access_token" event
                // too, in case the server's join-payload auth path differs by version.
                if (token != null) {
                    send(webSocket, ref, nextRef(), newTopic, "access_token", JSONObject().put("access_token", token))
                }

                startHeartbeatLocked()
            }
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            handleIncoming(text)
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(1000, null)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            onSocketDown()
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            Log.w(TAG, "realtime socket failure: ${t.message}")
            onSocketDown()
        }
    }

    private fun onSocketDown() {
        synchronized(lock) {
            heartbeatJob?.cancel()
            heartbeatJob = null
            webSocket = null
            joinRef = null
            topic = null
        }
        scheduleReconnect()
    }

    private fun startHeartbeatLocked() {
        heartbeatJob?.cancel()
        heartbeatJob = workScope.launch {
            while (true) {
                delay(HEARTBEAT_INTERVAL_MS)
                val ws = synchronized(lock) { webSocket }
                if (ws == null) break
                send(ws, null, nextRef(), "phoenix", "heartbeat", JSONObject())
            }
        }
    }

    private fun scheduleReconnect() {
        synchronized(lock) {
            if (manuallyDisconnected) return
            reconnectJob?.cancel()
            val attempt = reconnectAttempt
            reconnectAttempt = (reconnectAttempt + 1).coerceAtMost(10)
            val delayMs = (BASE_BACKOFF_MS * (1L shl attempt.coerceAtMost(5))).coerceAtMost(MAX_BACKOFF_MS)
            reconnectJob = workScope.launch {
                delay(delayMs)
                openSocket()
            }
        }
    }

    private fun send(
        ws: WebSocket,
        joinRefValue: String?,
        refValue: String,
        topicValue: String,
        eventValue: String,
        payloadValue: JSONObject,
    ) {
        val arr = JSONArray()
        if (joinRefValue != null) arr.put(joinRefValue) else arr.put(JSONObject.NULL)
        arr.put(refValue)
        arr.put(topicValue)
        arr.put(eventValue)
        arr.put(payloadValue)
        ws.send(arr.toString())
    }

    private fun handleIncoming(text: String) {
        try {
            val arr = JSONArray(text)
            if (arr.length() < 5) return
            val event = arr.optString(3, "")
            val payload = arr.optJSONObject(4) ?: JSONObject()
            when (event) {
                "postgres_changes" -> handlePostgresChange(payload)
                "phx_reply" -> {
                    val status = payload.optString("status", "")
                    if (status == "error") {
                        Log.w(TAG, "realtime channel join/push rejected: $payload")
                    }
                }
                "phx_error" -> {
                    Log.w(TAG, "realtime channel error, will rejoin on reconnect: $payload")
                }
                else -> { /* presence / broadcast / system events we don't care about */ }
            }
        } catch (e: Exception) {
            Log.w(TAG, "malformed realtime frame, ignoring: ${e.message}")
        }
    }

    private fun handlePostgresChange(payload: JSONObject) {
        // Be defensive: the exact envelope varies by Realtime server version. Try the common
        // "data" wrapper first, fall back to the payload itself.
        val data = payload.optJSONObject("data") ?: payload
        var table = data.optString("table", "")
        if (table.isEmpty()) table = payload.optString("table", "")

        if (table.isEmpty()) {
            // Unknown shape — degrade to "refetch everything" rather than silently drop it.
            notifyConversationsChanged()
            notifyMessagesChanged(null)
            return
        }

        when (table) {
            "conversations" -> notifyConversationsChanged()
            "messages" -> {
                val record = data.optJSONObject("record") ?: data.optJSONObject("old_record")
                val conversationId = record?.optString("conversation_id")?.takeIf { it.isNotBlank() }
                notifyMessagesChanged(conversationId)
            }
            else -> { /* neither table we subscribed to */ }
        }
    }

    private fun notifyConversationsChanged() {
        synchronized(lock) {
            conversationsDebounceJob?.cancel()
            conversationsDebounceJob = mainScope.launch {
                delay(DEBOUNCE_MS)
                onConversationsChanged?.invoke()
            }
        }
    }

    private fun notifyMessagesChanged(conversationId: String?) {
        val key = conversationId ?: "__unknown__"
        synchronized(lock) {
            messagesDebounceJobs[key]?.cancel()
            messagesDebounceJobs[key] = mainScope.launch {
                delay(DEBOUNCE_MS)
                synchronized(lock) { messagesDebounceJobs.remove(key) }
                onMessagesChanged?.invoke(conversationId)
            }
        }
    }
}
