plugins {
    id("com.android.application")
    id("kotlin-android")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

// ── 🔴 正式签名（2026-09-28）──────────────────────────────────────────
//
// 主人拍板：*"先建一把正式 keystore，再用它签"* —— 因为**这个包要挂到首页给人下载**：
//   · debug 签名是**公开的**（谁都能签一个同包名的"更新"）；
//   · 而且换签名之后，**已装的人只能卸载重装**（覆盖安装要求同一把签名）。
//
// 🔴 **口令不进这个文件**（也不进仓库）：它们住在 `~/.hupo/release-signing.env`
//    （0600、仓库外），由 `scripts/build-apk.sh` **source 进来再 export**。
//    这个文件只读环境变量。
//
// ⚠️ **没有那几个环境变量时，release 构建会当场失败**（不是"悄悄退回 debug 签名"）——
//    "打出来一个用 debug 签的包挂到公网"这件事必须**结构上做不到**。
//    （要跑一个不带签名的调试包 ⇒ 用 `flutter build apk --debug` / `flutter run`，
//      那条路照旧用 debug 签名，本来就不该往外发。）
val storeFilePath: String? = System.getenv("HUPO_STORE_FILE")
val storePw: String? = System.getenv("HUPO_STORE_PASSWORD")
val keyAliasName: String? = System.getenv("HUPO_KEY_ALIAS")
val keyPw: String? = System.getenv("HUPO_KEY_PASSWORD")

android {
    namespace = "chat.hupo.hupo_app"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }

    kotlinOptions {
        jvmTarget = JavaVersion.VERSION_11.toString()
    }

    defaultConfig {
        // 🔴 **2.0 是另一个 app**（主人 2026-10-05：*「打包apk，这次是2.0版本了，
        //    我想起另一个app，不要覆盖1.0。名字叫琥珀聊天」*）。
        //    ⇒ **装上去的身份换了一个**：1.0 那个是 `chat.hupo.hupo_app`（tag `v1.0`），
        //      两个包**身份不同 ⇒ 可以并排装在同一台手机上**，谁也覆盖不了谁。
        //    ⚠️ **这一行不许改回 `chat.hupo.hupo_app`** —— 改回去 = 新包会**顶掉**他手上
        //      那个 1.0（安卓按 `applicationId` 认"是不是同一个 app"）。判据钉着它
        //      （`test/unit/android_manifest_test.dart`）。
        //    ⚠️ `namespace` 与 Kotlin 那几份**不动**（`.MainActivity` 是相对它解析的）：
        //      `applicationId` 才是"装上去的身份"，`namespace` 只是代码的包名。
        applicationId = "chat.hupo.hupo_chat"
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    // 🔴 **经典打包布局**（2026-09-30 · 真机装不上时试的那一档）：
    //    默认（`useLegacyPackaging = false`）是把 `.so` **不压缩**放进包里、
    //    装着页对齐（`extractNativeLibs="false"`）—— 这是新版 AGP 的推荐做法，
    //    但**有些厂商的安装器只认经典布局**（`.so` 压缩在包里、安装时解出来）。
    //    ⇒ 用 `HUPO_LEGACY_PACKAGING=1` 打一个对照包来分这一刀（默认不动）。
    packaging {
        jniLibs {
            useLegacyPackaging = System.getenv("HUPO_LEGACY_PACKAGING") == "1"
        }
    }

    signingConfigs {
        if (storeFilePath != null) {
            create("release") {
                storeFile = file(storeFilePath)
                storePassword = storePw
                keyAlias = keyAliasName
                keyPassword = keyPw
                // 🔴 **三种签名方案全开**（2026-09-30）：
                //    AGP 在 `minSdk >= 24` 时**默认只签 v2**（v1 是给 Android 6 及以下的），
                //    而真机上"**解析包时出现问题**"有一类就出在这儿 ——
                //    **第三方安装器 / 文件管理器**用老的 JAR 校验去看那个包时，
                //    只看得到"没有 v1 签名"。⇒ 三样都签上，代价是包大几百 KB，
                //    换来的是"谁来看都认得出这是一个合法的包"。
                //    ⚠️ v3 是 Android 9+ 的密钥轮换那条路（留着不碍事）；
                //       v2 才是 Android 7+ 真正生效的那一个。
                enableV1Signing = true
                enableV2Signing = true
                enableV3Signing = true
            }
        }
    }

    buildTypes {
        release {
            if (storeFilePath == null) {
                throw GradleException(
                    "release 包必须用正式签名：先 source ~/.hupo/release-signing.env（" +
                        "或直接用 scripts/build-apk.sh，它会替你 source）。" +
                        "缺 HUPO_STORE_FILE / HUPO_STORE_PASSWORD / HUPO_KEY_ALIAS / HUPO_KEY_PASSWORD。"
                )
            }
            signingConfig = signingConfigs.getByName("release")
        }
    }
}

flutter {
    source = "../.."
}
