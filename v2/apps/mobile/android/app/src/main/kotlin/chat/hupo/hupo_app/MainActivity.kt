package chat.hupo.hupo_app

import android.content.pm.PackageManager
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

/**
 * 原生 Flutter 的入口（**这个 app 不是 WebView 外壳** —— `libapp.so` 里就是我们自己的 Dart UI；
 * WebView 只用在**小程序那一层**，见 `widgets/mini_runtime_native.dart`）。
 *
 * 这里挂两条 channel：
 *   · **录音 ＋ 回放**（`NativeRecorder`，契约 `docs/dev/129` §十二）；
 *   · **开麦 → 转文字**（`NativeMic`，§十四 —— 采 16k PCM 交给 Dart 送去 `/api/asr`）。
 * 两条都要 `RECORD_AUDIO`，而权限那一下的回执要回到**发起的那一个**
 * （"第一次按下去才问"是 D5.11 定的形状）。
 */
class MainActivity : FlutterActivity() {
    private var recorder: NativeRecorder? = null
    private var mic: NativeMic? = null

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)

        val channel = MethodChannel(flutterEngine.dartExecutor.binaryMessenger, CHANNEL)
        val r = NativeRecorder(this)
        r.bindPlayEnded(channel)
        r.bindMeter(channel)
        channel.setMethodCallHandler(r)
        recorder = r

        val micChannel = MethodChannel(flutterEngine.dartExecutor.binaryMessenger, HEARING_CHANNEL)
        val m = NativeMic(this)
        m.bind(micChannel)
        micChannel.setMethodCallHandler(m)
        mic = m
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        val granted = grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED
        when (requestCode) {
            NativeRecorder.REQ_MIC -> recorder?.onPermissionResult(granted)
            NativeMic.REQ_MIC -> mic?.onPermissionResult(granted)
        }
    }

    override fun onDestroy() {
        recorder?.releaseAll()
        recorder = null
        mic = null
        super.onDestroy()
    }

    companion object {
        /** 与 Dart 那一侧（`services/recorder_native.dart`）**必须逐字一致**。 */
        const val CHANNEL = "hupo/recorder"

        /** 与 Dart 那一侧（`services/hearing_native.dart`）**必须逐字一致**。 */
        const val HEARING_CHANNEL = "hupo/hearing"
    }
}
