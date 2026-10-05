package chat.hupo.hupo_app

import android.app.Activity
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.util.Locale

/**
 * **原生念出来**（安卓那一份 · 主人 2026-10-05：*"播放语音……如果开启，
 * 会将对 agent 的回复进行语音转换和实时播报。"*）。
 *
 * 契约：`docs/dev/189-VOICE-BAR-BUTTONS.md`。
 *
 * ── 三条与网页那一份（`speech_web.dart`）对齐 ────────────────
 *  ① 🔴 **一个字节都不往外发**：交给**系统自带**的合成器（`android.speech.tts`）——
 *     这一步与"系统读任何一段文字"是同一件事，不是我们在传。
 *  ② 🔴 **念不出来就不许画那颗按钮**：引擎装不上 / 没有中文音色 ⇒ `canSpeak` 假
 *     （`ready` 那条消息把结果告诉 Dart 那一侧）。
 *  ③ **一次只念一段**：新的开念之前先 `stop()`；用户关掉开关 / 离开那一屏也要停。
 *
 * ⚠️ 引擎的初始化是**异步**的（`OnInitListener`）⇒ 这条口有两条路：
 *   · Dart 问 `canSpeak`（可能还没就绪 ⇒ 假）；
 *   · 就绪之后**主动**回一条 `ready`（Dart 据此重建一次，那颗按钮才出现）。
 *
 * ⚠️ 帧/回调要**回主线程**再 `invokeMethod`（平台通道只许在平台线程上叫）。
 */
class NativeTts(private val activity: Activity) : MethodChannel.MethodCallHandler,
    TextToSpeech.OnInitListener {

    private var tts: TextToSpeech? = null
    private var channel: MethodChannel? = null
    private var ready = false

    /** 引擎还没起来时问的那一次（起来了就立刻回它）。 */
    private var waiting: MethodChannel.Result? = null

    fun bind(ch: MethodChannel) {
        channel = ch
        ch.setMethodCallHandler(this)
        // ⚠️ 建它就等于开始初始化（回调走 `onInit`）
        tts = TextToSpeech(activity, this)
    }

    override fun onInit(status: Int) {
        var ok = status == TextToSpeech.SUCCESS
        if (ok) {
            // 🔴 中文音色**必须有**：没有它念出来是空的（或念成英文腔），
            //    那种"能念"是假的 ⇒ 一样当"这台念不出来"。
            val r = try {
                tts?.setLanguage(Locale.SIMPLIFIED_CHINESE)
            } catch (_: Exception) {
                TextToSpeech.LANG_NOT_SUPPORTED
            }
            ok = r != TextToSpeech.LANG_MISSING_DATA && r != TextToSpeech.LANG_NOT_SUPPORTED
        }
        ready = ok
        if (ok) {
            tts?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                override fun onStart(utteranceId: String?) {}
                override fun onDone(utteranceId: String?) {
                    // 念完那一段 ⇒ 告诉 Dart 那一侧（界面据此把"正在念"收掉）
                    channel?.invokeMethod("speakEnded", null)
                }

                @Deprecated("旧 API", ReplaceWith(""))
                override fun onError(utteranceId: String?) {
                    channel?.invokeMethod("speakEnded", null)
                }
            })
        }
        // ① 问着的那一次：回它
        waiting?.success(ok)
        waiting = null
        // ② **主动举手**：晚到的那一侧据此重建（那颗按钮才会出现）
        channel?.invokeMethod("ready", ok)
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "canSpeak" -> {
                if (tts == null) {
                    result.success(false)
                } else if (ready) {
                    result.success(true)
                } else {
                    // 还没初始化完 ⇒ 先挂着，`onInit` 里回它（**绝不猜**）
                    waiting?.success(false)
                    waiting = result
                }
            }
            "speak" -> {
                val text = call.argument<String>("text") ?: ""
                if (!ready || text.isBlank()) {
                    result.success(false)
                    return
                }
                // 一次只念一段（不 stop 的话两段会排队叠着念）
                tts?.stop()
                val code = tts?.speak(text, TextToSpeech.QUEUE_FLUSH, null, "hupo-${System.nanoTime()}")
                result.success(code != TextToSpeech.ERROR)
            }
            "stop" -> {
                tts?.stop()
                result.success(null)
            }
            else -> result.notImplemented()
        }
    }

    fun release() {
        try {
            tts?.stop()
            tts?.shutdown()
        } catch (_: Exception) {
            // 已经没了
        }
        tts = null
        ready = false
        channel?.setMethodCallHandler(null)
        channel = null
    }
}
