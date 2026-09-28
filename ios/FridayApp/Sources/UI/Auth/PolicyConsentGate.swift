import SwiftUI

/// Blocks the app behind a full-screen, non-dismissable "I agree" screen for any signed-in
/// account whose `FridayUser.policyVersion` doesn't match `FridayViewModel.policyVersion` —
/// every account created before this shipped (policyVersion is nil), and any account that
/// agreed to an older version after a material policy change. A brand-new signup already
/// agreed via AuthFormSheet's own checkbox, so it never sees this. Mounted once, as an overlay
/// on RootShell in FridayAppApp.swift, so it applies regardless of which screen is showing.
struct PolicyConsentGate: View {
    @EnvironmentObject var vm: FridayViewModel

    var body: some View {
        ZStack {
            Color.black.opacity(0.6).ignoresSafeArea()
            VStack(alignment: .leading, spacing: 16) {
                Text("Updated Terms & Privacy Policy")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundColor(FridayColor.text)

                Text("Before you continue, please review and agree to our Terms of Service and Privacy Policy. They cover what Friday stores, which AI providers and connectors your messages can reach, and the controls you have over your data.")
                    .font(.system(size: 14))
                    .foregroundColor(FridayColor.muted)
                    .fixedSize(horizontal: false, vertical: true)

                HStack(spacing: 16) {
                    Link("Terms of Service", destination: URL(string: "https://friday.billionairestechnologies.com/terms")!)
                    Link("Privacy Policy", destination: URL(string: "https://friday.billionairestechnologies.com/privacy")!)
                }
                .font(.system(size: 13, weight: .medium))

                if let error = vm.policyAcceptError {
                    Text(error).font(.system(size: 13)).foregroundColor(FridayColor.error)
                }

                Button {
                    Task { await vm.acceptPolicy() }
                } label: {
                    Text(vm.policyAcceptBusy ? "Saving…" : "I Agree")
                        .font(.system(size: 15, weight: .semibold))
                        .frame(maxWidth: .infinity).frame(height: 48)
                        .foregroundColor(FridayColor.bg)
                        .background(FridayColor.text.opacity(vm.policyAcceptBusy ? 0.55 : 1))
                        .cornerRadius(24)
                }
                .disabled(vm.policyAcceptBusy)
            }
            .padding(20)
            .background(FridayColor.surface)
            .cornerRadius(24)
            .padding(24)
        }
    }
}
