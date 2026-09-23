import SwiftUI
import AVFoundation
import Accelerate

enum VoicePhase { case listening, thinking, responding }

// MARK: - Spectrum

/// 1024-point FFT folded into log-spaced bands, auto-gained so quiet and loud sources both use
/// the full 0...1 range.
final class SpectrumAnalyzer {
    private let n = 1024
    private let log2n: vDSP_Length = 10
    private let setup: FFTSetup
    private var window = [Float](repeating: 0, count: 1024)
    private var peakDb: Float = 30

    init() {
        setup = vDSP_create_fftsetup(10, FFTRadix(kFFTRadix2))!
        vDSP_hann_window(&window, 1024, Int32(vDSP_HANN_NORM))
    }

    deinit { vDSP_destroy_fftsetup(setup) }

    func bands(samples: UnsafePointer<Float>, count: Int, bandCount: Int) -> [CGFloat] {
        var input = [Float](repeating: 0, count: n)
        for i in 0..<min(count, n) { input[i] = samples[i] * window[i] }
        var real = [Float](repeating: 0, count: n / 2)
        var imag = [Float](repeating: 0, count: n / 2)
        var mags = [Float](repeating: 0, count: n / 2)
        real.withUnsafeMutableBufferPointer { rp in
            imag.withUnsafeMutableBufferPointer { ip in
                var split = DSPSplitComplex(realp: rp.baseAddress!, imagp: ip.baseAddress!)
                input.withUnsafeBufferPointer { inp in
                    inp.baseAddress!.withMemoryRebound(to: DSPComplex.self, capacity: n / 2) { cp in
                        vDSP_ctoz(cp, 2, &split, 1, vDSP_Length(n / 2))
                    }
                }
                vDSP_fft_zrip(setup, &split, 1, log2n, FFTDirection(FFT_FORWARD))
                vDSP_zvmags(&split, 1, &mags, 1, vDSP_Length(n / 2))
            }
        }

        var dbs = [Float](repeating: -120, count: bandCount)
        let hi = Double(n / 2)
        for b in 0..<bandCount {
            let a = max(1, Int(pow(hi, Double(b) / Double(bandCount))))
            let e = min(n / 2, max(a + 1, Int(pow(hi, Double(b + 1) / Double(bandCount)))))
            var sum: Float = 0
            for k in a..<e { sum += mags[k] }
            dbs[b] = 10 * log10(sum / Float(e - a) + 1e-9)
        }
        let frameMax = dbs.max() ?? -120
        peakDb = max(30, max(frameMax, peakDb - 0.15))
        return dbs.map { CGFloat(max(0, min(1, ($0 - (peakDb - 42)) / 42))) }
    }
}

// MARK: - Engine

/// Mic capture (with live level/FFT + voice-activity detection) and TTS playback (with live
/// level/FFT), sharing one audio session. Published values drive the particle sphere.
final class VoiceEngine: ObservableObject {
    static let bandCount = 24

    @Published var level: CGFloat = 0
    @Published var bands = [CGFloat](repeating: 0, count: VoiceEngine.bandCount)

    /// Set from the UI (main thread) to end the current utterance / cut off the reply.
    var manualSend = false
    var interruptSpeech = false

    private let micEngine = AVAudioEngine()
    private let playEngine = AVAudioEngine()
    private let playerNode = AVAudioPlayerNode()
    private var playerAttached = false
    private var pendingResume: (() -> Void)?

    private let micAnalyzer = SpectrumAnalyzer()
    private let playAnalyzer = SpectrumAnalyzer()

    private let lock = NSLock()
    private var file: AVAudioFile?
    private var fileURL: URL?
    private var noiseFloor: Float = 0.004
    private var speechFrames = 0
    private var heardSpeech = false
    private var lastSpeechAt = Date.distantPast
    private var lastPublish: TimeInterval = 0

    // MARK: Mic

    var shouldAutoSubmit: Bool {
        lock.lock(); defer { lock.unlock() }
        return heardSpeech && Date().timeIntervalSince(lastSpeechAt) > 1.1
    }

