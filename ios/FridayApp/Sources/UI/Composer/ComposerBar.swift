import SwiftUI

struct ComposerBar: View {
    @EnvironmentObject var vm: FridayViewModel
    @StateObject private var recorder = AudioRecorder()
    @FocusState private var focused: Bool

    var body: some View {
        VStack(spacing: 8) {
            if !vm.pendingAttachments.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(vm.pendingAttachments) { attachment in
                            AttachmentChip(attachment: attachment) { vm.removeAttachment(attachment.id) }
                        }
                    }
                    .padding(.horizontal, 4)
                }
            }

            if let error = vm.attachmentError {
                Text(error).font(.system(size: 12)).foregroundColor(FridayColor.error)
            }

            if recorder.isRecording {
                recordingRow
            } else {
                VStack(spacing: 6) {
                    TextField("", text: $vm.draft, prompt: Text(placeholderFor(vm.modes)).foregroundColor(FridayColor.muted), axis: .vertical)
                        .font(.system(size: 16))
                        .foregroundColor(FridayColor.text)
                        .lineLimit(1...6)
                        .focused($focused)
                        .onSubmit { vm.send() }

                    bottomRow
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(FridayColor.bg)
        .overlay(
            RoundedRectangle(cornerRadius: FridayRadius.composer)
                .stroke(recorder.isRecording ? FridayColor.stop.opacity(0.5) : FridayColor.hairline, lineWidth: 1)
        )
        .cornerRadius(FridayRadius.composer)
        .shadow(color: Color(hex: 0x3C4043).opacity(0.12), radius: 16, x: 0, y: 4)
        .padding(.horizontal, 12)
    }

    private var bottomRow: some View {
        HStack(spacing: 6) {
            // Left group scrolls independently, matching android's Row(weight(1f).horizontalScroll):
            // with both Search and Think active their labels expand and would otherwise collide
            // with the model/voice/send controls on narrow phones.
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 10) {
                    Button { vm.sheet = .attach } label: {
                        Image(systemName: "plus")
                            .font(.system(size: 16, weight: .medium))
                            .foregroundColor(FridayColor.text)
                            .frame(width: 36, height: 36)
                            .background(FridayColor.surface)
                            .clipShape(Circle())
                    }

                    ModeChip(icon: "globe", label: "Search", color: FridayColor.search, active: vm.modes.contains(.search)) {
                        vm.toggleMode(.search)
                    }
                    Rectangle().fill(FridayColor.hairline).frame(width: 1, height: 18)
                    ModeChip(icon: "gearshape", label: "Think", color: FridayColor.think, active: vm.modes.contains(.think)) {
                        vm.toggleMode(.think)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            do {
                HStack(spacing: 6) {
                if vm.draft.isEmpty && vm.modes.isEmpty {
                    Button { vm.voiceModeOpen = true } label: {
                        Image(systemName: "waveform")
                            .font(.system(size: 16))
                            .foregroundColor(FridayColor.text)
                            .frame(width: 36, height: 36)
                    }
                    .transition(.opacity.combined(with: .scale(scale: 0.6)))
                }

                Button { vm.sheet = .model } label: {
                    HStack(spacing: 4) {
                        Image(systemName: modelIcon)
                            .font(.system(size: 13))
                            .foregroundColor(modelIconColor)
                        Text(modelLabel).font(.system(size: 13, weight: .medium)).lineLimit(1).frame(maxWidth: 96, alignment: .leading).fixedSize(horizontal: true, vertical: false)
                        Image(systemName: "chevron.down").font(.system(size: 12))
                    }
                    .foregroundColor(FridayColor.text)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 6)
                    .contentShape(RoundedRectangle(cornerRadius: 20))
                }
                .fixedSize()
                .layoutPriority(1)
                }
                .transition(.move(edge: .trailing).combined(with: .opacity))
            }

            trailingAction
        }
        .animation(.easeInOut(duration: 0.2), value: vm.draft.isEmpty && vm.modes.isEmpty)
    }

    private var modelIcon: String {
        if vm.selectedModelId == AUTO_MODEL_ID { return "bolt.fill" }
        if vm.selectedModelId == TEAMUP_MODEL_ID { return "person.3.fill" }
        if let model = vm.remoteModels.first(where: { $0.modelId == vm.selectedModelId }) {
            return ModelBrand.systemIcon(for: model.modelId + " " + model.displayName)
        }
        return "sparkles"
    }

    private var modelIconColor: Color {
        if vm.selectedModelId == AUTO_MODEL_ID || vm.selectedModelId == TEAMUP_MODEL_ID { return FridayColor.muted }
        if let model = vm.remoteModels.first(where: { $0.modelId == vm.selectedModelId }) {
            return ModelBrand.color(for: model.modelId + " " + model.displayName)
        }
        return FridayColor.muted
    }

    private var modelLabel: String {
        if vm.selectedModelId == AUTO_MODEL_ID { return "Auto" }
        if vm.selectedModelId == TEAMUP_MODEL_ID { return "Team Up" }
        if let model = vm.remoteModels.first(where: { $0.modelId == vm.selectedModelId }) {
            return ModelBrand.displayLabel(model.displayName)
        }
        return "Auto"
    }

    @ViewBuilder
    private var trailingAction: some View {
        if vm.isStreamingCurrent {
            Button { vm.stop() } label: {
                Image(systemName: "square.fill")
                    .font(.system(size: 14))
                    .foregroundColor(.white)
                    .frame(width: 36, height: 36)
                    .background(FridayColor.stop)
                    .clipShape(Circle())
            }
        } else if !vm.draft.trimmingCharacters(in: .whitespaces).isEmpty || !vm.pendingAttachments.isEmpty {
            Button { vm.send() } label: {
                Image(systemName: "arrow.up")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundColor(FridayColor.bg)
                    .frame(width: 36, height: 36)
                    .background(FridayColor.text)
                    .clipShape(Circle())
            }
        } else {
            Button { recorder.start() } label: {
                Image(systemName: "mic.fill")
                    .font(.system(size: 15))
                    .foregroundColor(FridayColor.text)
                    .frame(width: 36, height: 36)
                    .background(FridayColor.surface)
                    .clipShape(Circle())
            }
        }
    }

    private var recordingRow: some View {
        HStack(spacing: 14) {
            Button { recorder.cancel() } label: {
                Image(systemName: "xmark").foregroundColor(FridayColor.muted).frame(width: 32, height: 32).background(FridayColor.surface).clipShape(Circle())
            }
            Circle().fill(FridayColor.error).frame(width: 8, height: 8).opacity(0.9)
            Text(timeString(recorder.elapsed)).font(.system(size: 13, design: .monospaced)).foregroundColor(FridayColor.muted)
            WaveformBars(level: recorder.level)
            Button {
                guard let url = recorder.stop() else { return }
                Task { await transcribeAndFill(url) }
            } label: {
                Image(systemName: "checkmark").foregroundColor(.white).frame(width: 36, height: 36).background(FridayColor.success).clipShape(Circle())
            }
        }
    }

    private func timeString(_ t: TimeInterval) -> String {
        let m = Int(t) / 60, s = Int(t) % 60
        return String(format: "%02d:%02d", m, s)
    }

    private func transcribeAndFill(_ url: URL) async {
        guard let data = try? Data(contentsOf: url) else { return }
        if let text = try? await VoiceApi.transcribe(audioData: data, containerMime: "audio/mp4", filename: "voice.m4a") {
            await MainActor.run { vm.draft = text }
        }
    }

}

