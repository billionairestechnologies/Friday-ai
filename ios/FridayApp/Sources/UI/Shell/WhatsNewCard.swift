import SwiftUI

/// "What's new": product updates from the Team Console, shown once per account across web, Android
/// and iOS. Mounted as an overlay in FridayAppApp.swift, never on top of the consent gate.
struct WhatsNewCard: View {
    @EnvironmentObject var vm: FridayViewModel
    @State private var index = 0

    var body: some View {
        let items = vm.announcements
        let item = items[min(index, items.count - 1)]
        let last = index >= items.count - 1
        ZStack {
            Color.black.opacity(0.5).ignoresSafeArea()
                .onTapGesture { Task { await vm.dismissAnnouncements() } }
            VStack(alignment: .leading, spacing: 14) {
                Text(label(item.kind))
                    .font(.system(size: 11, weight: .bold))
                    .foregroundColor(Color(red: 0.49, green: 0.23, blue: 0.93))
                Text(item.title)
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundColor(FridayColor.text)
                    .fixedSize(horizontal: false, vertical: true)
                ScrollView {
                    MarkdownBody(text: item.body)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 260)
                if items.count > 1 {
                    Text("\(index + 1) of \(items.count)")
                        .font(.system(size: 12))
                        .foregroundColor(FridayColor.muted)
                }
                HStack(spacing: 10) {
                    if let label = item.ctaLabel, let raw = item.ctaUrl, let url = URL(string: raw) {
                        Button {
                            Task { await vm.dismissAnnouncements(clickedId: item.id) }
                            UIApplication.shared.open(url)
                        } label: {
                            Text(label)
                                .font(.system(size: 15, weight: .semibold))
                                .frame(maxWidth: .infinity).frame(height: 46)
                                .foregroundColor(FridayColor.bg)
                                .background(FridayColor.text)
                                .cornerRadius(23)
                        }
                    }
                    Button {
                        if last { Task { await vm.dismissAnnouncements() } } else { index += 1 }
                    } label: {
                        Text(last ? "Got it" : "Next")
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

    private func label(_ kind: String) -> String {
        switch kind {
        case "improvement": return "IMPROVED"
        case "news": return "NEWS"
        case "maintenance": return "HEADS UP"
        default: return "NEW"
        }
    }
}
