import SwiftUI

/// "What's new": product updates from the Team Console, one at a time. Each version is claimed by
/// the server right before it shows, so it shows once per person across web, Android and iOS.
/// Mounted as an overlay in FridayAppApp.swift, never on top of the consent gate.
struct WhatsNewCard: View {
    @EnvironmentObject var vm: FridayViewModel

    var body: some View {
        if let item = vm.announcements.first {
            PopupCard(
                label: label(item.kind),
                labelColor: Color(red: 0.49, green: 0.23, blue: 0.93),
                title: item.title,
                markdown: item.body,
                ctaLabel: item.ctaLabel,
                ctaUrl: item.ctaUrl.flatMap(URL.init(string:)),
                onCta: { Task { await vm.finishAnnouncement("clicked") } },
                onDone: { Task { await vm.finishAnnouncement("acknowledged") } },
                onDismiss: { Task { await vm.finishAnnouncement("dismissed") } }
            )
        }
    }

    private func label(_ kind: String) -> String {
        switch kind {
        case "improvement": return "IMPROVED"
        case "news": return "NEWS"
        case "maintenance": return "HEADS UP"
        default: return "NEW"
        }
    }
}

/// A benefit granted to this person (bonus credits, a programme approval) — shown once, after What's New.
struct BenefitCard: View {
    @EnvironmentObject var vm: FridayViewModel
    let item: UserNotification

    var body: some View {
        PopupCard(
            label: "FOR YOU",
            labelColor: Color(red: 0.02, green: 0.59, blue: 0.41),
            title: item.title,
            markdown: item.body,
            ctaLabel: nil,
            ctaUrl: nil,
            onCta: {},
            onDone: { Task { await vm.acknowledgeBenefit() } },
            onDismiss: { Task { await vm.acknowledgeBenefit() } }
        )
    }
}

private struct PopupCard: View {
    let label: String
    let labelColor: Color
    let title: String
    let markdown: String
    let ctaLabel: String?
    let ctaUrl: URL?
    let onCta: () -> Void
    let onDone: () -> Void
    let onDismiss: () -> Void

    var body: some View {
        ZStack {
            Color.black.opacity(0.5).ignoresSafeArea()
                .onTapGesture(perform: onDismiss)
            VStack(alignment: .leading, spacing: 14) {
                Text(label)
                    .font(.system(size: 11, weight: .bold))
                    .foregroundColor(labelColor)
                Text(title)
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundColor(FridayColor.text)
                    .fixedSize(horizontal: false, vertical: true)
                ScrollView {
                    MarkdownBody(text: markdown)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 260)
                HStack(spacing: 10) {
                    if let ctaLabel, let ctaUrl {
                        Button {
                            onCta()
                            UIApplication.shared.open(ctaUrl)
                        } label: {
                            Text(ctaLabel)
                                .font(.system(size: 15, weight: .semibold))
                                .frame(maxWidth: .infinity).frame(height: 46)
                                .foregroundColor(FridayColor.bg)
                                .background(FridayColor.text)
                                .cornerRadius(23)
                        }
                    }
                    Button(action: onDone) {
                        Text("Got it")
                            .font(.system(size: 15, weight: .semibold))
                            .frame(maxWidth: .infinity).frame(height: 46)
                            .foregroundColor(FridayColor.text)
                            .overlay(RoundedRectangle(cornerRadius: 23).stroke(FridayColor.muted.opacity(0.35)))
                    }
                }
            }
            .padding(20)
            .background(FridayColor.surface)
            .cornerRadius(24)
            .padding(24)
        }
    }
}