private struct ModeChip: View {
    let icon: String
    let label: String
    let color: Color
    let active: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 4) {
                Image(systemName: icon)
                    .font(.system(size: 14))
                    .rotationEffect(.degrees(active ? 360 : 0))
                    .scaleEffect(active ? 1.1 : 1)
                if active { Text(label).font(.system(size: 12, weight: .medium)).transition(.opacity.combined(with: .scale(scale: 0.8))) }
            }
            .foregroundColor(active ? color : FridayColor.muted)
            .padding(.horizontal, active ? 10 : 6)
            .frame(height: 32)
            .background(active ? color.opacity(0.12) : Color.clear)
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(active ? color.opacity(0.4) : .clear, lineWidth: 1))
            .cornerRadius(16)
        }
        .animation(.spring(response: 0.5, dampingFraction: 0.55), value: active)
    }
}

private struct AttachmentChip: View {
    let attachment: PendingAttachment
    let onRemove: () -> Void

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: attachment.kind == "image" ? "photo" : "doc")
                .font(.system(size: 12))
            Text(attachment.name).font(.system(size: 12)).lineLimit(1).frame(maxWidth: 120)
            Button(action: onRemove) {
                Image(systemName: "xmark.circle.fill").font(.system(size: 13)).foregroundColor(FridayColor.muted)
            }
        }
        .foregroundColor(FridayColor.text)
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(FridayColor.search.opacity(0.5))
        .cornerRadius(12)
    }
}

private struct WaveformBars: View {
    let level: CGFloat
    @State private var phases: [CGFloat] = (0..<28).map { _ in CGFloat.random(in: 0.2...1) }

    var body: some View {
        HStack(spacing: 2) {
            ForEach(0..<28, id: \.self) { i in
                RoundedRectangle(cornerRadius: 1)
                    .fill(FridayColor.error.opacity(0.7))
                    .frame(width: 2, height: 4 + 18 * min(1, level * phases[i % phases.count] + 0.15))
            }
        }
        .frame(height: 24)
        .onReceive(Timer.publish(every: 0.15, on: .main, in: .common).autoconnect()) { _ in
            phases = phases.map { _ in CGFloat.random(in: 0.2...1) }
        }
    }
}
