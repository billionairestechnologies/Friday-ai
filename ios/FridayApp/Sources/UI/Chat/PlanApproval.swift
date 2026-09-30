import SwiftUI

/// Above the composer while the newest message is a Build plan waiting for an answer. Nothing is
/// built until the user approves; typing in the composer instead asks for a revised plan.
struct PlanApprovalBar: View {
    @EnvironmentObject var vm: FridayViewModel

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Ready to build this plan?").font(.system(size: 15, weight: .semibold)).foregroundColor(FridayColor.text)
                Text("Nothing is built until you approve. To change it, type what you want different below.")
                    .font(.system(size: 12.5)).foregroundColor(FridayColor.muted)
            }
            HStack(spacing: 8) {
                Button { vm.composerFocusTick += 1 } label: {
                    Label("Request changes", systemImage: "pencil")
                        .font(.system(size: 13.5)).foregroundColor(FridayColor.text)
                        .padding(.horizontal, 14).padding(.vertical, 8)
                        .overlay(Capsule().stroke(FridayColor.hairline, lineWidth: 1))
                }
                Button { vm.approvePlan() } label: {
                    Label("Approve & build", systemImage: "hammer.fill")
                        .font(.system(size: 13.5, weight: .semibold)).foregroundColor(FridayColor.bg)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 8)
                        .background(FridayColor.text).clipShape(Capsule())
                }
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 12)
        .background(FridayColor.surface)
        .cornerRadius(18)
    }
}

/// Under a normal-chat reply to a build request: Build Mode lives in the Build workspace.
struct SuggestBuildCard: View {
    @EnvironmentObject var vm: FridayViewModel
    let prompt: String

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "hammer.fill").font(.system(size: 14)).foregroundColor(FridayColor.text)
                .frame(width: 34, height: 34).background(FridayColor.chip).cornerRadius(10)
            VStack(alignment: .leading, spacing: 1) {
                Text("Want Friday to actually build this?").font(.system(size: 14, weight: .medium)).foregroundColor(FridayColor.text)
                Text("Build plans it with you first, then codes, runs and previews it.").font(.system(size: 12)).foregroundColor(FridayColor.muted)
            }
            Spacer(minLength: 4)
            Button { vm.openInBuild(prompt) } label: {
                Text("Open in Build").font(.system(size: 13, weight: .semibold)).foregroundColor(FridayColor.bg)
                    .padding(.horizontal, 12).padding(.vertical, 7)
                    .background(FridayColor.text).clipShape(Capsule())
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 12)
        .background(FridayColor.surface)
        .cornerRadius(16)
    }
}

/// Above the composer while the Build agent is paused on a permission prompt. The build waits
/// server-side, so this works from any device.
struct ApprovalBar: View {
    @EnvironmentObject var vm: FridayViewModel
    let approval: BuildApproval
    @State private var busy = false
    private let amber = Color(red: 0.85, green: 0.47, blue: 0.02)

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Friday wants to").font(.system(size: 12, weight: .medium)).foregroundColor(amber)
            Text(approval.title).font(.system(size: 15, weight: .semibold)).foregroundColor(FridayColor.text)
            if let detail = approval.detail {
                Text(detail).font(.system(size: 12, design: .monospaced)).foregroundColor(FridayColor.muted).lineLimit(6)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(8).background(FridayColor.chip).cornerRadius(8)
            }
            if approval.always {
                Text("Always asks — this reaches outside the sandbox or can't be undone.").font(.system(size: 12)).foregroundColor(FridayColor.muted)
            }
            if let err = vm.approvalError { Text(err).font(.system(size: 12)).foregroundColor(FridayColor.error) }
            HStack(spacing: 8) {
                action("Deny", "deny")
                if !approval.always { action("Allow all", "allow_all") }
                Spacer()
                Button {
                    decide("allow")
                } label: {
                    Text("Allow").font(.system(size: 13.5, weight: .semibold)).foregroundColor(FridayColor.bg)
                        .padding(.horizontal, 18).padding(.vertical, 8).background(FridayColor.text).clipShape(Capsule())
                }
                .disabled(busy)
            }
            .padding(.top, 4)
        }
        .padding(.horizontal, 14).padding(.vertical, 12)
        .background(FridayColor.surface)
        .overlay(RoundedRectangle(cornerRadius: 18).stroke(amber.opacity(0.4), lineWidth: 1))
        .cornerRadius(18)
    }

    private func action(_ label: String, _ decision: String) -> some View {
        Button { decide(decision) } label: {
            Text(label).font(.system(size: 13.5)).foregroundColor(FridayColor.text)
                .padding(.horizontal, 14).padding(.vertical, 8)
                .overlay(Capsule().stroke(FridayColor.hairline, lineWidth: 1))
        }
        .disabled(busy)
    }

    private func decide(_ decision: String) {
        busy = true
        Task {
            await vm.answerApproval(decision)
            busy = false
        }
    }
}
