package chat.hupo.hupo_app

import android.content.pm.PackageManager
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

/**
 * 原生 Flutter 的入口（**这个 app 不是 WebView 外壳** —— `libapp.so` 里就是我们自己的 Dart UI；
 * WebView 只用在**小程序那一层**，见 `widgets/mini_runtime_native.dart`）。
 *
 * 这里只多挂一条 channel：**录音 ＋ 回放**（`NativeRecorder`，契约 `docs/dev/129` §十二）。
 * 权限那一下的回执要回到 `NativeRecorder` —— 它才是"第一次按下去才问"那句话的落点（D5.11）。
 */
class MainActivity : FlutterActivity() {
    private var recorder: NativeRecorder? = null

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        val channel = MethodChannel(flutterEngine.dartExecutor.binaryMessenger, CHANNEL)
        val r = NativeRecorder(this)
        r.bindPlayEnded(channel)
        channel.setMethodCallHandler(r)
        recorder = r
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == NativeRecorder.REQ_MIC) {
            val granted = grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED
            recorder?.onPermissionResult(granted)
        }
    }

    override fun onDestroy() {
        recorder?.releaseAll()
        recorder = null
        super.onDestroy()
    }

    companion object {
        /** 与 Dart 那一侧（`services/recorder_native.dart`）**必须逐字一致**。 */
        const val CHANNEL = "hupo/recorder"
    }
}
