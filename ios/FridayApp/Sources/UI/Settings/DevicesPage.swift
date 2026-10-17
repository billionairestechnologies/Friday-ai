import SwiftUI

/// Settings → Devices: everywhere this account is signed in, same list as the web (supabase 0068).
struct DevicesPage: View {
    @State private var sessions: [DeviceSession]?
    @State private var failed = false
    @State private var busy: String?
    @State private var notice: String?
    @State private var confirmOthers = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Where your account is signed in. If you don't recognise one, sign it out — it stops working straight away.")
                .font(.system(size: 13)).foregroundColor(FridayColor.muted)
            if let sessions {
                if failed {
                    Text("Couldn't load your devices — check your connection.").font(.system(size: 13)).foregroundColor(FridayColor.muted)
                } else {
                    VStack(spacing: 0) {
                        ForEach(Array(sessions.enumerated()), id: \.element.id) { i, s in
                            row(s)
                            if i < sessions.count - 1 { Divider().padding(.leading, 14) }
                        }
                    }
                    .overlay(RoundedRectangle(cornerRadius: 14).stroke(FridayColor.muted.opacity(0.2)))
                    if sessions.contains(where: { !$0.current }) {
                        Button { confirmOthers = true } label: {
                            Text("Sign out everywhere else").font(.system(size: 14, weight: .medium)).foregroundColor(.red)
                                .padding(.horizontal, 16).padding(.vertical, 9)
                                .overlay(Capsule().stroke(FridayColor.muted.opacity(0.3)))
                        }
                        .disabled(busy != nil)
                    }
                    if let notice { Text(notice).font(.system(size: 12)).foregroundColor(FridayColor.muted) }
                }
            } else {
                ProgressView().frame(maxWidth: .infinity).padding(20)
            }
        }
        .task { await load() }
        .confirmationDialog("Sign out everywhere else?", isPresented: $confirmOthers, titleVisibility: .visible) {
            Button("Sign out", role: .destructive) {
                Task {
                    busy = "others"
                    let n = await SessionsApi.signOutOthers()
                    switch n {
                    case nil: notice = "Couldn't sign the other devices out — try again."
                    case 0: notice = "No other devices were signed in."
                    case 1: notice = "Signed out 1 other device."
                    default: notice = "Signed out \(n!) other devices."
                    }
                    await load()
                    busy = nil
                }
            }
        } message: {
            Text("Every other browser, phone and FridayX sign-in will need to sign in again.")
        }
    }

    private func load() async {
        let r = await SessionsApi.list()
        failed = r == nil
        sessions = r ?? []
    }

    private func row(_ s: DeviceSession) -> some View {
        HStack(spacing: 12) {
            Image(systemName: s.platform == "cli" ? "terminal" : (s.platform == "android" || s.platform == "ios") ? "iphone" : "laptopcomputer")
                .foregroundColor(FridayColor.muted).frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(s.client + (s.current ? "  · This device" : "")).font(.system(size: 14.5, weight: .medium)).foregroundColor(FridayColor.text)
                Text([s.current ? "Active now" : lastActive(s.lastSeenAt), s.ipPrefix, signedIn(s.createdAt)].compactMap { $0 }.joined(separator: " · "))
                    .font(.system(size: 12)).foregroundColor(FridayColor.muted)
            }
            Spacer(minLength: 0)
            if !s.current {
                Button {
                    Task {
                        busy = s.id
                        if await SessionsApi.signOut(s) { sessions?.removeAll { $0.id == s.id } } else { notice = "Couldn't sign that device out — try again." }
                        busy = nil
                    }
                } label: {
                    Text(busy == s.id ? "…" : "Sign out").font(.system(size: 12.5, weight: .medium)).foregroundColor(FridayColor.text)
                        .padding(.horizontal, 12).padding(.vertical, 6).background(FridayColor.surface).clipShape(Capsule())
                }
                .disabled(busy != nil)
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 12)
    }

    private func date(_ iso: String?) -> Date? {
        guard let iso else { return nil }
        let p = ISO8601DateFormatter()
        p.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return p.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
    }

    private func lastActive(_ iso: String?) -> String {
        guard let at = date(iso) else { return "Not used yet" }
        let mins = Int(Date().timeIntervalSince(at) / 60)
        if mins < 2 { return "Active now" }
        if mins < 60 { return "Active \(mins) min ago" }
        if mins < 24 * 60 { return "Active \(mins / 60) h ago" }
        let f = DateFormatter(); f.dateFormat = "d MMM"
        return "Active " + f.string(from: at)
    }

    private func signedIn(_ iso: String) -> String? {
        guard let at = date(iso) else { return nil }
        let f = DateFormatter(); f.dateFormat = "d MMM yyyy"
        return "signed in " + f.string(from: at)
    }
}