    func startMic() async -> Bool {
        let granted: Bool = await withCheckedContinuation { cont in
            AVAudioSession.sharedInstance().requestRecordPermission { cont.resume(returning: $0) }
        }
        guard granted else { return false }
        configureSession()

        let input = micEngine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { return false }

        let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(UUID().uuidString).m4a")
        let f = try? AVAudioFile(forWriting: url, settings: [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: format.sampleRate,
            AVNumberOfChannelsKey: Int(format.channelCount),
            AVEncoderBitRateKey: 64_000,
        ])
        lock.lock()
        file = f
        fileURL = url
        speechFrames = 0
        heardSpeech = false
        lastSpeechAt = .distantPast
        lock.unlock()

        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 2048, format: format) { [weak self] buffer, _ in
            self?.handleMic(buffer)
        }
        micEngine.prepare()
        do { try micEngine.start() } catch { return false }
        return true
    }

    private func handleMic(_ buffer: AVAudioPCMBuffer) {
        guard let channel = buffer.floatChannelData?[0] else { return }
        let count = Int(buffer.frameLength)
        var rms: Float = 0
        vDSP_rmsqv(channel, 1, &rms, vDSP_Length(count))

        lock.lock()
        try? file?.write(from: buffer)
        let threshold = max(0.012, noiseFloor * 3)
        if rms > threshold {
            speechFrames += 1
            if speechFrames >= 3 { heardSpeech = true }
            lastSpeechAt = Date()
        } else {
            speechFrames = 0
            noiseFloor = noiseFloor * 0.97 + rms * 0.03
        }
        lock.unlock()

        let db = 20 * log10(rms + 1e-7)
        let lvl = CGFloat(sqrt(max(0, min(1, (db + 50) / 50))))
        publish(level: lvl) { self.micAnalyzer.bands(samples: channel, count: count, bandCount: Self.bandCount) }
    }

    /// Stops capture and returns the recorded file.
    func stopMic() -> URL? {
        micEngine.inputNode.removeTap(onBus: 0)
        micEngine.stop()
        lock.lock()
        file = nil
        let url = fileURL
        fileURL = nil
        lock.unlock()
        resetVisuals()
        return url
    }

    // MARK: Playback

    func play(_ data: Data) async {
        let isWav = data.starts(with: [0x52, 0x49, 0x46, 0x46])
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(UUID().uuidString).\(isWav ? "wav" : "mp3")")
        guard (try? data.write(to: url)) != nil, let audioFile = try? AVAudioFile(forReading: url) else { return }
        defer { try? FileManager.default.removeItem(at: url) }

        configureSession()
        playEngine.stop()
        if !playerAttached {
            playEngine.attach(playerNode)
            playerAttached = true
        }
        playEngine.disconnectNodeOutput(playerNode)
        playEngine.connect(playerNode, to: playEngine.mainMixerNode, format: audioFile.processingFormat)
        let mixer = playEngine.mainMixerNode
        mixer.removeTap(onBus: 0)
        mixer.installTap(onBus: 0, bufferSize: 1024, format: mixer.outputFormat(forBus: 0)) { [weak self] buffer, _ in
            guard let self, let channel = buffer.floatChannelData?[0] else { return }
            let count = Int(buffer.frameLength)
            var rms: Float = 0
            vDSP_rmsqv(channel, 1, &rms, vDSP_Length(count))
            let db = 20 * log10(rms + 1e-7)
            let lvl = CGFloat(sqrt(max(0, min(1, (db + 45) / 45))))
            self.publish(level: lvl) { self.playAnalyzer.bands(samples: channel, count: count, bandCount: Self.bandCount) }
        }
        playEngine.prepare()
        guard (try? playEngine.start()) != nil else { return }

        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            var resumed = false
            let finish: () -> Void = {
                if !resumed { resumed = true; cont.resume() }
            }
            pendingResume = finish
            playerNode.scheduleFile(audioFile, at: nil, completionCallbackType: .dataPlayedBack) { _ in
                DispatchQueue.main.async { finish() }
            }
            playerNode.play()
        }
        pendingResume = nil
        mixer.removeTap(onBus: 0)
        playEngine.stop()
        resetVisuals()
    }

    func stopPlayback() {
        if playerAttached { playerNode.stop() }
        pendingResume?()
    }

    func shutdown() {
        micEngine.inputNode.removeTap(onBus: 0)
        micEngine.stop()
        playEngine.mainMixerNode.removeTap(onBus: 0)
        playEngine.stop()
        lock.lock(); file = nil; fileURL = nil; lock.unlock()
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    // MARK: Helpers

    private func configureSession() {
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetooth])
        try? session.setActive(true)
    }

    private func publish(level: CGFloat, bands compute: () -> [CGFloat]) {
        let now = CACurrentMediaTime()
        guard now - lastPublish > 0.03 else { return }
        lastPublish = now
        let b = compute()
        DispatchQueue.main.async {
            self.level = level
            self.bands = b
        }
    }

    private func resetVisuals() {
        DispatchQueue.main.async {
            self.level = 0
            self.bands = [CGFloat](repeating: 0, count: Self.bandCount)
        }
    }
}

