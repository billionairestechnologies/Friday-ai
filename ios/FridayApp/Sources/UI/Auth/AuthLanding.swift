import SwiftUI
import AuthenticationServices

struct AuthLanding: View {
    @EnvironmentObject var vm: FridayViewModel
    @Environment(\.dismiss) var dismiss
    @State private var phraseIndex = 0
    @State private var typed = ""
    @State private var appeared = false

    private let phrases = ["Friday AI", "Let's chat", "Let's invent", "Let's code", "Let's discover"]

    var body: some View {
        ZStack(alignment: .bottom) {
            FridayColor.bg.ignoresSafeArea()

            VStack {
                HStack {
                    Spacer()
                    Button { dismiss() } label: {
                        Image(systemName: "xmark").foregroundColor(FridayColor.text).frame(width: 36, height: 36).background(FridayColor.surface).clipShape(Circle())
                    }
                }
                .padding(.top, 8)
                .padding(.horizontal, 16)

                Spacer()
                HStack(spacing: 4) {
                    Text(typed).font(.system(size: 28, weight: .bold)).foregroundColor(FridayColor.text)
                    Circle().fill(FridayColor.text).frame(width: 22, height: 22)
                }
                Spacer()
            }

            VStack(spacing: 12) {
                pillButton("Continue with GitHub", bg: .white, fg: .black, icon: AnyView(GitHubLogo(size: 20))) {
                    Task { await OAuthLauncher.start(.github, vm: vm) }
                }
                pillButton("Continue with Google", bg: FridayColor.landingPill, fg: .white, icon: AnyView(GoogleLogo(size: 20))) {
                    Task { await OAuthLauncher.start(.google, vm: vm) }
                }
                pillButton("Log in or sign up", bg: FridayColor.landingPill, fg: .white, icon: nil) {
                    vm.authRequired = false
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { vm.startAuth(signup: false) }
                }
                if let error = vm.authError {
                    Text(error).font(.system(size: 12)).foregroundColor(FridayColor.error)
                }
            }
            .padding(20)
            .padding(.bottom, 12)
            .background(
                RoundedCorner(radius: 40, corners: [.topLeft, .topRight])
                    .fill(FridayColor.landingCard)
                    .ignoresSafeArea(edges: .bottom)
            )
        }
        .offset(y: appeared ? 0 : 24)
        .opacity(appeared ? 1 : 0)
        .onAppear {
            withAnimation(.easeOut(duration: Motion.reduced ? 0 : 0.42)) { appeared = true }
            cycle()
        }
    }

    private func pillButton(_ title: String, bg: Color, fg: Color, icon: AnyView?, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack {
                if let icon { icon }
                Text(title).font(.system(size: 15, weight: .medium))
            }
            .frame(maxWidth: .infinity)
            .frame(height: 52)
            .foregroundColor(fg)
            .background(bg)
            .cornerRadius(26)
        }
    }

    private func cycle() {
        let phrase = phrases[phraseIndex % phrases.count]
        typeOut(phrase, index: 0) {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
                deleteOut(index: phrase.count) {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
                        phraseIndex += 1
                        cycle()
                    }
                }
            }
        }
    }

    private func typeOut(_ phrase: String, index: Int, completion: @escaping () -> Void) {
        guard index <= phrase.count else { completion(); return }
        typed = String(phrase.prefix(index))
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.065) { typeOut(phrase, index: index + 1, completion: completion) }
    }

    private func deleteOut(index: Int, completion: @escaping () -> Void) {
        guard index >= 0 else { completion(); return }
        typed = String(typed.prefix(index))
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.03) { deleteOut(index: index - 1, completion: completion) }
    }
}

final class OAuthPresentationContext: NSObject, ASWebAuthenticationPresentationContextProviding {
    static let shared = OAuthPresentationContext()
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first?.keyWindow ?? ASPresentationAnchor()
    }
}

struct RoundedCorner: Shape {
    var radius: CGFloat = 12
    var corners: UIRectCorner = .allCorners

    func path(in rect: CGRect) -> Path {
        Path(UIBezierPath(roundedRect: rect, byRoundingCorners: corners, cornerRadii: CGSize(width: radius, height: radius)).cgPath)
    }
}
