// Top-level build file. Module configuration lives in core/ (pure Kotlin/JVM) and app/ (Android UI).
plugins {
    alias(libs.plugins.android.application) apply false
    // Declared so the Kotlin Gradle plugin on the classpath matches the Compose compiler plugin version
    // (AGP 9 compiles Kotlin itself — the app module does not apply this plugin).
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.kotlin.jvm) apply false
    alias(libs.plugins.kotlin.compose) apply false
    alias(libs.plugins.kotlin.serialization) apply false
    alias(libs.plugins.roborazzi) apply false
}
