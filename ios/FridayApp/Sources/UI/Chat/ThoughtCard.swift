import SwiftUI

/// Collapsible reasoning trail — matches web's chain-of-thought-live.tsx /
/// android's ThoughtCard.
struct ThoughtCard: View {
    let message: ChatMessage
    @State private var expanded: Bool

    init(message: ChatMessage) {
        self.message = message
        // Search results collapse by default when done; plain thinking stays open.
        _expanded = State(initialValue: !(message.isStreaming == false && !message.sources.isEmpty))
    }

    private var headerLabel: String {
        let finished = !message.isStreaming
        if finished && !message.sources.isEmpty { return "Searched \(message.sources.count) source(s)" }
        if finished { return "Thought" }
        let writingCode = message.content.contains("```") && !message.content.hasSuffix("```")
        if writingCode { return "Writing" }
        if message.status == "searching" || (message.modesUsed.contains(.search) && message.status == nil) { return "Searching" }
        return "Thinking"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.easeInOut(duration: 0.3)) { expanded.toggle() }
            } label: {
                HStack(spacing: 8) {
                    if message.isStreaming {
                        ProgressView().tint(FridayColor.think).scaleEffect(0.7)
                    } else {
                        Image(systemName: "checkmark.circle.fill").foregroundColor(FridayColor.success)
                    }
                    Text(headerLabel)
                        .font(FridayType.labelMedium())
                        .foregroundColor(FridayColor.text)
                    Spacer()
                    Image(systemName: "chevron.down")
                        .rotationEffect(.degrees(expanded ? 180 : 0))
                        .foregroundColor(FridayColor.muted)
                        .font(.system(size: 12))
                }
            }
            .buttonStyle(.plain)

            if expanded {
                VStack(alignment: .leading, spacing: 10) {
                    stepRow(title: "Understanding the question", caption: "Read the prompt and any attachments")

                    if !message.reasoning.isEmpty {
                        Text(message.reasoning)
                            .font(.system(size: 13.5))
                            .foregroundColor(FridayColor.muted)
                    }

                    if !message.sources.isEmpty {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Found \(message.sources.count) source(s)")
                                .font(FridayType.bodyMedium())
                                .foregroundColor(FridayColor.text)
                            FlowLayout(spacing: 6) {
                                ForEach(message.sources) { source in
                                    Link(destination: URL(string: source.url) ?? URL(string: "https://friday.billionairestechnologies.com")!) {
                                        Text(source.title ?? source.url)
                                            .font(.system(size: 12))
                                            .underline()
                                            .foregroundColor(FridayColor.search)
                                    }
                                }
                            }
                        }
                    }

                    if message.isStreaming {
                        RotatingPhrase(pool: ThinkingLines.activePool(for: message.modesUsed), interval: 2.6, font: .system(size: 13, weight: .semibold), color: FridayColor.text)
                        HStack(spacing: 6) {
                            BouncingDots(color: FridayColor.think)
                            RotatingPhrase(pool: ThinkingLines.pillPool(for: message.modesUsed), interval: 2.6, font: .system(size: 12).italic(), color: FridayColor.muted)
                        }
                        .padding(.horizontal, 8)
                        .padding(.vertical, 5)
                        .background(FridayColor.muted.opacity(0.1))
                        .cornerRadius(10)
                    }
                }
                .padding(.top, 10)
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .padding(12)
        .background(FridayColor.surface.opacity(0.5))
        .cornerRadius(14)
    }

    private func stepRow(title: String, caption: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(FridayType.bodyMedium()).foregroundColor(FridayColor.text)
            Text(caption).font(.system(size: 12)).foregroundColor(FridayColor.muted)
        }
    }
}

/// Team Up multi-model card.
struct AgentsRow: View {
    let message: ChatMessage
    @State private var expanded = true

    var body: some View {
        let finished = !message.isStreaming
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.easeInOut(duration: 0.3)) { expanded.toggle() }
            } label: {
                HStack(spacing: 8) {
                    if !finished {
                        ProgressView().tint(FridayColor.think).scaleEffect(0.7)
                    } else {
                        Image(systemName: "checkmark.circle.fill").foregroundColor(FridayColor.success)
                    }
                    Text(finished ? "Team of \(message.agents.count) consulted" : "Consulting the team")
                        .font(FridayType.labelMedium())
                        .foregroundColor(FridayColor.text)
                    Spacer()
                    Image(systemName: "chevron.down").rotationEffect(.degrees(expanded ? 180 : 0)).foregroundColor(FridayColor.muted).font(.system(size: 12))
                }
            }.buttonStyle(.plain)

            if expanded {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Understanding the question").font(FridayType.bodyMedium()).foregroundColor(FridayColor.text)
                    ForEach(message.agents) { agent in
                        HStack(spacing: 8) {
                            if agent.state == "start" {
                                ProgressView().scaleEffect(0.6)
                            } else if agent.state == "error" {
                                Image(systemName: "xmark.circle.fill").foregroundColor(FridayColor.error)
                            } else {
                                Image(systemName: "checkmark.circle.fill").foregroundColor(FridayColor.success)
                            }
                            VStack(alignment: .leading, spacing: 1) {
                                Text(agent.model)
                                    .font(.system(size: 13))
                                    .foregroundColor(agent.state == "error" ? FridayColor.error : FridayColor.text)
                                if let err = agent.error {
                                    Text(err).font(.system(size: 11)).foregroundColor(FridayColor.error)
                                }
                            }
                        }
                    }
                    if message.agents.count > 1 {
                        HStack(spacing: 8) {
                            if message.status == "synthesizing" { ProgressView().scaleEffect(0.6) }
                            Text(message.status == "synthesizing" ? "Synthesizing the final answer" : "Synthesized the final answer")
                                .font(FridayType.bodyMedium())
                                .foregroundColor(FridayColor.text)
                        }
                    }
                }
                .padding(.top, 10)
            }
        }
        .padding(12)
        .background(FridayColor.surface.opacity(0.5))
        .cornerRadius(14)
    }
}

struct BouncingDots: View {
    let color: Color
    @State private var bounce = false

    var body: some View {
        HStack(spacing: 3) {
            ForEach(0..<3, id: \.self) { i in
                Circle()
                    .fill(color)
                    .frame(width: 5, height: 5)
                    .offset(y: bounce ? -5 : 0)
                    .animation(.easeInOut(duration: 0.42).repeatForever().delay(Double(i) * 0.12), value: bounce)
            }
        }
        .onAppear { bounce = true }
    }
}

/// Minimal flow layout for wrapped source-link chips.
struct FlowLayout: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x + size.width > width, x > 0 {
                x = 0
                y += rowHeight + spacing
                rowHeight = 0
            }
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
        return CGSize(width: width, height: y + rowHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, rowHeight: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x + size.width > bounds.maxX, x > bounds.minX {
                x = bounds.minX
                y += rowHeight + spacing
                rowHeight = 0
            }
            subview.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
    }
}
