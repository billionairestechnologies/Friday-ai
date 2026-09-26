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

    var body: some View {
        if message.role == .user {
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
        } else {
            VStack(alignment: .leading, spacing: 8) {
                if message.isStreaming, let build = message.build, build.steps.isEmpty, build.plan == nil {
                    BuildBanner()
                }
                if let build = message.build, !build.steps.isEmpty || build.plan != nil {
                    BuildStepsCard(build: build, streaming: message.isStreaming)
                }
                if !message.agents.isEmpty {
                    AgentsRow(message: message)
                } else if !message.modesUsed.isEmpty {
                    ThoughtCard(message: message)
                } else if message.isStreaming && message.content.isEmpty {
                    ThinkingPill(modes: message.modesUsed)
                }

                if !message.content.isEmpty {
                    MarkdownBody(text: message.content)
                        .transition(.opacity)
                }

                if let ask = message.build?.ask, !ask.isEmpty {
                    BuildAskCard(questions: ask)
                }

                if !message.isStreaming, let build = message.build, build.zipBytes != nil, let conversationId = vm.currentId {
                    ProjectZipCard(build: build, conversationId: conversationId)
                }

                if !message.content.isEmpty && !message.isStreaming {
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
