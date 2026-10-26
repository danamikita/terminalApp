plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

// Keeps the Android app's version in lockstep with the desktop app's: CI
// passes the same "vX.Y.Z" tag that already triggers the desktop release
// build (see .github/workflows/release.yml), so one `npm version patch` +
// push produces matching version numbers on both. versionCode must strictly
// increase for Android to allow installing an update over an existing
// copy — encoding major/minor/patch into one integer does that as long as
// each part stays under 100, which plain semver patch/minor bumps satisfy.
val releaseVersionName = (System.getenv("ANDROID_VERSION_NAME") ?: "0.1.0").removePrefix("v")
val (verMajor, verMinor, verPatch) = releaseVersionName.split(".")
    .map { it.toIntOrNull() ?: 0 }
    .let { Triple(it.getOrElse(0) { 0 }, it.getOrElse(1) { 0 }, it.getOrElse(2) { 0 }) }
val releaseVersionCode = verMajor * 10000 + verMinor * 100 + verPatch

android {
    namespace = "com.danamikita.terminalapp.mobile"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.danamikita.terminalapp.mobile"
        minSdk = 26
        targetSdk = 36
        versionCode = releaseVersionCode
        versionName = releaseVersionName
    }

    signingConfigs {
        create("release") {
            val keystorePath = System.getenv("ANDROID_KEYSTORE_PATH")
            if (keystorePath != null) {
                storeFile = file(keystorePath)
                storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("ANDROID_KEY_ALIAS")
                keyPassword = System.getenv("ANDROID_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            if (System.getenv("ANDROID_KEYSTORE_PATH") != null) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation(platform("androidx.compose:compose-bom:2024.10.01"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")

    // Apache-2.0 licensed (carried over from jackpal's "Terminal Emulator for
    // Android" — see termux-app's LICENSE.md). We use only TerminalEmulator +
    // TerminalRenderer, not TerminalSession/TerminalView, since those require
    // a real local PTY via JNI that we don't have or want — see android plan.
    implementation("com.github.termux.termux-app:terminal-emulator:v0.118.3")
    implementation("com.github.termux.termux-app:terminal-view:v0.118.3")

    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    implementation("androidx.security:security-crypto:1.1.0-alpha06")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("androidx.navigation:navigation-compose:2.8.4")
}
