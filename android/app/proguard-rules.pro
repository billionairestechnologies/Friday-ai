# Friday — keep Compose + coroutines readable in debug traces
-keepattributes SourceFile,LineNumberTable

# Razorpay checkout SDK
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
-keepattributes JavascriptInterface
-keep class com.razorpay.** {*;}
-optimizations !method/inlining/*
-keepclasseswithmembers class * {
    public void onPayment*(...);
}
