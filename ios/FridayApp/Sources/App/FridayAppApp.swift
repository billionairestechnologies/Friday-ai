import SwiftUI

@main
struct FridayAppApp: App {
    @StateObject private var vm = FridayViewModel()

    var body: some Scene {
        WindowGroup {
            RootShell()
                .environmentObject(vm)
                .task { await vm.bootstrap() }
                .onOpenURL { url in
                    // OAuth callback: com.friday.app.ios://auth-callback#friday_session=<b64url json>
                    guard let fragment = url.fragment else { return }
                    Task { await vm.completeOAuth(fragment: fragment) }
                }
        }
    }
}
