import AVFoundation
import Combine

/// Push-to-talk recorder for the composer mic button — captures AAC/.m4a and
/// polls real mic amplitude for the waveform, mirroring android's approach
/// (MediaRecorder.getMaxAmplitude() polled every ~70ms, sqrt-scaled).
final class AudioRecorder: NSObject, ObservableObject {
    @Published var isRecording = false
    @Published var elapsed: TimeInterval = 0
    @Published var level: CGFloat = 0 // 0...1, sqrt-scaled

    private var recorder: AVAudioRecorder?
    private var timer: Timer?
    private var startedAt: Date?
    private(set) var fileURL: URL?

    func start() {
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker])
        session.requestRecordPermission { [weak self] granted in
            guard granted else { return }
            DispatchQueue.main.async { self?.beginRecording() }
        }
    }

    private func beginRecording() {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(UUID().uuidString).m4a")
        fileURL = url
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: 44100,
            AVNumberOfChannelsKey: 1,
            AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue,
        ]
        recorder = try? AVAudioRecorder(url: url, settings: settings)
        recorder?.isMeteringEnabled = true
        recorder?.record()
        isRecording = true
        startedAt = Date()
        timer = Timer.scheduledTimer(withTimeInterval: 0.07, repeats: true) { [weak self] _ in
            self?.tick()
        }
    }

    private func tick() {
        guard let recorder, let startedAt else { return }
        elapsed = Date().timeIntervalSince(startedAt)
        recorder.updateMeters()
        let avgPower = recorder.averagePower(forChannel: 0) // dB, roughly -160...0
        let normalized = max(0, min(1, (avgPower + 50) / 50))
        level = CGFloat(sqrt(normalized))
    }

    /// Stops and returns the captured file, or nil if nothing was recorded.
    func stop() -> URL? {
        timer?.invalidate()
        timer = nil
        recorder?.stop()
        isRecording = false
        let url = fileURL
        fileURL = nil
        return url
    }

    func cancel() {
        timer?.invalidate()
        timer = nil
        recorder?.stop()
        if let fileURL { try? FileManager.default.removeItem(at: fileURL) }
        fileURL = nil
        isRecording = false
    }
}
