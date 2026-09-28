package chat.hupo.hupo_app

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Handler
import android.os.Looper
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import kotlin.math.max

/**
 * **原生开麦**（说给它听 · 安卓那一份）。
 *
 * 契约：`docs/dev/129-NATIVE-ANDROID-BUILD.md` §十四（主人 2026-09-28：
 * *"是的，安卓也要支持转文字。开工吧。"*）。
 *
 * 它只做一件事：**把麦克风变成 16k 单声道 PCM16 的块**，交给 Dart 那一侧
 * （`services/hearing_native.dart`）送进我们自己的 `/api/asr`。
 * 识别本身在腾讯云那一边做 —— 这只管"采"。
 *
 * ── 四条与网页那一份（`hearing_web.dart`）对齐 ────────────────
 *  ① 🔴 **第一次按下去才问权限**（D5.11）；`RECORD_AUDIO` 早就在清单里了。
 *  ② **一个原因一句话**：没权限 / 这台没有麦克风 / 开不起来 —— `denied` /
 *     `unsupported` / `failed`，界面翻成人话（与录音那几句共用）。
 *  ③ **一次只开一条**：开之前先把手里的收干净。
 *  ④ **一个字节都不落盘**：PCM 只在内存里过一趟（与「录一段」那块刻意不同）。
 *
 * ⚠️ 帧要**回主线程**再 `invokeMethod`（Flutter 的平台通道只许在平台线程上叫）。
 */
class NativeMic(private val activity: Activity) : MethodChannel.MethodCallHandler {

    private var rec: AudioRecord? = null
    private var thread: Thread? = null
    private var pending: MethodChannel.Result? = null
    private var channel: MethodChannel? = null
    private val main = Handler(Looper.getMainLooper())

    fun bind(ch: MethodChannel) {
        channel = ch
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "canHear" -> result.success(hasMicrophone())
            "start" -> start(result)
            "stop" -> {
                stopCapture()
                result.success(null)
            }
            else -> result.notImplemented()
        }
    }

    private fun hasMicrophone(): Boolean =
        activity.packageManager.hasSystemFeature(PackageManager.FEATURE_MICROPHONE)

    private fun hasPermission(): Boolean =
        ContextCompat.checkSelfPermission(activity, Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED

    private fun start(result: MethodChannel.Result) {
        if (rec != null) {
            result.success("failed"); return
        }
        if (!hasMicrophone()) {
            result.success("unsupported"); return
        }
        if (!hasPermission()) {
            // 🔴 第一次按下去才问（D5.11）——问完再回话
            pending = result
            ActivityCompat.requestPermissions(activity, arrayOf(Manifest.permission.RECORD_AUDIO), REQ_MIC)
            return
        }
        result.success(startNow())
    }

    /** 权限那一下回来了（由 MainActivity 转进来）。 */
    fun onPermissionResult(granted: Boolean) {
        val r = pending ?: return
        pending = null
        if (!granted) {
            r.success("denied"); return
        }
        r.success(startNow())
    }

    /**
     * 真开起来。**16k / 单声道 / PCM16** —— 与网页那一份送给上游的格式**逐字节一致**
     * （服务端按这个格式往腾讯云转，改这里就得改那边）。
     */
    private fun startNow(): String? {
        return try {
            val minBuf = AudioRecord.getMinBufferSize(SAMPLE_RATE, CHANNEL, ENCODING)
            val bufBytes = max(minBuf, CHUNK_BYTES * 4)
            val r = try {
                // 识别用的音源（关掉一部分为通话做的处理）；不行就退回普通麦克风
                AudioRecord(
                    MediaRecorder.AudioSource.VOICE_RECOGNITION,
                    SAMPLE_RATE, CHANNEL, ENCODING, bufBytes,
                )
            } catch (e: Exception) {
                AudioRecord(
                    MediaRecorder.AudioSource.MIC,
                    SAMPLE_RATE, CHANNEL, ENCODING, bufBytes,
                )
            }
            if (r.state != AudioRecord.STATE_INITIALIZED) {
                r.release()
                return "failed"
            }
            r.startRecording()
            rec = r
            val t = Thread {
                val buf = ByteArray(CHUNK_BYTES)
                while (true) {
                    val cur = rec ?: break
                    val n = try {
                        cur.read(buf, 0, buf.size)
                    } catch (e: Exception) {
                        break
                    }
                    if (n <= 0) continue
                    val chunk = if (n == buf.size) buf.copyOf() else buf.copyOf(n)
                    // ⚠️ 回主线程再叫平台通道（通道只许在平台线程上用）
                    main.post { channel?.invokeMethod("onAudio", chunk) }
                }
            }
            t.isDaemon = true
            thread = t
            t.start()
            null
        } catch (e: Exception) {
            stopCapture()
            "failed"
        }
    }

    /** 停采集（幂等）。 */
    private fun stopCapture() {
        val r = rec
        rec = null
        if (r != null) {
            try {
                r.stop()
            } catch (e: Exception) {
                // 已经没了
            }
            r.release()
        }
        thread = null
    }

    companion object {
        const val REQ_MIC = 0x4D02

        /** 上游要的就是这个：16k、单声道、PCM16（`asr-sign.js` 里 `voice_format=1`）。 */
        const val SAMPLE_RATE = 16000
        const val CHANNEL = AudioFormat.CHANNEL_IN_MONO
        const val ENCODING = AudioFormat.ENCODING_PCM_16BIT

        /**
         * 一块多少字节：16000 Hz × 2 字节 × **0.1 秒** = 3200。
         * ⚠️ 与网页那一份的块大小不要求相同（那边是 4096 帧，≈85ms）——
         *    上游是**流**，认的是字节流不是块边界。
         */
        const val CHUNK_BYTES = 3200
    }
}
