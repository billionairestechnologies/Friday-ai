import SwiftUI

struct ChatThreadView: View {
    let messages: [ChatMessage]

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    ForEach(messages) { message in
                        MessageRow(message: message).id(message.id)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
            }
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: messages.count) { _ in
                scrollToBottom(proxy)
            }
            .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardDidShowNotification)) { _ in
                scrollToBottom(proxy)
            }
            .onChange(of: messages.last?.content) { _ in
                // Only auto-follow token streaming if the user hasn't scrolled away —
                // ScrollViewReader has no scroll-position introspection, so we
                // approximate by always following the last message while it streams.
                if messages.last?.isStreaming == true {
                    scrollToBottom(proxy, animated: false)
                }
            }
        }
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy, animated: Bool = true) {
        guard let last = messages.last else { return }
        if animated {
            withAnimation(.easeOut(duration: 0.25)) { proxy.scrollTo(last.id, anchor: .bottom) }
        } else {
            proxy.scrollTo(last.id, anchor: .bottom)
        }
    }
}

private struct MessageRow: View {
    @EnvironmentObject var vm: FridayViewModel
    let message: ChatMessage
    @State private var copied = false
    @State private var confirmRestore = false

    private var restorable: Bool {
        guard vm.workspace == "build", let id = vm.currentId, !(vm.currentChat?.messages.contains { $0.isStreaming } ?? false) else { return false }
        return vm.checkpoints[id]?.contains(message.id) == true
    }

    private var isPlanRound: Bool {
        message.build?.plan?.status != nil && message.content.hasPrefix(planMarker)
    }

    var body: some View {
        if message.role == .user {
            VStack(alignment: .trailing, spacing: 4) {
            HStack {
                Spacer(minLength: 40)
                Text(message.content)
                    .font(FridayType.body())
                    .foregroundColor(FridayColor.text)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(FridayColor.surface)
                    .cornerRadius(FridayRadius.bubble)
                    .frame(maxWidth: 320, alignment: .trailing)
            }
                if restorable {
                    Button { confirmRestore = true } label: {
                        Label("Restore to before this", systemImage: "arrow.counterclockwise")
                            .font(.system(size: 12)).foregroundColor(FridayColor.muted)
                    }
                    .alert("Restore to before this message?", isPresented: $confirmRestore) {
                        Button("Cancel", role: .cancel) {}
                        Button("Restore", role: .destructive) { Task { await vm.restore(to: message.id) } }
                    } message: {
                        Text("The project files go back to how they were before this message, and this message and everything after it are removed.")
                    }
                }
                if let err = vm.restoreError, restorable {
                    Text(err).font(.system(size: 12)).foregroundColor(FridayColor.error)
                }
            }
            .frame(maxWidth: .infinity, alignment: .trailing)
        } else {
            VStack(alignment: .leading, spacing: 8) {
                if message.isStreaming, let build = message.build, build.steps.isEmpty, build.plan == nil {
                    BuildBanner()
                }
                // Tool-only turns (web search, page reads…) that already show the Search/Think trail below skip the Build-style tool rows.
                if let build = message.build, !build.steps.isEmpty || build.plan != nil,
                   !(!message.modesUsed.isEmpty && build.plan == nil && build.steps.allSatisfy { $0.kind == "tool" || $0.kind == "agent" }) {
                    BuildStepsCard(build: build, streaming: message.isStreaming)
                }
                if !message.agents.isEmpty {
                    AgentsRow(message: message)
                } else if !message.modesUsed.isEmpty {
                    ThoughtCard(message: message)
                } else if message.isStreaming && message.content.isEmpty {
                    if message.status == "generating_image" {
                        ImageGeneratingView()
                    } else {
                        ThinkingPill(modes: message.modesUsed)
                    }
                }

                // A plan-round message stores the marker + the plan as text (so the model sees it later);
                // the plan card already shows all of it, so the text isn't repeated under it.
                if !message.content.isEmpty && !isPlanRound {
                    MarkdownBody(text: message.content)
                        .transition(.opacity)
                }

                if !message.isStreaming, let prompt = message.suggestBuildPrompt {
                    SuggestBuildCard(prompt: prompt)
                }

                if let ask = message.build?.ask, !ask.isEmpty {
                    BuildAskCard(questions: ask)
                }

                if !message.isStreaming, let build = message.build, build.zipBytes != nil, let conversationId = vm.currentId {
                    ProjectZipCard(build: build, conversationId: conversationId)
                }

                if !message.content.isEmpty && !message.isStreaming && !isPlanRound {
                    HStack(spacing: 4) {
                        Button {
                            UIPasteboard.general.string = message.content
                            copied = true
                            DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { copied = false }
                        } label: {
                            Image(systemName: copied ? "checkmark" : "doc.on.doc")
                                .font(.system(size: 13))
                                .foregroundColor(FridayColor.muted)
                                .frame(width: 32, height: 32)
                                .background(FridayColor.surface)
                                .clipShape(Circle())
                        }
                        Button {
                            ShareSheet.saveText(message.content, filename: "friday-reply.md")
                        } label: {
                            Image(systemName: "arrow.down.to.line")
                                .font(.system(size: 13))
                                .foregroundColor(FridayColor.muted)
                                .frame(width: 32, height: 32)
                                .background(FridayColor.surface)
                                .clipShape(Circle())
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

struct ThinkingPill: View {
    let modes: Set<Mode>

    var body: some View {
        HStack(spacing: 8) {
            BouncingDots(color: FridayColor.think)
            RotatingPhrase(pool: ThinkingLines.activePool(for: modes), interval: 2.6, font: FridayType.bodyMedium(), color: FridayColor.muted)
        }
    }
}
