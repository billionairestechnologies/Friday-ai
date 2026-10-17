import SwiftUI

/// Notifications inbox (GET /notifications, supabase 0062) — the same list as the web's sidebar bell:
/// credits granted, programme decisions, and anything else sent to this person. Opening it marks
/// everything read (after a moment, so the new ones are still visible as new).
struct InboxScreen: View {
    @EnvironmentObject var vm: FridayViewModel

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 6) {
                Button { vm.page = "chat" } label: {
                    Image(systemName: "chevron.left").font(.system(size: 17, weight: .semibold)).frame(width: 40, height: 40)
                }
                .accessibilityLabel("Back")
                Text("Notifications").font(.system(size: 18, weight: .semibold))
                Spacer()
            }
            .foregroundColor(FridayColor.text)
            .padding(.horizontal, 8).padding(.vertical, 6)
            if vm.inbox.isEmpty {
                Spacer()
                Text("You're all caught up.").font(.system(size: 14)).foregroundColor(FridayColor.muted)
                Spacer()
            } else {
                ScrollView {
                    LazyVStack(spacing: 10) {
                        ForEach(vm.inbox) { n in
                            HStack(alignment: .top, spacing: 10) {
                                Circle().fill(n.read ? Color.clear : FridayColor.search).frame(width: 8, height: 8).padding(.top, 6)
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(n.title).font(.system(size: 15, weight: .medium)).foregroundColor(FridayColor.text)
                                    if !n.body.isEmpty { MarkdownBody(text: n.body) }
                                    if let d = shortDate(n.createdAt) { Text(d).font(.system(size: 12)).foregroundColor(FridayColor.muted) }
                                }
                                Spacer(minLength: 0)
                            }
                            .padding(14)
                            .background(FridayColor.surface)
                            .cornerRadius(14)
                        }
                    }
                    .padding(14)
                }
            }
        }
        .background(FridayColor.bg.ignoresSafeArea())
        .task {
            await vm.refreshInbox()
            if vm.unreadNotifications > 0 {
                try? await Task.sleep(nanoseconds: 1_500_000_000)
                await vm.openedInbox()
            }
        }
    }

    private func shortDate(_ iso: String) -> String? {
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = parser.date(from: iso) ?? ISO8601DateFormatter().date(from: iso) else { return nil }
        let f = DateFormatter()
        f.dateFormat = "d MMM, h:mm a"
        return f.string(from: date)
    }
}
