import SwiftUI
import AVFoundation

enum VoicePhase { case listening, thinking, responding }

struct VoiceModeScreen: View {
    @EnvironmentObject var vm: FridayViewModel
    @Environment(\.dismiss) var dismiss

    @StateObject private var recorder = AudioRecorder()
    @State private var phase: VoicePhase = .listening
    @State private var captionText = ""
    @State private var replyText = ""
    @State private var errorText: String?
    @State private var player: AVAudioPlayer?
    @State private var silenceTimer: Timer?

    var body: some View {
        ZStack {
            FridayColor.bg.ignoresSafeArea()

            VStack {
                HStack {
                    Spacer()
                    Button { teardown(); dismiss() } label: {
                        Image(systemName: "xmark").font(.system(size: 16)).foregroundColor(FridayColor.text).frame(width: 36, height: 36).background(FridayColor.surface).clipShape(Circle())
                    }
                }
                .padding(.top, 8).padding(.horizontal, 16)

                Spacer()

                Text(captionForPhase)
                    .font(.system(size: 22))
                    .foregroundColor(FridayColor.text)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 24)
                    .frame(minHeight: 60)

                ParticleSphere(level: recorder.level, bands: pseudoBands, voiceId: vm.voiceId)
                    .frame(width: min(280, UIScreen.main.bounds.width * 0.7), height: min(280, UIScreen.main.bounds.width * 0.7))

                if phase == .thinking {
                    ProgressView().padding(.top, 12)
                } else if let errorText {
                    VStack(spacing: 8) {
                        Text(errorText).font(.system(size: 13)).foregroundColor(FridayColor.error)
                        Button("Try again") { self.errorText = nil; startListening() }
                            .font(.system(size: 13, weight: .medium))
                    }
                    .padding(.top, 12)
                }

                Spacer()

                HStack(spacing: 24) {
                    Button { teardown(); dismiss() } label: {
                        Image(systemName: "xmark")
                            .foregroundColor(FridayColor.muted)
                            .frame(width: 56, height: 56)
                            .overlay(Circle().stroke(FridayColor.hairline, lineWidth: 1))
                    }

                    if phase == .listening {
                        Button { stopAndSend() } label: {
                            Image(systemName: recorder.level > 0.08 ? "mic.fill" : "mic.slash.fill")
                                .font(.system(size: 22))
                                .foregroundColor(.white)
                                .frame(width: 64, height: 64)
                                .background(FridayColor.stop)
                                .clipShape(Circle())
                        }
                    } else if phase == .responding && !replyText.isEmpty {
                        Button { interrupt() } label: {
                            Image(systemName: "mic.fill")
                                .font(.system(size: 22))
                                .foregroundColor(.white)
                                .frame(width: 64, height: 64)
                                .background(FridayColor.stop)
                                .clipShape(Circle())
                        }
                    }
                }
                .padding(.bottom, 24)
            }
        }
        .onAppear { startListening() }
        .onDisappear { teardown() }
    }

    private var captionForPhase: String {
        switch phase {
        case .listening: return captionText.isEmpty ? "Say something…" : captionText
        case .thinking: return "Thinking…"
        case .responding: return replyText.isEmpty ? "Thinking…" : replyText
        }
    }

    private var pseudoBands: [CGFloat] {
        // Real FFT-band extraction would tap AVAudioEngine's raw buffer;
        // this derives a plausible per-band shimmer from the level meter
        // until that pipeline is wired in.
        (0..<24).map { i in max(0, recorder.level - CGFloat(i % 5) * 0.05) }
    }

    private func startListening() {
        phase = .listening
        captionText = ""
        recorder.start()
        resetSilenceTimer()
    }

    private func resetSilenceTimer() {
        silenceTimer?.invalidate()
        silenceTimer = Timer.scheduledTimer(withTimeInterval: 1.3, repeats: false) { _ in
            if recorder.isRecording && recorder.level > 0.08 { stopAndSend() }
        }
    }

    private func stopAndSend() {
        silenceTimer?.invalidate()
        guard let url = recorder.stop() else { startListening(); return }
        phase = .thinking
        Task {
            guard let data = try? Data(contentsOf: url),
                  let text = try? await VoiceApi.transcribe(audioData: data, containerMime: "audio/mp4", filename: "voice.m4a"),
                  !text.trimmingCharacters(in: .whitespaces).isEmpty
            else {
                await MainActor.run { errorText = "Didn't catch that."; phase = .listening }
                return
            }
            await MainActor.run { captionText = text }
            await sendAndSpeak(text)
        }
    }

    private func sendAndSpeak(_ text: String) async {
        await MainActor.run {
            vm.draft = text
            vm.send()
            phase = .responding
            replyText = ""
        }
        // Poll the current chat's last assistant message until streaming ends.
        while true {
            try? await Task.sleep(nanoseconds: 150_000_000)
            guard let last = await vm.currentChat?.messages.last(where: { $0.role == .assistant }) else { continue }
            await MainActor.run { replyText = last.content }
            if last.isStreaming == false && !last.content.isEmpty { break }
            if Task.isCancelled { return }
        }
        let finalText = await vm.currentChat?.messages.last(where: { $0.role == .assistant })?.content ?? ""
        guard !finalText.isEmpty else { await MainActor.run { startListening() }; return }
        if let audio = try? await VoiceApi.speak(text: finalText, voiceId: vm.voiceId) {
            await playAndLoop(audio)
        } else {
            await MainActor.run { startListening() }
        }
    }

    private func playAndLoop(_ data: Data) async {
        await MainActor.run {
            player = try? AVAudioPlayer(data: data)
            player?.play()
        }
        let duration = player?.duration ?? 0
        try? await Task.sleep(nanoseconds: UInt64(max(duration, 0.1) * 1_000_000_000))
        await MainActor.run { startListening() }
    }

    private func interrupt() {
        player?.stop()
        startListening()
    }

    private func teardown() {
        silenceTimer?.invalidate()
        recorder.cancel()
        player?.stop()
    }
}
