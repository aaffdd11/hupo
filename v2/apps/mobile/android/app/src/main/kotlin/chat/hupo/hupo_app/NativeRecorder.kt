package chat.hupo.hupo_app

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import android.media.MediaPlayer
import android.media.MediaRecorder
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.io.File

/**
 * **原生录音 ＋ 回放**（安卓那一份）。
 *
 * 契约：`docs/dev/129-NATIVE-ANDROID-BUILD.md` §十二（主人 2026-09-28：
 * *"你帮我测试录音能力。"* —— 而当时包里编进去的是**桩**，所以先把它做出来）。
 *
 * ── 与网页那一份（`recorder_web.dart`）对齐的四条 ──────────────
 *  ① 🔴 **一个字节都不往外发**：录到**应用缓存目录**里的一个文件，放的时候只在本机播。
 *  ② 🔴 **第一次按下去才问权限**（手册 D5.11）：不在启动时问，也不申请后台录音
 *     （`RECORD_BACKGROUND_AUDIO` **一个都不许有** —— 手册 V10）。
 *  ③ **一个原因一句话**：没权限 / 这台没有麦克风 / 开不起来 / 录下来是空的 ——
 *     各回各的机器原因（`denied` / `unsupported` / `failed`），界面翻成人话。
 *  ④ **一次只开一条**：新的开录之前先把上一条收干净；放音与录音不许叠在一起。
 *
 * ⚠️ 这份代码**只在真实设备/模拟器上跑得到**（`flutter test` 在 VM 上跑的是桩那一份）；
 *    判据在 `test/unit/recorder_native_test.dart`（把 MethodChannel 假掉，量"话是怎么说的"）
 *    ＋ `scripts/check-apk.sh`（从**包里**核权限）。
 */
class NativeRecorder(private val activity: Activity) : MethodChannel.MethodCallHandler {

    private var recorder: MediaRecorder? = null
    private var outFile: File? = null
    private var startedAt = 0L
    private var player: MediaPlayer? = null
    private var pendingResult: MethodChannel.Result? = null
    private var pendingPlayEnded: (() -> Unit)? = null

    /// **录的时候那条电平轴**（主人 2026-09-28："可以检测收到语音，并且给出一个
    /// 录音时候的那种时间轴语音bar吗？"）：每 ~100ms 取一次 `getMaxAmplitude()`
    /// 报给 Dart 那一侧（0..32767，它自己归一）。
    /// ⚠️ 它**只是应答**，不进录音数据；停录/走开都要把它停掉。
    private val handler = Handler(Looper.getMainLooper())
    private var meter: Runnable? = null

