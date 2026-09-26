import SwiftUI

/// Read-only summary of Build Mode's clarifying questions inside the chat thread.
struct BuildAskCard: View {
    let questions: [BuildAskQuestion]
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "questionmark.bubble").font(.system(size: 13))
                Text("Questions").font(.system(size: 14, weight: .semibold))
            }.foregroundColor(FridayColor.text)
            ForEach(Array(questions.enumerated()), id: \.element.id) { i, q in
                VStack(alignment: .leading, spacing: 2) {
                    Text("\(i + 1). \(q.question)").font(.system(size: 13.5)).foregroundColor(FridayColor.text)
                    if !q.options.isEmpty {
                        Text(q.options.map { $0.label }.joined(separator: " · "))
                            .font(.system(size: 12)).foregroundColor(FridayColor.muted)
                    }
                }
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(FridayColor.surface)
        .cornerRadius(16)
    }
}

/// Panel above the composer: one question at a time, recommended option first, "Other" free text.
struct BuildAskPanel: View {
    @EnvironmentObject var vm: FridayViewModel
    let messageId: String
    let questions: [BuildAskQuestion]

    @State private var index = 0
    @State private var choices: [String: String] = [:]   // question id -> option label
    @State private var other: [String: String] = [:]     // question id -> free text
    @State private var showError = false
    private let otherKey = "\u{0}other"

    private var q: BuildAskQuestion { questions[min(index, questions.count - 1)] }
    private var isLast: Bool { index >= questions.count - 1 }

    private func answer(_ id: String) -> String? {
        guard let c = choices[id] else { return nil }
        if c == otherKey {
            let t = (other[id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            return t.isEmpty ? nil : t
        }
        return c
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("\(index + 1) of \(questions.count)").font(.system(size: 12, weight: .medium)).foregroundColor(FridayColor.muted)
                Spacer()
                Button {
                    withAnimation { _ = vm.dismissedAskIds.insert(messageId) }
                } label: {
                    Image(systemName: "xmark").font(.system(size: 13, weight: .semibold)).foregroundColor(FridayColor.muted)
                        .frame(width: 28, height: 28)
                }
                .accessibilityLabel("Skip questions")
            }
            Text(q.question).font(.system(size: 15, weight: .semibold)).foregroundColor(FridayColor.text)

            ScrollView {
                VStack(spacing: 6) {
                    ForEach(q.options, id: \.label) { opt in
                        optionRow(label: opt.label, desc: opt.description, badge: opt.recommended, value: opt.label)
                    }
                    optionRow(label: "Other", desc: "", badge: false, value: otherKey)
                    if choices[q.id] == otherKey {
                        TextField("Type your answer", text: Binding(get: { other[q.id] ?? "" }, set: { other[q.id] = $0 }))
                            .font(.system(size: 15)).foregroundColor(FridayColor.text)
                            .padding(10).background(FridayColor.chip).cornerRadius(10)
                    }
                }
            }
            .frame(maxHeight: 260)

            if showError {
                Text("Couldn't send your answers. Please sign in and try again.").font(.system(size: 12)).foregroundColor(FridayColor.error)
            }

            HStack {
                if index > 0 {
                    Button("Back") { withAnimation { index -= 1 } }
                        .font(.system(size: 14)).foregroundColor(FridayColor.muted)
                }
                Spacer()
                Button(isLast ? "Submit" : "Next") { advance() }
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundColor(FridayColor.bg)
                    .padding(.horizontal, 18).padding(.vertical, 8)
                    .background(FridayColor.text.opacity(answer(q.id) == nil ? 0.35 : 1))
                    .cornerRadius(18)
                    .disabled(answer(q.id) == nil)
            }
        }
        .padding(14)
        .background(FridayColor.surface)
        .cornerRadius(18)
        .onAppear {
            for qq in questions where choices[qq.id] == nil {
                if let rec = qq.options.first(where: { $0.recommended }) ?? qq.options.first { choices[qq.id] = rec.label }
            }
        }
    }

    private func optionRow(label: String, desc: String, badge: Bool, value: String) -> some View {
        let selected = choices[q.id] == value
        return Button {
            choices[q.id] = value
            showError = false
        } label: {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: selected ? "largecircle.fill.circle" : "circle")
                    .font(.system(size: 16)).foregroundColor(selected ? FridayColor.text : FridayColor.muted)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(label).font(.system(size: 14.5, weight: .medium)).foregroundColor(FridayColor.text)
                        if badge {
                            Text("Recommended").font(.system(size: 10.5, weight: .semibold)).foregroundColor(FridayColor.muted)
                                .padding(.horizontal, 6).padding(.vertical, 2).background(FridayColor.chip).cornerRadius(6)
                        }
                    }
                    if !desc.isEmpty {
                        Text(desc).font(.system(size: 12.5)).foregroundColor(FridayColor.muted).multilineTextAlignment(.leading)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(selected ? FridayColor.chip : Color.clear)
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(FridayColor.chip, lineWidth: 1))
            .cornerRadius(12)
        }
        .buttonStyle(.plain)
    }

    private func advance() {
        guard answer(q.id) != nil else { return }
        if !isLast { withAnimation { index += 1 }; return }
        var lines: [String] = []
        for qq in questions {
            guard let a = answer(qq.id) else {
                if let i = questions.firstIndex(where: { $0.id == qq.id }) { index = i }
                showError = false
                return
            }
            lines.append("- \(qq.question): \(a)")
        }
        let text = "My answers to your questions:\n" + lines.joined(separator: "\n")
        guard TokenStore.shared.hasSession() else { showError = true; vm.authRequired = true; return }
        if vm.send(text: text) != nil {
            withAnimation { _ = vm.dismissedAskIds.insert(messageId) }
        } else if vm.currentId != nil && vm.queued[vm.currentId!]?.isEmpty == false {
            withAnimation { _ = vm.dismissedAskIds.insert(messageId) }
        } else {
            showError = true
        }
    }
}
