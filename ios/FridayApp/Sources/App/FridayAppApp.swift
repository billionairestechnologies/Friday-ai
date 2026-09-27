import SwiftUI

@main
struct FridayAppApp: App {
    @StateObject private var vm = FridayViewModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootShell()
                .environmentObject(vm)
                .preferredColorScheme(.light)
                .task { await vm.bootstrap() }
                .onOpenURL { url in
                    // OAuth callback: com.friday.app.ios://auth-callback#friday_session=<b64url json>
                    guard let fragment = url.fragment else { return }
                    Task { await vm.completeOAuth(fragment: fragment) }
                }
                .onChange(of: scenePhase) { phase in
                    // Picks up anything that happened while backgrounded — realtime alone can miss
                    // it (socket closed while backgrounded, or the conversation not yet known locally).
                    if phase == .active { Task { await vm.onAppForegrounded() } }
                }
        }
    }
}