// MARK: - Screen

struct VoiceModeScreen: View {
    @EnvironmentObject var vm: FridayViewModel
    @Environment(\.dismiss) var dismiss

    @StateObject private var voice = VoiceEngine()
    @State private var phase: VoicePhase = .listening
    @State private var captionText = ""
    @State private var replyText = ""
    @State private var errorText: String?
    @State private var loopTask: Task<Void, Never>?

    var body: some View {
        ZStack {
            FridayColor.bg.ignoresSafeArea()

            VStack {
                HStack {
                    Spacer()
                    Button { close() } label: {
                        Image(systemName: "xmark").font(.system(size: 16)).foregroundColor(FridayColor.text).frame(width: 36, height: 36).background(FridayColor.surface).clipShape(Circle())
                    }
                }
                .padding(.top, 8).padding(.horizontal, 16)

                Spacer()

                Text(captionForPhase)
                    .font(.system(size: 21))
                    .foregroundColor(FridayColor.text)
                    .multilineTextAlignment(.center)
                    .lineLimit(7)
                    .padding(.horizontal, 24)
                    .frame(minHeight: 60)
                    .animation(.easeInOut(duration: 0.2), value: captionForPhase)

                ParticleSphere(level: voice.level, bands: voice.bands, voiceId: vm.voiceId, pulsing: phase == .thinking)
                    .frame(width: min(300, UIScreen.main.bounds.width * 0.75), height: min(300, UIScreen.main.bounds.width * 0.75))
                    .onTapGesture { primaryAction() }

                if let errorText {
                    Text(errorText).font(.system(size: 13)).foregroundColor(FridayColor.error).padding(.top, 12).multilineTextAlignment(.center).padding(.horizontal, 24)
                }

                Spacer()

                HStack(spacing: 24) {
                    Button { close() } label: {
                        Image(systemName: "xmark")
                            .foregroundColor(FridayColor.muted)
                            .frame(width: 56, height: 56)
                            .overlay(Circle().stroke(FridayColor.hairline, lineWidth: 1))
                    }

                    if phase == .listening {
                        Button { primaryAction() } label: {
                            Image(systemName: "arrow.up")
                                .font(.system(size: 22, weight: .semibold))
                                .foregroundColor(.white)
                                .frame(width: 64, height: 64)
                                .background(FridayColor.stop)
                                .clipShape(Circle())
                        }
                    } else if phase == .responding {
                        Button { primaryAction() } label: {
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
        .onAppear {
            guard loopTask == nil else { return }
            loopTask = Task { await conversationLoop() }
        }
        .onDisappear { teardown() }
    }

    private var captionForPhase: String {
        switch phase {
        case .listening: return captionText.isEmpty ? "Say something…" : captionText
        case .thinking: return captionText.isEmpty ? "Thinking…" : captionText
        case .responding: return replyText.isEmpty ? "Thinking…" : replyText
        }
    }

    private func primaryAction() {
        switch phase {
        case .listening: voice.manualSend = true
        case .responding: voice.interruptSpeech = true; voice.stopPlayback()
        case .thinking: break
        }
    }

    private func close() {
        teardown()
        dismiss()
    }

    private func teardown() {
        loopTask?.cancel()
        loopTask = nil
        voice.interruptSpeech = true
        voice.stopPlayback()
        voice.shutdown()
    }

    // MARK: Conversation loop

    @MainActor
    private func conversationLoop() async {
        while !Task.isCancelled {
            phase = .listening
            captionText = ""
            replyText = ""
            voice.manualSend = false
            voice.interruptSpeech = false

            guard await voice.startMic() else {
                errorText = "Microphone permission is needed for voice mode."
                return
            }
            while !Task.isCancelled && !voice.manualSend && !voice.shouldAutoSubmit {
                try? await Task.sleep(nanoseconds: 50_000_000)
            }
            if Task.isCancelled { _ = voice.stopMic(); return }

            guard let url = voice.stopMic() else { continue }
            phase = .thinking
            guard let text = await transcribe(url) else {
                errorText = "Didn't catch that — try again."
                continue
            }
            errorText = nil
            captionText = text
            await respond(to: text)
        }
    }

    private func transcribe(_ url: URL) async -> String? {
        defer { try? FileManager.default.removeItem(at: url) }
        guard let data = try? Data(contentsOf: url), data.count > 2_000,
              let text = try? await VoiceApi.transcribe(audioData: data, containerMime: "audio/mp4", filename: "voice.m4a")
        else { return nil }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private final class Pipeline {
        var queue: [Task<Data?, Never>] = []
        var producerDone = false
    }

    /// Sends the transcript and speaks the reply as it streams: the first sentence is synthesized
    /// as soon as it's complete, and later chunks are fetched while earlier audio is playing, so
    /// speech starts long before the full reply exists.
    @MainActor
    private func respond(to text: String) async {
        guard let messageId = vm.send(text: text) else {
            errorText = "Couldn't send that — check your connection and try again."
            return
        }
        let pipeline = Pipeline()
        let voiceId = vm.voiceId

        let producer = Task { @MainActor in
            var spokenUpTo = 0
            var first = true
            while !Task.isCancelled && !voice.interruptSpeech {
                let message = vm.currentChat?.messages.first(where: { $0.id == messageId })
                let content = message?.content ?? ""
                let streaming = message?.isStreaming ?? false
                if replyText != content { replyText = content }
                if phase == .thinking && !content.isEmpty { phase = .responding }

                let chars = Array(content)
                if let end = Self.nextChunkEnd(chars, from: spokenUpTo, first: first, done: !streaming) {
                    let chunk = String(chars[spokenUpTo..<end])
                    spokenUpTo = end
                    let speakable = Self.cleanForSpeech(chunk)
                    if !speakable.isEmpty {
                        first = false
                        pipeline.queue.append(Task { try? await VoiceApi.speak(text: speakable, voiceId: voiceId) })
                    }
                } else if !streaming && spokenUpTo >= chars.count {
                    break
                }
                try? await Task.sleep(nanoseconds: 80_000_000)
            }
            pipeline.producerDone = true
        }

        var playedAny = false
        var failedTTS = false
        while !Task.isCancelled && !voice.interruptSpeech {
            if !pipeline.queue.isEmpty {
                let fetch = pipeline.queue.removeFirst()
                guard let audio = await fetch.value, !audio.isEmpty else { failedTTS = true; continue }
                if voice.interruptSpeech { break }
                phase = .responding
                playedAny = true
                await voice.play(audio)
            } else if pipeline.producerDone {
                break
            } else {
                try? await Task.sleep(nanoseconds: 50_000_000)
            }
        }
        producer.cancel()
        pipeline.queue.forEach { $0.cancel() }
        voice.stopPlayback()
        if failedTTS && !playedAny { errorText = "Couldn't play that reply out loud — it's in the chat as text." }
    }

    // MARK: Text chunking

    /// End index (exclusive) of the next chunk to speak, or nil if it isn't ready yet. The first
    /// chunk is a single sentence for a fast start; later chunks are larger to stay within the
    /// backend's voice rate limit.
    private static func nextChunkEnd(_ chars: [Character], from start: Int, first: Bool, done: Bool) -> Int? {
        guard start < chars.count else { return nil }
        let minLen = first ? 12 : 220
        var i = start
        while i < chars.count {
            let c = chars[i]
            let isTerminator = c == "." || c == "!" || c == "?" || c == "\n" || c == "।"
            if isTerminator && i - start + 1 >= minLen {
                let hasNext = i + 1 < chars.count
                if c == "\n" || (hasNext && (chars[i + 1] == " " || chars[i + 1] == "\n")) { return i + 1 }
            }
            i += 1
        }
        return done ? chars.count : nil
    }

    private static func cleanForSpeech(_ text: String) -> String {
        var s = text
        s = s.replacingOccurrences(of: "```[\\s\\S]*?```", with: " ", options: .regularExpression)
        s = s.replacingOccurrences(of: "!\\[[^\\]]*\\]\\([^)]*\\)", with: " ", options: .regularExpression)
        s = s.replacingOccurrences(of: "\\[([^\\]]+)\\]\\([^)]*\\)", with: "$1", options: .regularExpression)
        s = s.replacingOccurrences(of: "https?://\\S+", with: " ", options: .regularExpression)
        s = s.replacingOccurrences(of: "[*_`#>]", with: "", options: .regularExpression)
        s = s.replacingOccurrences(of: "^\\s*[-•]\\s+", with: "", options: [.regularExpression])
        return s.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