    /** 现在有没有一条在录。 */
    private val recording: Boolean get() = recorder != null

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            // 这台机器有没有麦克风（**不看权限**：没权限是另一档，界面要说不同的话）
            "canRecord" -> result.success(hasMicrophone())
            "start" -> start(result)
            "stop" -> stop(result)
            "play" -> play(call, result)
            "stopPlay" -> { stopPlay(); result.success(null) }
            "releaseAll" -> { releaseAll(); result.success(null) }
            else -> result.notImplemented()
        }
    }

    private fun hasMicrophone(): Boolean =
        activity.packageManager.hasSystemFeature(PackageManager.FEATURE_MICROPHONE)

    private fun hasPermission(): Boolean =
        ContextCompat.checkSelfPermission(activity, Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED

    /** 开录。失败**一定回一句机器原因**（绝不静默）。 */
    private fun start(result: MethodChannel.Result) {
        if (recording) {
            result.success("failed"); return
        }
        stopPlay()
        if (!hasMicrophone()) {
            result.success("unsupported"); return
        }
        if (!hasPermission()) {
            // 🔴 第一次按下去才问（D5.11）——问完再回话
            pendingResult = result
            ActivityCompat.requestPermissions(activity, arrayOf(Manifest.permission.RECORD_AUDIO), REQ_MIC)
            return
        }
        result.success(startNow())
    }

    /** 权限那一下回来了（由 MainActivity 转进来）。 */
    fun onPermissionResult(granted: Boolean) {
        val r = pendingResult ?: return
        pendingResult = null
        if (!granted) {
            r.success("denied"); return
        }
        r.success(startNow())
    }

    private fun startNow(): String? {
        val f = File(activity.cacheDir, "hupo-rec-${System.currentTimeMillis()}.m4a")
        return try {
            @Suppress("DEPRECATION")
            val rec = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) MediaRecorder(activity) else MediaRecorder()
            rec.setAudioSource(MediaRecorder.AudioSource.MIC)
            rec.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            rec.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            rec.setAudioChannels(1)
            rec.setOutputFile(f.absolutePath)
            rec.prepare()
            rec.start()
            recorder = rec
            outFile = f
            startedAt = System.currentTimeMillis()
            startMeter()
            null
        } catch (e: Exception) {
            closeRecorder()
            f.delete()
            "failed"
        }
    }

    /** 收手。**空的那一段**（文件没有/零字节/零毫秒）⇒ `ok=false`。 */
    private fun stop(result: MethodChannel.Result) {
        val rec = recorder
        if (rec == null) {
            result.success(mapOf("ok" to false)); return
        }
        val f = outFile
        val ms = (System.currentTimeMillis() - startedAt).toInt()
        val stopped = try {
            rec.stop(); true
        } catch (e: Exception) {
            false
        }
        closeRecorder()
        val size = f?.length() ?: 0L
        if (!stopped || f == null || size <= 0L || ms <= 0) {
            f?.delete()
            result.success(mapOf("ok" to false))
            return
        }
        result.success(mapOf("ok" to true, "path" to f.absolutePath, "ms" to ms, "bytes" to size))
    }

    /**
     * 放那一段。[onEnded] 走另一条回调（`onPlayEnded`），放完/出错都叫一声 ——
     * 界面那颗按钮要回到"听一遍"。
     */
    private fun play(call: MethodCall, result: MethodChannel.Result) {
        val path = call.argument<String>("path")
        pendingPlayEnded = { invokePlayEnded() }
        stopPlay()
        if (path.isNullOrBlank() || !File(path).exists()) {
            result.success(false); return
        }
        return try {
            val p = MediaPlayer()
            p.setDataSource(path)
            p.setOnCompletionListener { finishPlayback() }
            p.setOnErrorListener { _, _, _ -> finishPlayback(); true }
            p.prepare()
            p.start()
            player = p
            result.success(true)
        } catch (e: Exception) {
            player = null
            result.success(false)
        }
    }

    private fun finishPlayback() {
        val cb = pendingPlayEnded
        player?.release()
        player = null
        cb?.invoke()
    }

    private fun stopPlay() {
        val p = player ?: return
        player = null
        pendingPlayEnded = null
        try {
            p.stop()
        } catch (e: Exception) {
            // 已经没了
        }
        p.release()
    }

    /** 走开的时候：把麦关掉、把声音停掉、把临时文件删掉（不留孤儿）。 */
    fun releaseAll() {
        if (recording) {
            try {
                recorder?.stop()
            } catch (e: Exception) {
                // 已经没了
            }
        }
        outFile?.delete()
        closeRecorder()
        stopPlay()
        stopMeter()
    }

    /// 每 ~100ms 报一次当前峰值（那台一停就没人取了 ⇒ 必须自己停）。
    private fun startMeter() {
        stopMeter()
        val r = object : Runnable {
            override fun run() {
                val rec = recorder ?: return
                val amp = try {
                    rec.maxAmplitude
                } catch (e: Exception) {
                    return
                }
                meterChannel?.invokeMethod("onLevel", amp)
                handler.postDelayed(this, 100)
            }
        }
        meter = r
        handler.postDelayed(r, 100)
    }

    private fun stopMeter() {
        meter?.let { handler.removeCallbacks(it) }
        meter = null
    }

    private var meterChannel: MethodChannel? = null

    /// 电平往哪条 channel 报（与 `onPlayEnded` 同一条）。
    fun bindMeter(channel: MethodChannel) {
        meterChannel = channel
    }

    private fun closeRecorder() {
        stopMeter()
        try {
            recorder?.reset()
            recorder?.release()
        } catch (e: Exception) {
            // 已经没了
        }
        recorder = null
        outFile = null
    }

    private var playEndedChannel: MethodChannel? = null

    fun bindPlayEnded(channel: MethodChannel) {
        playEndedChannel = channel
    }

    private fun invokePlayEnded() {
        playEndedChannel?.invokeMethod("onPlayEnded", null)
    }

    companion object {
        const val REQ_MIC = 0x4D01
    }
}
